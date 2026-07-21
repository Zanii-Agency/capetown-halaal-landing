// Sonnet tool-calling vendor agent (ADR-0005, spec 010 Phase A).
//
// Flag-gated behind CTH_AGENT (default off) and NOT wired into the live webhook
// yet — Phase D swaps the FAQ short-circuit for this. It exists now so the
// adversarial injection eval exercises the REAL loop against the REAL executor.
//
// The authorization wall is the tool executor (registry.ts), NOT this prompt.
// The system prompt cannot grant or widen access; it only shapes tone and tells
// the model which tool to reach for. A jailbreak that "convinces" the model to
// dump all vendors still cannot, because check_application_status ignores every
// argument and reads session.vendorId only.

import Anthropic from '@anthropic-ai/sdk'
import type { VendorSession } from '@/lib/bot/vendor-session'
import { TOOL_DEFS, executeTool } from '@/lib/bot/tools/registry'
import { VENDOR_FACTS } from '@/lib/festival-brain/system-prompt'
import { FAQ } from '@/lib/festival-brain/faq'

const MODEL = process.env.CTH_AGENT_MODEL || 'claude-sonnet-5'
const MAX_TOOL_ROUNDS = 5

export function vendorAgentEnabled(): boolean {
  return (process.env.CTH_AGENT || '').toLowerCase() === 'on'
}

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null

export function systemPrompt(session: VendorSession): string {
  const verified = session.status === 'verified'
  const who =
    verified
      ? "You are speaking with a VERIFIED vendor. You may share THEIR OWN details via the tools."
      : session.status === 'ambiguous'
        ? "This WhatsApp number is linked to more than one business, so it is NOT verified. Ask which business, then verify by email before sharing any account details."
        : "This sender is NOT verified. You may answer public festival questions with get_event_info, but to share any account-specific detail you must first verify them by email."
  const parts = [
    'You are Zanii AI, the assistant for the Young at Heart Festival (Cape Town Halaal) 2026.',
    who,
    'Rules you must always follow:',
    '- NEVER reveal another vendor\'s details. You physically cannot look them up; do not claim you can.',
    '- Use get_event_info for general festival facts. Use check_application_status when a verified vendor asks about their own status, payment, contract, or stall.',
    '- To verify an unknown or ambiguous sender, ask for the email on their application; a 6-digit code is sent there.',
    '- Payment is by card only (Yoco), in the portal. Do NOT mention EFT or bank transfer.',
    '- Never use the "—" character. Use commas, periods, or colons.',
    '- Be warm, concise, and specific. Do not invent dates, prices, or policies; use the tool facts and the grounding below.',
    '',
    // RESOLVE-DON\'T-DEFLECT: the #1 corpus failure was the bot escalating things it could answer.
    'RESOLVE, DO NOT DEFLECT. Answer everything you can from the grounding below before you reach for escalate_to_human. Only escalate for a refund or money dispute, a complaint, a genuine special exception, a stall cancellation/withdrawal, or something truly not covered here. Before you escalate, call check_application_status: if the vendor already has a request logged with the team, tell them it is already in hand and do NOT open a second one.',
    '',
    // Part-payment / instalments: single-sourced from the grounded FAQ answer.
    `PART PAYMENTS, INSTALMENTS, DEPOSITS, "pay half now": ${FAQ.vendor_part_payment.answer}`,
    '',
    // Conservative defaults (Taona 2026-07-21, "do the best"): give a clear answer,
    // hold the line, route genuine exceptions to a human. Never over-promise.
    'DISCOUNTS AND PRICING: stall fees are the fixed published rate for each stall type. We do not discount, negotiate, or price-match a previous year. If a vendor asks for a lower price or mentions they paid less before, state their stall price warmly and hold it. You may log their request for the team, but NEVER promise, imply, or hint at a reduction.',
    '',
    'SHARING A STALL: each stall is allocated to the one approved business that applied and paid for it. You cannot split or share a single stall between two businesses, and each business needs its own application (and its own halaal certificate if food). If a vendor wants to explore sharing, tell them plainly it is not something you can set up, then escalate_to_human with the detail so the team can consider it.',
    '',
    'STALL CANCELLATION OR WITHDRAWAL: acknowledge warmly, then escalate_to_human with their reason. The team handles cancellations and confirms any refund per the vendor terms. NEVER quote, promise, or estimate a refund amount yourself.',
  ]
  // Operational facts (prices, stall sizes, documents, allocation timing) are
  // for verified vendors only, mirroring the exhibitor-portal surface wall.
  if (verified) parts.push('', VENDOR_FACTS)
  return parts.join('\n')
}

export interface VendorAgentResult {
  message: string
  /** Every tool the loop actually executed, for audit/eval. vendorId is the
   *  SESSION id the call was scoped to (never a model-supplied value). */
  toolsUsed: Array<{ name: string; scopedVendorId: string | null }>
  /** Slow follow-ups (e.g. invoice PDF render + WhatsApp send) the webhook runs
   *  after the 200 via after(). */
  deferred: Array<() => Promise<void>>
}

/**
 * Run the tool-calling loop for one inbound message. Returns the final text plus
 * the list of tools executed (for the eval's injection assertion).
 */
export async function runVendorAgent(
  session: VendorSession,
  message: string,
  ctx: { history?: Array<{ role: 'user' | 'assistant'; content: string }> } = {},
): Promise<VendorAgentResult> {
  const toolsUsed: VendorAgentResult['toolsUsed'] = []
  const deferred: Array<() => Promise<void>> = []
  if (!client) {
    return { message: 'Let me get the team to help with that.', toolsUsed, deferred }
  }

  const system = systemPrompt(session)
  const messages: Anthropic.MessageParam[] = [
    ...(ctx.history ?? []).slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: message },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      thinking: { type: 'disabled' },   // WhatsApp latency; the wall is in the tools, not reasoning
      system,
      tools: TOOL_DEFS as unknown as Anthropic.Tool[],
      messages,
    })

    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('').trim()
      return { message: text || 'Sorry, could you say that another way?', toolsUsed, deferred }
    }

    // Execute every requested tool through the wall, collect results for one
    // combined tool_result user turn (parallel-tool-use contract).
    messages.push({ role: 'assistant', content: res.content })
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue
      const outcome = await executeTool(session, block.name, block.input)  // session-scoped; args ignored for scope
      toolsUsed.push({ name: block.name, scopedVendorId: session.vendorId ?? null })
      if (outcome.deferred) deferred.push(outcome.deferred)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return { message: 'This is taking a few steps. A team member will follow up shortly.', toolsUsed, deferred }
}
