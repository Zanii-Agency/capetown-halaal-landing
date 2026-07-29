// Tool registry + executor (ADR-0005, spec 010).
//
// THE ISOLATION WALL. executeTool scopes every vendor tool to session.vendorId
// and NEVER reads an identifying id from the model's args or the user's text.
// A forged {vendorId: <someone else>} in args is inert: scoped tools read
// session.vendorId only. This holds regardless of what the prompt says, so
// prompt injection cannot cross it. Authz is here, not in the system prompt.
//
// Tools reuse existing, tested platform code (invoice render, Yoco, stall-change
// write, the password-reset endpoint, support + notifyOwners) rather than
// reimplementing. Slow work (PDF render + WhatsApp media send) is returned as a
// `deferred` the webhook runs after the 200, so the loop is never blocked.

import { randomUUID } from 'node:crypto'
import type { VendorSession } from '@/lib/bot/vendor-session'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { parseAllocation, tierLabel } from '@/lib/stalls'
import { FAQ, type FaqKey } from '@/lib/festival-brain/faq'
import { writeToolReceipt } from '@/lib/bot/tools/audit'
import { notifyOwners } from '@/lib/bot/notify'
import { sendMedia, sendText } from '@/lib/whatsapp'
import { renderInvoicePdf } from '@/lib/payments/invoice-pdf'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { paymentReference } from '@/lib/payments'
import { startVendorVerification } from '@/lib/bot/vendor-session'
import { buildSendable } from '@/lib/inbox/send-library'

const PORTAL_LOGIN = 'cthalaal.co.za/exhibitor/login'

export const TOOL_DEFS = [
  {
    name: 'get_event_info',
    description:
      'Answer a public factual question about the Young at Heart / Cape Town Halaal festival (dates, venue, opening hours, ticket prices, parking, how to apply as a vendor). Call for any general festival question. Available to everyone, verified or not.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { topic: { type: 'string', enum: ['dates', 'venue', 'opening_hours', 'ticket_price', 'parking', 'vendor_apply', 'contact', 'general'], description: 'Subject of the question' } },
      required: ['topic'],
    },
  },
  {
    name: 'check_application_status',
    description: "Return THIS vendor's own application status, payment status, contract status and allocated stall. Call when a verified vendor asks where they stand or what to do next. Takes no identifying arguments.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'get_payment_status',
    description: "Check THIS vendor's live payment status (queries the Yoco gateway directly when a checkout exists, else the recorded status). Call when a verified vendor asks whether their payment went through or how much is outstanding.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'get_invoice',
    description: "Send THIS vendor their invoice as a PDF over WhatsApp. Call when a verified vendor asks for their invoice, bill, or receipt.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'get_badge_allocation',
    description: "Report how many staff badges THIS vendor has registered and how many they are allowed. Call when a verified vendor asks about staff badges or gate passes.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'send_contract',
    description: "Give THIS vendor their contract: a link to their signed contract if signed, otherwise the portal link to review and sign it. Call when a verified vendor asks for or about their contract.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'get_logo_upload_link',
    description: "Give THIS vendor the portal link where they upload their logo and edit their public profile. Call when a verified vendor asks how to add or change their logo.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'request_password_reset',
    description: "Trigger a password-reset email to THIS vendor's on-file email so they can regain portal access. Call when a verified vendor says they cannot log in, lost their password, or their temporary password expired.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'request_stall_change',
    description: "Submit a stall-size change request for THIS vendor to the team's review queue (a human approves it; pricing and floor-plan have real consequences). Call when a verified vendor asks to upgrade, downsize, or change their stall. Pass the requested size in `requested_tier` as the vendor described it.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { requested_tier: { type: 'string', description: 'The stall size the vendor is asking for, in their words (e.g. "4x2m double table", "6x3m full double")' } },
      required: ['requested_tier'],
    },
  },
  {
    name: 'escalate_to_human',
    description: "Log a note for the festival team and notify them, when the vendor needs something no other tool covers. Call when a verified vendor has a request or question you cannot resolve with the other tools. Pass a one-line summary in `note`.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { note: { type: 'string', description: "A concise summary of what the vendor needs, in the vendor's own words where possible" } },
      required: ['note'],
    },
  },
  {
    name: 'start_verification',
    description: "Send a 6-digit verification code to the email on a vendor's application, so an unverified sender can prove who they are. Call this ONLY when the sender is not yet verified and has given you the email on their application. After they reply with the code they become verified.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { email: { type: 'string', description: 'The email address the sender says is on their vendor application' } },
      required: ['email'],
    },
  },
] as const

// Vendor-scoped tools require a verified session. Anything NOT listed is public.
// New scoped tools MUST be added here — fail closed, not open.
const SCOPED_TOOLS = new Set<string>([
  'check_application_status', 'get_payment_status', 'get_invoice', 'get_badge_allocation',
  'send_contract', 'get_logo_upload_link', 'request_password_reset', 'request_stall_change', 'escalate_to_human',
])

export interface ToolOutcome {
  content: string
  isError?: boolean
  /** Slow follow-up (PDF render + media send) the webhook runs after the 200. */
  deferred?: () => Promise<void>
}

const PUBLIC_TOPIC_FACT: Record<string, FaqKey | 'general'> = {
  dates: 'dates', venue: 'venue', opening_hours: 'opening_hours', ticket_price: 'ticket_price',
  parking: 'parking', vendor_apply: 'vendor_apply', contact: 'contact', general: 'general',
}

function getEventInfo(args: unknown): string {
  const topic = (args as { topic?: string })?.topic || 'general'
  const key = PUBLIC_TOPIC_FACT[topic] || 'general'
  if (key === 'general') return [FAQ.dates.fact, FAQ.venue.fact, FAQ.ticket_price.fact, FAQ.vendor_apply.fact].join(' ')
  return FAQ[key].fact
}

// One scoped fetch of the caller's own row. Every scoped tool routes through
// this — the WHERE id = session.vendorId is the only place the scope key lives.
async function ownRow(vendorId: string) {
  const db = createAdminClient()
  const { data } = await db
    .from('vendor_applications')
    .select('business_name, contact_name, email, status, admin_notes, contract_signed_at, contract_pdf_path, preferred_booth_tier, special_requirements')
    .eq('id', vendorId)
    .single()
  return data as {
    business_name: string; contact_name: string | null; email: string | null; status: string
    admin_notes: string | null; contract_signed_at: string | null; contract_pdf_path: string | null
    preferred_booth_tier: string | null; special_requirements: unknown
  } | null
}

// Surface requests the vendor already has open with the team, so the bot never
// tells a vendor "no request on file" seconds after logging one, and never opens
// a duplicate. escalate_to_human writes to state.support[]; stall changes write
// their own pending markers. A trailing vendor message with no admin reply after
// it is still awaiting the team.
export function pendingRequestsLine(state: ReturnType<typeof parsePortalState>): string {
  const bits: string[] = []
  const sup = state.support || []
  const last = sup[sup.length - 1]
  if (last && last.from === 'vendor') {
    const day = (last.at || '').slice(0, 10)
    bits.push(`a request already logged with the team${day ? ` on ${day}` : ''} ("${last.body.slice(0, 90)}")`)
  }
  if (state.stallChangeRequest?.status === 'pending') {
    bits.push(`a pending stall-size change request to "${state.stallChangeRequest.requestedTier}"`)
  }
  if (state.stallMoveRequest?.status === 'pending') {
    bits.push('a pending stall-position request')
  }
  if (!bits.length) return ''
  return ` Open with the team (they will follow up here, do not log it again): ${bits.join('; ')}.`
}

async function checkApplicationStatus(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application. Please contact support@youngatheart.co.za.'
  const state = parsePortalState(row.admin_notes || '')
  const alloc = parseAllocation(row.admin_notes || '')
  return `Business: ${row.business_name}. Application status: ${row.status}. Payment: ${state.payment?.status || 'none'}. Contract: ${row.contract_signed_at ? 'signed' : 'not signed yet'}. Stall: ${alloc.stall ? `allocated ${alloc.stall}` : 'not allocated yet'}.${pendingRequestsLine(state)}`
}

async function getPaymentStatus(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application.'
  const state = parsePortalState(row.admin_notes || '')
  const ref = state.payment?.provider_ref
  const key = (process.env.YOCO_SECRET_KEY || '').trim()
  // Live Yoco check when we have a checkout ref and a key; else the recorded status.
  if (ref && ref.startsWith('ch_') && key) {
    try {
      const r = await fetch(`https://payments.yoco.com/api/checkouts/${ref}`, { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store' })
      if (r.ok) {
        const ck = (await r.json()) as { status?: string; amount?: number }
        const live = ck.status === 'completed' ? 'paid' : (ck.status || 'unknown')
        return `Your payment status with the gateway is: ${live}. Recorded status: ${state.payment?.status || 'none'}.`
      }
    } catch { /* fall through to cached */ }
  }
  return `Your recorded payment status is: ${state.payment?.status || 'none'}${state.payment?.amount ? `, R${state.payment.amount} received` : ''}. Pay your stall fee by card in the portal at ${PORTAL_LOGIN}.`
}

async function getBadgeAllocation(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application.'
  const state = parsePortalState(row.admin_notes || '')
  const active = (state.staff || []).filter((s) => !s.revoked_at).length
  const allowed = typeof state.passAllowance === 'number' ? ` of ${state.passAllowance} allowed` : ''
  return `You have ${active} staff badge${active === 1 ? '' : 's'} registered${allowed}. Manage them in the portal at ${PORTAL_LOGIN}.`
}

/**
 * SEND the contract, as a file, rather than describing one.
 *
 * This used to return a STRING and nothing else, so "I'll send you your
 * contract" was unfulfillable on the happy path: the vendor got a sentence, not
 * a document. Both halves now come from the send library, so what the bot can
 * offer and what it can deliver are the same list by construction.
 */
function sendContractDeferred(session: VendorSession): () => Promise<void> {
  const vendorId = session.vendorId!
  const waPhone = session.waPhone
  return async () => {
    try {
      const built = await buildSendable(vendorId, 'contract')
      if (built?.kind === 'document' && built.bytes) {
        await sendMedia(waPhone, {
          bytes: built.bytes,
          mimeType: built.mimeType || 'application/pdf',
          filename: built.filename || 'contract.pdf',
          kind: 'document',
          caption: built.caption,
        })
        return
      }
      // Not signed yet: the library's link item is the honest alternative.
      const link = await buildSendable(vendorId, 'contract_link')
      if (link?.caption) await sendText(waPhone, link.caption)
    } catch (e) {
      console.error('[tool send_contract] deferred send failed:', (e as Error).message)
    }
  }
}

async function contractStatusLine(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application.'
  return row.contract_signed_at
    ? 'Sending your signed contract now.'
    : `Your contract is waiting in your portal at ${PORTAL_LOGIN}. Sending you the link now.`
}

function getInvoiceDeferred(session: VendorSession): () => Promise<void> {
  const vendorId = session.vendorId!
  const waPhone = session.waPhone
  return async () => {
    try {
      const row = await ownRow(vendorId)
      if (!row) return
      const state = parsePortalState(row.admin_notes || '')
      const amount = state.payment?.amount ?? (() => {
        try { return computeVendorPricing({ preferred_booth_tier: row.preferred_booth_tier as string, special_requirements: row.special_requirements }).total } catch { return 0 }
      })()
      const pdf = await renderInvoicePdf({
        applicationId: vendorId,
        businessName: row.business_name,
        contactName: row.contact_name || '',
        email: row.email || '',
        phone: waPhone,
        amount,
        status: state.payment?.status || 'none',
        reference: state.payment?.reference || paymentReference(vendorId),
        providerRef: state.payment?.provider_ref || '',
        method: state.payment?.method,
        preferredBoothTier: row.preferred_booth_tier || '',
        specialRequirements: row.special_requirements,
      })
      if (!pdf) return
      const slug = (row.business_name || 'invoice').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'invoice'
      await sendMedia(waPhone, { bytes: pdf, mimeType: 'application/pdf', filename: `CTH-Invoice-${slug}.pdf`, kind: 'document', caption: 'Your Cape Town Halaal Festival invoice.' })
    } catch (e) {
      console.error('[tool get_invoice] deferred send failed:', (e as Error).message)
    }
  }
}

async function requestPasswordReset(session: VendorSession): Promise<string> {
  const vendorId = session.vendorId!
  const row = await ownRow(vendorId)
  if (!row?.email) return `I do not have an email on file for you. Please contact support@youngatheart.co.za.`
  // NEVER CLAIM A SEND THIS FUNCTION DID NOT VERIFY.
  //
  // This used to `await fetch(...)` and throw the response away, then return
  // "I have sent a password reset link" unconditionally. The endpoint already
  // confirmed delivery and already alerted the master on failure, so the system
  // KNEW the mail had bounced. The only person not told was the vendor.
  //
  // Raeesa Jenkins (MaterniTee) was told "sent" three times across five weeks
  // while every message bounced off a typo on her application,
  // raeesajenkjns@ where raeesajenkins@ belonged. She spent that time searching
  // a spam folder for mail that never existed. Mias Chill Station hit the same
  // thing on 2026-07-27. Both alerts reached the operator; neither vendor was
  // corrected.
  //
  // The Bearer header is what makes the endpoint answer honestly: to anonymous
  // callers it still returns a bare {ok:true} so nobody can probe which
  // addresses have accounts.
  const [u, d] = (row.email || '').split('@')
  const masked = d ? `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}` : row.email

  let delivered = false
  let reason = 'the request did not go through'
  try {
    const res = await fetch('https://cthalaal.co.za/api/exhibitor/send-password-reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
      },
      body: JSON.stringify({ email: row.email }),
    })
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean; reason?: string }
    // `delivered` is absent when the secret is unset or the deploy is older than
    // this change. Absent means UNVERIFIED, and unverified must not be reported
    // as success, so it falls through to the honest branch below.
    delivered = j.delivered === true
    if (j.reason) reason = j.reason
  } catch (e) {
    console.error('[tool request_password_reset] failed:', (e as Error).message)
  }

  if (delivered) {
    return `I have sent a password reset link to ${masked}. Check your inbox (and spam or promotions). Open the link and set a new password, then log in at ${PORTAL_LOGIN}.`
  }

  // Tell the vendor the truth and put a human on it. Say the address out loud,
  // unmasked, because a typo is invisible behind asterisks and reading it back
  // is what lets them spot it themselves.
  await escalateToHuman(session, `Password reset could not be delivered to ${row.email} (${reason}). Vendor is locked out and needs the address checked.`)
    .catch(() => {})
  return `I could not get that email through to ${row.email}, so the address on your application may be wrong or it may be blocking us. ` +
    `Please check it letter by letter and tell me the correct one if it is different. ` +
    `I have flagged this for the team and someone will sort your access out with you here.`
}

async function startVerification(session: VendorSession, email: string): Promise<string> {
  const r = await startVendorVerification(session.waPhone, (email || '').trim())
  if (!r.ok) {
    if (r.reason === 'no_application_for_email') return "I couldn't find an application with that email. Please double-check it, or contact support@youngatheart.co.za."
    if (r.reason === 'email_multiple') return 'That email is linked to more than one application. Please contact support@youngatheart.co.za so we can sort it out.'
    return "I couldn't send the code just now. Please try again shortly."
  }
  return `I've sent a 6-digit code to ${r.maskedEmail}. Reply here with the code and I'll verify you.`
}

function getLogoUploadLink(): string {
  return `You can upload your logo in the portal at ${PORTAL_LOGIN}. Log in, open Profile, and use the logo upload (JPG or PNG works best). It appears on the public festival map once your stall is confirmed.`
}

// Drop a [NEEDS_HUMAN] breadcrumb on the vendor's own WhatsApp thread so the
// admin "Needs You" queue can surface a follow-up the bot promised ("I've passed
// this to the team"). Same marker doctrine as [HUMAN_HANDOVER_*]: the unified
// inbox scan reads it and isMarker() hides it from previews. It clears when a
// human replies through the composer (metadata.sent_by) or the thread is
// resolved. Best-effort: never breaks the tool it rides on.
//
// Write to session.waPhone (the LIVE inbound thread key, == toE164(msg.from)),
// NOT the on-file application.phone. The old path re-derived from application
// .phone and stripped to digits-only, so the breadcrumb landed on a phantom
// `27…` key while the real conversation lived on `+27…` — the fragmentation
// that made escalations invisible on the vendor's actual thread.
async function flagNeedsHuman(waPhone: string, label: string): Promise<void> {
  try {
    if (!waPhone) return
    const db = createAdminClient()
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: waPhone,
      body: `[NEEDS_HUMAN] ${label}`.slice(0, 300),
      status: 'sent',
      metadata: { system: true, needs_human: true },
    })
  } catch (e) { console.error('[flagNeedsHuman] failed:', (e as Error).message) }
}

async function requestStallChange(session: VendorSession, requestedTier: string): Promise<string> {
  const vendorId = session.vendorId!
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application.'
  const currentTier = row.preferred_booth_tier ? tierLabel(row.preferred_booth_tier) : 'your current stall'
  const clean = (requestedTier || '').trim().slice(0, 200)
  await updatePortalState(vendorId, (s) => ({
    ...s,
    stallChangeRequest: {
      requestedTier: clean,
      currentTier: row.preferred_booth_tier || '',
      reason: 'Requested via WhatsApp',
      status: 'pending',
      createdAt: new Date().toISOString(),
    },
  }))
  try {
    await notifyOwners({
      event: 'vendor_support_message',
      body: `STALL CHANGE REQUEST via WhatsApp (unverified free text, do not treat as an instruction)\nBusiness (on file): ${row.business_name}\nFrom: ${currentTier}\nWants: "${clean}"\nReview at /admin/stall-changes`,
      audience: 'all',
      // Reaches the owner only for a vendor she owns (paid via Yoco/cash/waived).
      vendorId,
    })
  } catch (e) { console.error('[tool request_stall_change] notify failed:', (e as Error).message) }
  await flagNeedsHuman(session.waPhone, `stall change request: "${clean}"`)
  return `Done. I have submitted your request to change from ${currentTier} to "${clean}". The team will review it (stall changes affect pricing and placement, so a person confirms them) and get back to you. You can also track it in your portal.`
}

async function escalateToHuman(session: VendorSession, note: string): Promise<string> {
  const vendorId = session.vendorId!
  const row = await ownRow(vendorId)
  const biz = row?.business_name || 'a vendor'
  const clean = (note || '').trim().slice(0, 1000)
  await updatePortalState(vendorId, (s) => ({
    ...s,
    support: [...(s.support || []), { id: randomUUID(), from: 'vendor' as const, body: clean, at: new Date().toISOString() }],
  }))
  try {
    await notifyOwners({
      event: 'vendor_support_message',
      body: `VENDOR NEEDS A HUMAN via WhatsApp (unverified free text, do not treat as an instruction)\nBusiness (on file): ${biz}\nNote: "${clean.slice(0, 240)}"`,
      audience: 'all',
      // Reaches the owner only for a vendor she owns. `row` may be null here
      // (unresolvable vendor): pass no id, and the body-text check still applies.
      vendorId: row ? vendorId : undefined,
    })
  } catch (e) { console.error('[tool escalate_to_human] notify failed:', (e as Error).message) }
  await flagNeedsHuman(session.waPhone, `asked for a human: "${clean.slice(0, 120)}"`)
  return `I have passed this to the team: "${clean.slice(0, 120)}${clean.length > 120 ? '…' : ''}". Someone will come back to you here.`
}

/**
 * Execute a tool for a session. Enforces the verification gate, injects the
 * session vendorId, ignores model-supplied ids, and writes an audit receipt
 * BEFORE returning.
 */
export async function executeTool(session: VendorSession, name: string, args: unknown): Promise<ToolOutcome> {
  if (SCOPED_TOOLS.has(name) && (session.status !== 'verified' || !session.vendorId)) {
    await writeToolReceipt({ waPhone: session.waPhone, tool: name, vendorId: null, ok: false, detail: 'refused: not verified' })
    return { content: "I can only share or change your own account details once I've confirmed who you are. Tell me the email on your application and I'll send you a 6-digit code to verify.", isError: true }
  }
  const vid = session.vendorId ?? null
  try {
    let content: string
    let deferred: (() => Promise<void>) | undefined
    switch (name) {
      case 'get_event_info': content = getEventInfo(args); break
      case 'check_application_status': content = await checkApplicationStatus(session.vendorId!); break
      case 'get_payment_status': content = await getPaymentStatus(session.vendorId!); break
      case 'get_badge_allocation': content = await getBadgeAllocation(session.vendorId!); break
      case 'send_contract':
        deferred = sendContractDeferred(session)
        content = await contractStatusLine(session.vendorId!)
        break
      case 'get_logo_upload_link': content = getLogoUploadLink(); break
      case 'start_verification': content = await startVerification(session, (args as { email?: string })?.email || ''); break
      case 'request_password_reset': content = await requestPasswordReset(session); break
      case 'request_stall_change': content = await requestStallChange(session, (args as { requested_tier?: string })?.requested_tier || ''); break
      case 'escalate_to_human': content = await escalateToHuman(session, (args as { note?: string })?.note || ''); break
      case 'get_invoice':
        deferred = getInvoiceDeferred(session)
        content = 'Sending the vendor their invoice as a PDF now.'
        break
      default:
        await writeToolReceipt({ waPhone: session.waPhone, tool: name, vendorId: vid, ok: false, detail: 'unknown tool' })
        return { content: `Unknown tool: ${name}`, isError: true }
    }
    await writeToolReceipt({ waPhone: session.waPhone, tool: name, vendorId: vid, ok: true, detail: SCOPED_TOOLS.has(name) ? 'scoped' : 'public' })
    return { content, deferred }
  } catch (e) {
    await writeToolReceipt({ waPhone: session.waPhone, tool: name, vendorId: vid, ok: false, detail: `error: ${(e as Error).message}` })
    return { content: 'Something went wrong on our side. Please try again or contact support@youngatheart.co.za.', isError: true }
  }
}
