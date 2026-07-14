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
import { sendMedia } from '@/lib/whatsapp'
import { renderInvoicePdf } from '@/lib/payments/invoice-pdf'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { paymentReference } from '@/lib/payments'
import { startVendorVerification } from '@/lib/bot/vendor-session'

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

async function checkApplicationStatus(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application. Please contact support@youngatheart.co.za.'
  const state = parsePortalState(row.admin_notes || '')
  const alloc = parseAllocation(row.admin_notes || '')
  return `Business: ${row.business_name}. Application status: ${row.status}. Payment: ${state.payment?.status || 'none'}. Contract: ${row.contract_signed_at ? 'signed' : 'not signed yet'}. Stall: ${alloc.stall ? `allocated ${alloc.stall}` : 'not allocated yet'}.`
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

async function sendContract(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application.'
  if (row.contract_signed_at && row.contract_pdf_path) {
    const db = createAdminClient()
    const { data } = await db.storage.from('vendor-docs').createSignedUrl(row.contract_pdf_path, 300)
    if (data?.signedUrl) return `Here is your signed contract (link valid 5 minutes): ${data.signedUrl}`
  }
  return `Your contract is waiting in the portal at ${PORTAL_LOGIN}. Log in, open Contract, review it and sign. Reply here once you have signed and I can send you the signed copy.`
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

async function requestPasswordReset(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row?.email) return `I do not have an email on file for you. Please contact support@youngatheart.co.za.`
  // Reuse the tested public endpoint (anti-enumeration + ops monitoring live there).
  try {
    await fetch('https://cthalaal.co.za/api/exhibitor/send-password-reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: row.email }),
    })
  } catch (e) {
    console.error('[tool request_password_reset] failed:', (e as Error).message)
  }
  const [u, d] = (row.email || '').split('@')
  const masked = d ? `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}` : row.email
  return `I have sent a password reset link to ${masked}. Check your inbox (and spam or promotions). Open the link and set a new password, then log in at ${PORTAL_LOGIN}.`
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
async function flagNeedsHuman(vendorId: string, label: string): Promise<void> {
  try {
    const db = createAdminClient()
    const { data } = await db.from('vendor_applications').select('phone').eq('id', vendorId).maybeSingle()
    const phone = ((data as { phone?: string | null } | null)?.phone || '').replace(/\D/g, '')
    if (!phone) return
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: phone,
      body: `[NEEDS_HUMAN] ${label}`.slice(0, 300),
      status: 'sent',
      metadata: { system: true, needs_human: true },
    })
  } catch (e) { console.error('[flagNeedsHuman] failed:', (e as Error).message) }
}

async function requestStallChange(vendorId: string, requestedTier: string): Promise<string> {
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
    })
  } catch (e) { console.error('[tool request_stall_change] notify failed:', (e as Error).message) }
  await flagNeedsHuman(vendorId, `stall change request: "${clean}"`)
  return `Done. I have submitted your request to change from ${currentTier} to "${clean}". The team will review it (stall changes affect pricing and placement, so a person confirms them) and get back to you. You can also track it in your portal.`
}

async function escalateToHuman(vendorId: string, note: string): Promise<string> {
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
    })
  } catch (e) { console.error('[tool escalate_to_human] notify failed:', (e as Error).message) }
  await flagNeedsHuman(vendorId, `asked for a human: "${clean.slice(0, 120)}"`)
  return `I have logged this for the festival team and notified them: "${clean.slice(0, 120)}${clean.length > 120 ? '…' : ''}". They will follow up with you here. Anything else in the meantime?`
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
      case 'send_contract': content = await sendContract(session.vendorId!); break
      case 'get_logo_upload_link': content = getLogoUploadLink(); break
      case 'start_verification': content = await startVerification(session, (args as { email?: string })?.email || ''); break
      case 'request_password_reset': content = await requestPasswordReset(session.vendorId!); break
      case 'request_stall_change': content = await requestStallChange(session.vendorId!, (args as { requested_tier?: string })?.requested_tier || ''); break
      case 'escalate_to_human': content = await escalateToHuman(session.vendorId!, (args as { note?: string })?.note || ''); break
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
