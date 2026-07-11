/**
 * Festival brain entry point.
 *
 * Pipeline:
 *   Step 0: classifyIntent (fast regex).
 *   Step 1: matchFaq pattern match. If hit AND intent confidence >= 0.55 => canonical answer, no LLM.
 *   Step 2: confidence < 0.6 => escalate to human, return holding message.
 *   Step 3: LLM call with tightened system prompt + FAQ grounding.
 *   Step 4: post-process (strip em-dashes, strip forbidden self-refs, append Zanii sign-off
 *           only on first-contact OR sign-off OR identity-question).
 *
 * Sign-off rule: track first-contact via wa_messages last-24h direction=out count == 0.
 *   First contact => append signature.
 *   Identity question (intent maps via isIdentityQuestion()) => append signature.
 *   Explicit sign-off context (caller passes signOff:true) => append signature.
 *   Otherwise => no signature.
 */

import Anthropic from '@anthropic-ai/sdk'
import { classifyIntent, intentFaqKeys, Intent, IntentResult } from './festival-brain/intents'
import { matchFaq, buildGroundingContext, FaqEntry } from './festival-brain/faq'
import {
  buildSystemPrompt,
  stripEmDashes,
  stripForbiddenSelfRefs,
  ZANII_FIRST_CONTACT_SIGNOFF,
  ZANII_IDENTITY_LINE,
} from './festival-brain/system-prompt'
import { createAdminClient } from './supabase/admin'

export interface BrainContext {
  /** WhatsApp wa_id / phone for the inbound sender. Used to look up wa_messages. */
  waId?: string
  /** If caller already knows this is a first-contact, pass true to skip the lookup. */
  forceFirstContact?: boolean
  /** If caller wants the sign-off appended (e.g. final goodbye). */
  signOff?: boolean
  /** Recent conversation turns to give the LLM context. Newest last. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * Optional extra system context appended to the LLM step only.
   * Used for per-caller personalisation (vendor name, ticket count, etc.).
   * Never overrides the hard identity / style / sign-off rules.
   */
  extraSystem?: string
  /**
   * Which surface is asking. 'vendor' = inside the exhibitor portal (may answer
   * vendor-platform questions fully). 'public' (default) = public site /
   * WhatsApp (must NOT give operational portal answers). See buildSystemPrompt.
   */
  surface?: 'public' | 'vendor'
}

export interface BrainResult {
  message: string
  /** Why we answered the way we did. Logged, not user-visible. */
  trace: {
    intent: IntentResult
    matchedFaq: string | null
    pathTaken: 'faq' | 'escalate' | 'llm' | 'identity'
    isFirstContact: boolean
    needsHuman: boolean
    signoffAppended: boolean
  }
  /** Caller should record this for follow-up. */
  needsHuman: boolean
}

const HOLDING_MESSAGE =
  "Let me get Samreen on this, she will reply within a few hours."

// Vendor-operational FAQ keys that must NOT serve on the PUBLIC surface, at
// EITHER layer: not as a canonical short-circuit answer, and not as LLM
// grounding. These carry stall prices / operational portal detail that belongs
// only inside the exhibitor portal (Taona's scope rule + PUBLIC_VENDOR_SCOPE).
// 'vendor_apply' is deliberately NOT here: telling people HOW to apply is
// allowed publicly. (KT #323 — a public-vs-vendor wall must hold at the
// grounding layer too, not just the short-circuit; loosening Step 2 exposed
// that the grounding still leaked stall_sizes prices through the LLM.)
const VENDOR_ONLY_FAQ = new Set<string>(['halaal_cert', 'stall_sizes', 'electricity'])

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null

/**
 * Detect questions about identity: "who are you", "are you a bot", etc.
 */
function isIdentityQuestion(message: string): boolean {
  const text = message.toLowerCase()
  return (
    /\b(who|what) (are|r) (you|u)\b/.test(text) ||
    /\bare you (a |an )?(bot|human|person|real|ai|robot)\b/.test(text) ||
    /\bwhat (are|r) (you|u)\b/.test(text) ||
    /\bwho am i (talking|chatting|speaking) (to|with)\b/.test(text) ||
    /\bis this (a |an )?(bot|human|person|real)\b/.test(text)
  )
}

/**
 * Look up wa_messages to decide if this is a first-contact conversation
 * (zero outbound from us in the last 24h to this phone number).
 *
 * NOTE: the inbound sender's E.164 phone is stored on wa_messages as `wa_phone`
 * (see supabase-migration-whatsapp-bot-consolidated.sql). There is NO `wa_id`
 * column. Querying the wrong column makes Supabase return an error, the catch
 * fires, and we default to first-contact=true on EVERY turn — which appends the
 * Zanii sign-off to every reply, not just the first. (Root cause of KT bot
 * sign-off spam.)
 *
 * Defensive: if the env is not wired we default to true (err toward identifying
 * ourselves). A genuine query error is now logged, not silently treated as
 * first-contact.
 */
async function isFirstContactByWaId(waId: string): Promise<boolean> {
  try {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return true
    }
    const sb = createAdminClient()
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count, error } = await sb
      .from('wa_messages')
      .select('id', { count: 'exact', head: true })
      .eq('wa_phone', waId)
      .eq('direction', 'out')
      .gte('created_at', since)

    if (error) {
      // Surface the real error rather than silently defaulting to a wrong
      // "first contact = true". Still fail safe (sign off) so we identify
      // ourselves if the lookup is genuinely unavailable.
      console.error('[festival-brain] isFirstContactByWaId query error', error)
      return true
    }
    return (count ?? 0) === 0
  } catch (err) {
    console.error('[festival-brain] isFirstContactByWaId threw', err)
    return true
  }
}

/**
 * Record an escalation. The portal surfaces these in the "Needs You" queue.
 * Defensive: never throw to the caller.
 *
 * SCHEMA WARNING (needs live check): no migration in this repo defines the
 * `brain_escalations` table, so its real column names cannot be confirmed from
 * source. The other table in this file (wa_messages) stores the sender phone as
 * `wa_phone`, NOT `wa_id` — so the `wa_id` field written below is very likely
 * the wrong column name. If `brain_escalations` does not have a `wa_id` column,
 * this insert silently fails and escalations never reach the "Needs You" queue.
 * ACTION: verify the live `brain_escalations` schema (e.g.
 *   select column_name from information_schema.columns
 *   where table_name = 'brain_escalations';)
 * and rename `wa_id` here to match (likely `wa_phone` or `phone`). Until then,
 * insert errors are LOGGED below instead of being swallowed, so a column
 * mismatch is visible in the bot logs rather than failing silently.
 */
async function escalateToHuman(opts: {
  waId?: string
  message: string
  intent: IntentResult
  reason: string
}): Promise<void> {
  try {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return
    const sb = createAdminClient()
    // TODO(live-schema): confirm column name for the sender phone on
    // brain_escalations and fix the key below if it is not `wa_id`.
    const { error } = await sb.from('brain_escalations').insert({
      wa_id: opts.waId ?? null,
      message: opts.message,
      intent: opts.intent.intent,
      confidence: opts.intent.confidence,
      reason: opts.reason,
      created_at: new Date().toISOString(),
    })
    if (error) {
      // Do not silently lose escalations. A column mismatch (e.g. wa_id vs
      // wa_phone) or a missing table surfaces here instead of vanishing.
      console.error('[festival-brain] escalateToHuman insert error', error)
    }
  } catch (err) {
    // brain_escalations table may not exist yet in this env. Log, never throw.
    console.error('[festival-brain] escalateToHuman threw', err)
  }
}

function postProcess(text: string): string {
  return stripEmDashes(stripForbiddenSelfRefs(text)).trim()
}

/**
 * Main entry. Inbound message in, polished outbound text out.
 */
export async function askFestivalBrain(
  message: string,
  context: BrainContext = {},
): Promise<BrainResult> {
  const intent = classifyIntent(message)
  const identityQ = isIdentityQuestion(message)

  // Step 0a: identity question shortcut. Never let the LLM answer this from memory.
  if (identityQ) {
    const isFirstContact = context.forceFirstContact ?? (context.waId ? await isFirstContactByWaId(context.waId) : true)
    const out = ZANII_IDENTITY_LINE + ZANII_FIRST_CONTACT_SIGNOFF
    return {
      message: postProcess(out),
      needsHuman: false,
      trace: {
        intent,
        matchedFaq: null,
        pathTaken: 'identity',
        isFirstContact,
        needsHuman: false,
        signoffAppended: true,
      },
    }
  }

  // Step 0b: explicit human request always escalates.
  if (intent.intent === 'human_request') {
    await escalateToHuman({
      waId: context.waId,
      message,
      intent,
      reason: 'user explicitly requested a human',
    })
    return {
      message: postProcess(HOLDING_MESSAGE),
      needsHuman: true,
      trace: {
        intent,
        matchedFaq: null,
        pathTaken: 'escalate',
        isFirstContact: context.forceFirstContact ?? true,
        needsHuman: true,
        signoffAppended: false,
      },
    }
  }

  // Step 0c: spam => silent drop equivalent (still returns a polite line, but escalates).
  if (intent.intent === 'spam' && intent.confidence >= 0.6) {
    await escalateToHuman({ waId: context.waId, message, intent, reason: 'looks like spam' })
    return {
      message: postProcess(HOLDING_MESSAGE),
      needsHuman: true,
      trace: {
        intent,
        matchedFaq: null,
        pathTaken: 'escalate',
        isFirstContact: context.forceFirstContact ?? true,
        needsHuman: true,
        signoffAppended: false,
      },
    }
  }

  // Step 1: FAQ pattern match.
  let faqHit: FaqEntry | null = matchFaq(message)
  // Vendor-operational FAQ answers (stall prices, halaal-cert requirements,
  // electricity add-ons) must NOT serve on the public surface — those belong in
  // the exhibitor portal. Drop the hit so we fall through to the LLM step, which
  // carries the PUBLIC_VENDOR_SCOPE deflection. ('vendor_apply' stays: telling
  // people HOW to apply is allowed on the public site.)
  if (faqHit && context.surface !== 'vendor' && VENDOR_ONLY_FAQ.has(faqHit.key)) {
    faqHit = null
  }
  // Intent-scoped FAQ gate (KT #206651 P1.2). matchFaq and the intent classifier
  // score independently and only usually agree; when they disagree the FAQ fires
  // off-topic — the production transcripts show a payment-timing question answered
  // with festival dates, and an instalment question answered with payment methods.
  // Require the winning FAQ key to belong to the classified intent before it may
  // short-circuit; otherwise fall through to the grounded LLM.
  if (faqHit) {
    const allowed = new Set(intentFaqKeys(intent.intent))
    if (allowed.size > 0 && !allowed.has(faqHit.key)) faqHit = null
  }
  const isFirstContact =
    context.forceFirstContact ?? (context.waId ? await isFirstContactByWaId(context.waId) : true)

  if (faqHit && intent.confidence >= 0.55) {
    let out = faqHit.answer
    if (isFirstContact || context.signOff) {
      out = out + ZANII_FIRST_CONTACT_SIGNOFF
    }
    return {
      message: postProcess(out),
      needsHuman: false,
      trace: {
        intent,
        matchedFaq: faqHit.key,
        pathTaken: 'faq',
        isFirstContact,
        needsHuman: false,
        signoffAppended: isFirstContact || !!context.signOff,
      },
    }
  }

  // Step 2: only escalate pre-LLM when there is genuinely NO usable input.
  //
  // The old gate escalated every `intent.confidence < 0.6` message to a human
  // before the LLM ever ran. Given the classifier math (a single-pattern hit
  // scores 0.55, and ANY unmatched question defaults to general_inquiry @ 0.30),
  // that bounced the overwhelming majority of real questions to Samreen instead
  // of answering them. Now that the LLM is grounded with HARD FACTS + a hard
  // wall that defers to support@ for anything it does not know, low confidence
  // is a signal for WHICH grounding to attach, not a reason to refuse to answer.
  // Explicit human_request (Step 0b) and spam (Step 0c) still escalate above.
  // (KT #322)
  if (!message.trim()) {
    await escalateToHuman({
      waId: context.waId,
      message,
      intent,
      reason: 'empty inbound message, nothing to answer',
    })
    return {
      message: postProcess(HOLDING_MESSAGE),
      needsHuman: true,
      trace: {
        intent,
        matchedFaq: null,
        pathTaken: 'escalate',
        isFirstContact,
        needsHuman: true,
        signoffAppended: false,
      },
    }
  }

  // Step 3: LLM with tightened prompt + grounding.
  if (!client) {
    // No API key configured: degrade gracefully.
    return {
      message: postProcess(HOLDING_MESSAGE),
      needsHuman: true,
      trace: {
        intent,
        matchedFaq: null,
        pathTaken: 'escalate',
        isFirstContact,
        needsHuman: true,
        signoffAppended: false,
      },
    }
  }

  // Grounding keys must obey the same public/vendor wall as the FAQ
  // short-circuit: on the public surface, strip vendor-operational keys
  // (stall prices, electricity, halaal-cert detail) so their facts never reach
  // the LLM and get echoed past PUBLIC_VENDOR_SCOPE. (KT #323)
  let groundingKeys = intentFaqKeys(intent.intent)
  if (context.surface !== 'vendor') {
    groundingKeys = groundingKeys.filter((k) => !VENDOR_ONLY_FAQ.has(k))
  }
  const grounding = buildGroundingContext(groundingKeys)
  let system = buildSystemPrompt(intent.intent, grounding, context.surface)
  if (context.extraSystem && context.extraSystem.trim()) {
    system = `${system}\n\n=== ABOUT THE SENDER ===\n${context.extraSystem.trim()}`
  }

  const history = (context.history ?? []).slice(-8)
  const llmMessages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: message },
  ]

  let llmText = ''
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 280,
      temperature: 0,
      system,
      messages: llmMessages,
    })
    llmText = response.content[0]?.type === 'text' ? response.content[0].text : ''
  } catch (err) {
    console.error('[festival-brain] llm error', err)
    await escalateToHuman({ waId: context.waId, message, intent, reason: 'llm error' })
    return {
      message: postProcess(HOLDING_MESSAGE),
      needsHuman: true,
      trace: {
        intent,
        matchedFaq: null,
        pathTaken: 'escalate',
        isFirstContact,
        needsHuman: true,
        signoffAppended: false,
      },
    }
  }

  if (!llmText.trim()) {
    await escalateToHuman({
      waId: context.waId,
      message,
      intent,
      reason: 'empty LLM response',
    })
    return {
      message: postProcess(HOLDING_MESSAGE),
      needsHuman: true,
      trace: {
        intent,
        matchedFaq: null,
        pathTaken: 'escalate',
        isFirstContact,
        needsHuman: true,
        signoffAppended: false,
      },
    }
  }

  let out = llmText
  const appendSig = isFirstContact || !!context.signOff
  if (appendSig) {
    out = out.trim() + ZANII_FIRST_CONTACT_SIGNOFF
  }

  return {
    message: postProcess(out),
    needsHuman: false,
    trace: {
      intent,
      matchedFaq: null,
      pathTaken: 'llm',
      isFirstContact,
      needsHuman: false,
      signoffAppended: appendSig,
    },
  }
}
