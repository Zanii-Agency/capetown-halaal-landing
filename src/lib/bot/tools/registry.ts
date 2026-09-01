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
import { updatePortalState, parsePortalState, type DocRecord } from '@/lib/portal-state'
import { parseAllocation, resolveTierSlug, tierLabel, TIER_META, TYPE_META, STALL_LIST } from '@/lib/stalls'
import { FAQ, type FaqKey } from '@/lib/festival-brain/faq'
import { writeToolReceipt } from '@/lib/bot/tools/audit'
import { notifyOwners } from '@/lib/bot/notify'
import { sendMedia, sendText, fetchMediaBytes } from '@/lib/whatsapp'
import { broadcastInboxRefresh } from '@/lib/inbox-realtime'
import { renderInvoicePdf } from '@/lib/payments/invoice-pdf'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { paymentReference } from '@/lib/payments'
import { recordEftProof } from '@/lib/payments/eft-proof-shared'
import { renderSignedContractPdf } from '@/lib/contract/render-pdf'
import { typedSignatureDataUrl } from '@/lib/contract/typed-signature'
import { CONTRACT_VERSION } from '@/lib/contract/copy'
import { startVendorVerification } from '@/lib/bot/vendor-session'
import { buildSendable } from '@/lib/inbox/send-library'
import { APPROVED_NOTIFIED_RE } from '@/lib/applications/decision-notify'

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
    description: "Return THIS vendor's own record: the stall size they applied for and its price, the date they applied, their application status, payment status, contract status, and allocated floor stall. Call whenever a verified vendor asks where they stand, what to do next, OR what stall size or price they chose or when they applied. Takes no identifying arguments.",
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
    // NOT strict: no-arg tool (nothing to validate), and claude-sonnet-5 caps
    // strict tools at 20. Adding grant_payment_extension pushed us to 21 strict,
    // which 400'd EVERY vendor-agent call. Dropping strict on no-arg tools is free.
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'get_electrical_setup',
    description: "Report the electrical power, appliances and gas THIS vendor booked for their stall, and how it affects their total. Call whenever a verified vendor asks about power, electricity, plug points, whether they have power for a freezer/fridge/appliance, a generator, load-in setup, or gas at their stall. If they booked no power, this says so plainly so they are not caught out on the day.",
    // NOT strict: no-arg tool, keeps total strict tools <= 20 (see get_badge_allocation).
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'send_contract',
    description: "Give THIS vendor their contract: a link to their signed contract if signed, otherwise the portal link to review and sign it. Call when a verified vendor asks for or about their contract.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'sign_contract',
    description: "Sign the vendor contract for THIS vendor in WhatsApp. Call ONLY when the vendor has clearly read/accepted the contract terms and provided their full printed name (e.g. 'I agree, John Smith'). The tool records the signature, renders the signed PDF, and unlocks the payment step. If they have not given their full name, ask for it first.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        print_name: { type: 'string', description: 'The exact full name the vendor types to sign with' },
      },
      required: ['print_name'],
    },
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
    name: 'update_my_email',
    description: "Correct the email address on THIS vendor's application after a password-reset email failed to reach them. Call ONLY after request_password_reset reported it could not deliver, and the vendor has told you the correct address. Pass their corrected address in `email`. Refuses if the address on file has not actually failed, so it cannot be used for a routine address change.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { email: { type: 'string', description: 'The corrected email address, exactly as the vendor spelled it' } },
      required: ['email'],
    },
  },
  {
    name: 'request_stall_change',
    // ONE OF OUR TEN SIZES, NEVER THE VENDOR'S OWN WORDS.
    //
    // This used to take free text "as the vendor described it", which is how a
    // request for a "2.4m x 1.8m trailer" reached the approval queue and could
    // not be actioned: it is not a size we sell. Taona 2026-07-30: "from now on
    // when they request to change it must only be limited to the available
    // options not something custom".
    //
    // An enum makes that structural. The model cannot emit a custom size, so
    // the operator never sees an unactionable request, and the vendor finds out
    // what we actually offer while they are still in the conversation.
    description:
      "Submit a stall-size change for THIS vendor to the team's review queue (a human approves it; pricing and floor plan have real consequences). Call when a verified vendor asks to upgrade, downsize or change their stall. `requested_tier` MUST be one of the listed sizes: these are the only stalls the festival has. If the vendor describes something we do not offer (a trailer, a custom size, their own gazebo), do NOT guess and do NOT call this tool. Tell them the sizes available with their prices and ask which one they want, then call this with their choice.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        requested_tier: {
          type: 'string',
          enum: [
            'marquee-table-2x2', 'marquee-full-3x3', 'marquee-table-double-4x2',
            'marquee-full-double-6x3', 'outdoor-bedouin-2x3', 'food-gazebo-3x3',
            'mini-dessert-truck-3.5m', 'food-truck-4.5m', 'food-truck-6m', 'food-truck-8m',
          ],
          description:
            'The stall the vendor chose. Marquee Table 2x2m R3700, Marquee Full 3x3m R6500, Marquee Double Table 4x2m R6500, Marquee Full Double 6x3m R12000, Outdoor Bedouin 2x3m R3750, Food Gazebo 3x3m R4800, Mini Dessert Truck 3.5m R5000, Food Truck 4.5m R6500, Food Truck 6m R7500, Food Truck 8m R8500.',
        },
      },
      required: ['requested_tier'],
    },
  },
  {
    name: 'get_payment_due_date',
    description: "Return THIS vendor's exact stall fee payment due date and how many days remain. Call whenever a verified vendor asks when their payment is due, what their deadline is, or when they were approved. Do NOT escalate this to a human, the date is computed from their own approval date.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'withdraw_application',
    description: "Withdraw THIS vendor from the festival, releasing their stall. Call ONLY after the vendor has said why they are leaving AND has explicitly confirmed they want to go ahead. Pass their reason in `reason` and set `confirmed` true only when they have confirmed in their own words. If they have not given a reason yet, ask them why first and do not call this.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        reason: { type: 'string', description: "Why they are withdrawing, in their own words" },
        confirmed: { type: 'boolean', description: 'True ONLY when the vendor has explicitly confirmed after being asked' },
      },
      required: ['reason', 'confirmed'],
    },
  },
  {
    name: 'grant_payment_extension',
    description: "Give THIS vendor until 31 August 2026 (the festival's final settlement date) to pay their stall fee in full. Call when a verified vendor asks for an extension, more time, or says they will pay by the end of the month, AFTER you have confirmed they want it. This records the arrangement so the reminder system stops chasing them for the earlier date and instead acknowledges the extension. It does NOT split the fee into instalments, it only moves the single full-payment date to 31 August. If they are already paid, do not call it.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'where_is_my_stall',
    description: "Return THIS vendor's allocated stall code, zone, and a link to the map in their portal. Call when a verified vendor asks where their stall is, what zone they are in, or for their stall number.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'report_issue',
    description: "Record an issue or problem THIS vendor is having. Call when a verified vendor reports a problem you cannot fix immediately. `issue_type` categorises it: payment (cannot pay/gateway error), portal (cannot log in or page broken), documents (cannot upload a required doc), stall (question about allocated stall), other. `description` is what they said in their own words. For payment/portal/documents issues, guide them to the right fix first; only escalate if the tool says it could not resolve it.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        issue_type: { type: 'string', enum: ['payment', 'portal', 'documents', 'stall', 'other'], description: 'Category of the issue' },
        description: { type: 'string', description: "The vendor's description of the issue, in their own words" },
      },
      required: ['issue_type', 'description'],
    },
  },
  {
    name: 'upload_document',
    description: "Upload a document or photo THIS vendor just sent on WhatsApp to their portal Documents bucket. Call when a verified vendor sends a file, photo, certificate, or proof and says they want to upload it, or when the message is clearly a document upload. Takes no identifying arguments; it uploads the media attached to their current message.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'upload_eft_proof',
    description: "Upload a proof-of-payment image or PDF THIS vendor just sent on WhatsApp into the EFT proof flow. Call ONLY when the vendor is on the EFT lane and the file is clearly a bank payment proof (EFT slip, payment confirmation, bank app screenshot). This stores it against their payment record, notifies the finance team, and unlocks their portal provisionally. If the vendor is NOT on EFT, tell them to upload documents through the portal instead.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
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
  'send_contract', 'sign_contract', 'get_logo_upload_link', 'request_password_reset', 'update_my_email', 'request_stall_change',
  'get_payment_due_date', 'grant_payment_extension', 'withdraw_application', 'where_is_my_stall', 'report_issue', 'upload_document', 'upload_eft_proof',
  'escalate_to_human',
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
    // NO payment_due_date: the column does not exist on this project (DDL is
    // blocked, Law 8) and selecting it failed this scoped fetch with 42703,
    // which silently broke EVERY vendor tool below (status, due date, stall).
    // The due date is computed from reviewed_at + 30 by computePaymentDue.
    .select('business_name, contact_name, email, status, admin_notes, contract_signed_at, contract_pdf_path, preferred_booth_tier, special_requirements, reviewed_at, created_at')
    .eq('id', vendorId)
    .single()
  return data as {
    business_name: string; contact_name: string | null; email: string | null; status: string
    admin_notes: string | null; contract_signed_at: string | null; contract_pdf_path: string | null
    preferred_booth_tier: string | null; special_requirements: unknown
    payment_due_date: string | null; reviewed_at: string | null; created_at: string | null
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

  // THE SIZE THEY CHOSE IS ALWAYS ON RECORD (preferred_booth_tier), and it is NOT
  // the allocated floor code (alloc.stall, which is assigned later). Vendors keep
  // asking what size and price they applied for and when, so state all three from
  // the record rather than asking them back. Omitting the size here is exactly
  // why the bot told Rizq & Co her stall "wasn't locked in" while a R6500 Marquee
  // Double Table sat on her application (2026-08-03). Same seam as the master due
  // date: the fact is in the record, just not in the reader the vendor talks to.
  const size = row.preferred_booth_tier ? tierLabel(row.preferred_booth_tier) : ''
  let sizeLine = size
  try {
    const total = computeVendorPricing({ preferred_booth_tier: row.preferred_booth_tier as string, special_requirements: row.special_requirements }).total
    if (size && total) sizeLine = `${size} at R${total.toLocaleString('en-ZA')}`
  } catch { /* keep the size without a price */ }
  const applied = row.created_at
    ? new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : ''

  return [
    `Business: ${row.business_name}.`,
    sizeLine ? `Stall they applied for: ${sizeLine}.` : 'Stall size: not on file, ask which size they want.',
    applied ? `Applied on: ${applied}.` : '',
    `Application status: ${row.status}.`,
    `Payment: ${state.payment?.status || 'none'}.`,
    `Contract: ${row.contract_signed_at ? 'signed' : 'not signed yet'}.`,
    `Floor stall: ${alloc.stall ? `allocated ${alloc.stall}` : 'not allocated yet'}.`,
    (pendingRequestsLine(state) || '').trim(),
  ].filter(Boolean).join(' ')
}

async function getPaymentStatus(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application.'
  const state = parsePortalState(row.admin_notes || '')
  // SPLIT BILL (2026-08-04): a settled vendor may still owe their accessory
  // electricity (billed separately from the stall fee). The bot must tell the
  // same story the Payments page shows, or "why do I owe money?" gets two
  // different answers.
  try {
    const bill = vendorBill({ id: vendorId, preferred_booth_tier: row.preferred_booth_tier as string, special_requirements: row.special_requirements, admin_notes: row.admin_notes || null })
    if (bill.settled && bill.accessories.state === 'owing' && bill.accessories.owing > 0) {
      return `Your stall fee of R${bill.stall.price.toLocaleString('en-ZA')} is paid and your booth is confirmed. The electricity for the appliances you booked is billed separately, and R${bill.accessories.owing.toLocaleString('en-ZA')} is still due for it. You can settle it on the Payments page of your portal at ${PORTAL_LOGIN}.`
    }
    if (bill.settled && bill.accessories.state === 'pending') {
      return `Your stall fee is paid, and we have your proof for the accessory electricity balance. Please allow up to 24 hours for the team to confirm it.`
    }
  } catch { /* fall through to the recorded status */ }
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

// What POWER, appliances and gas the vendor booked at application time.
//
// DATA REALITY (measured over 242 approved vendors): electrical_appliances is a
// human-readable STRING for 218 of them ("1x Charger/Lighting (R400)"), an
// object for 7, empty for 17. computeVendorPricing only parses the OBJECT form,
// so 83 string-form vendors who DID book power read as zero electrical items
// there. Relying on the pricing parser would tell those 83 "you have no power",
// a false negative worse than the gap. So the RAW string is the source of truth,
// and the pricing parser is used only to pretty-print the rare object form.
//
// The no-power case is stated LOUDLY: a vendor arriving with a freezer they
// never booked power for is the exact festival-day problem this closes.
async function getElectricalSetup(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application.'

  let reqs: Record<string, unknown> = {}
  const raw = row.special_requirements
  if (typeof raw === 'string') { try { reqs = JSON.parse(raw) } catch { /* keep empty */ } }
  else if (raw && typeof raw === 'object') reqs = raw as Record<string, unknown>

  let power = ''
  const elec = reqs.electrical_appliances
  if (typeof elec === 'string') {
    power = elec.trim()
  } else if (elec && typeof elec === 'object') {
    try {
      const items = computeVendorPricing({ preferred_booth_tier: row.preferred_booth_tier as string, special_requirements: raw }).electricalItems
      power = items.map((i) => `${i.qty && i.qty > 1 ? `${i.qty}x ` : ''}${i.label} (R${i.amount.toLocaleString('en-ZA')})`).join(', ')
    } catch { power = '' }
  }
  // "1x None (R0)" / "None" / "" all mean they chose no electrical.
  const noPower = !power || /^\s*(\d+\s*x\s*)?none\b/i.test(power)

  const usesGas = String(reqs.uses_gas ?? '').trim().toLowerCase().startsWith('y')
  const appliances = String(reqs.appliance_details ?? '').trim()
  const totalEstimate = Number(reqs.total_estimate) || 0

  const parts: string[] = []
  if (noPower) {
    parts.push('You have NOT booked any electrical power, so there will be no power point at your stall. If you need power for a fridge, freezer, lights or an appliance, tell me and I will flag it to the team to add before the festival.')
  } else {
    parts.push(`Electrical power you booked: ${power}.`)
  }
  if (appliances) parts.push(`Appliances you listed bringing: ${appliances}.`)
  if (usesGas) parts.push('You noted you will use gas. A gas compliance certificate is required, so please upload it in your portal documents if you have not already.')
  else parts.push('No gas use is noted on your application.')
  if (totalEstimate) parts.push(`Your total including any add-ons is R${totalEstimate.toLocaleString('en-ZA')}.`)
  return parts.join(' ')
}

/**
 * Persist a bot-initiated outbound to wa_messages and ping the admin inbox to
 * refresh. Best-effort: a logging failure must never break the actual send.
 */
async function logBotSend(phone: string | undefined | null, body: string, library: string, providerMessageId?: string) {
  if (!phone) return
  try {
    const db = createAdminClient()
    const waPhone = phone.replace(/^\+/, '')
    const metadata = { library, sent_by: 'bot' }
    if (providerMessageId) {
      // The shared send functions now auto-log. Upsert so bot-initiated sends keep
      // their richer metadata (contract/invoice library key).
      const { data: existing } = await db
        .from('wa_messages')
        .select('id')
        .eq('provider_message_id', providerMessageId)
        .limit(1)
      if (existing && existing.length > 0) {
        await db.from('wa_messages').update({ metadata }).eq('provider_message_id', providerMessageId)
        await broadcastInboxRefresh('bot-send')
        return
      }
    }
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: waPhone,
      body,
      status: 'sent',
      provider_message_id: providerMessageId || null,
      metadata,
    })
    await broadcastInboxRefresh('bot-send')
  } catch (e) {
    console.warn('[tool registry] bot send log failed:', (e as Error).message)
  }
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
        const res = await sendMedia(waPhone, {
          bytes: built.bytes,
          mimeType: built.mimeType || 'application/pdf',
          filename: built.filename || 'contract.pdf',
          kind: 'document',
          caption: built.caption,
        })
        await logBotSend(waPhone, built.caption || 'Your contract.', 'contract', res.messageId)
        return
      }
      // Not signed yet: the library's link item is the honest alternative.
      const link = await buildSendable(vendorId, 'contract_link')
      if (link?.caption) {
        const res = await sendText(waPhone, link.caption)
        await logBotSend(waPhone, link.caption, 'contract_link', res.messageId)
      }
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

async function signContract(session: VendorSession, printName: string): Promise<string> {
  const vendorId = session.vendorId!
  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application just now. Please try again shortly.'
  if (row.contract_signed_at) {
    return `Your contract is already signed. You can move on to paying your stall fee in your portal at ${PORTAL_LOGIN}.`
  }
  if (!printName || printName.trim().length < 2) {
    return `To sign the contract, please type your full name exactly as you want it to appear on the signed agreement.`
  }

  const db = createAdminClient()
  const signedAtIso = new Date().toISOString()
  const signatureDataUrl = typedSignatureDataUrl(printName.trim())

  const pdf = await renderSignedContractPdf({
    vendorName: String(row.business_name || 'Vendor'),
    contactName: String(row.contact_name || ''),
    printName: printName.trim(),
    signedAtPlace: 'WhatsApp',
    signedAtIso,
    signatureDataUrl,
    ip: null,
    applicationId: vendorId,
  })
  if (!pdf) {
    return `I could not generate the signed contract just now. Please sign it in your portal at ${PORTAL_LOGIN} under Contract, or try again shortly.`
  }

  const path = `signed-contracts/${vendorId}.pdf`
  const { error: upErr } = await db.storage.from('vendor-docs').upload(path, pdf, {
    contentType: 'application/pdf',
    upsert: true,
  })
  if (upErr) {
    console.error('[tool sign_contract] upload failed:', upErr.message)
    return `I could not store the signed contract just now. Please sign it in your portal at ${PORTAL_LOGIN} under Contract, or try again shortly.`
  }

  const { data: transitioned, error: dbErr } = await db
    .from('vendor_applications')
    .update({
      contract_signed_at: signedAtIso,
      contract_signed_ip: null,
      contract_signed_ua: 'WhatsApp',
      contract_pdf_path: path,
      contract_version: CONTRACT_VERSION,
    })
    .eq('id', vendorId)
    .is('contract_signed_at', null)
    .select('id')

  if (dbErr) {
    console.error('[tool sign_contract] db update failed:', dbErr.message)
    return `I could not record the signature just now. Please try again shortly or sign in your portal at ${PORTAL_LOGIN}.`
  }

  const wonTransition = Array.isArray(transitioned) && transitioned.length > 0
  if (wonTransition) {
    try {
      await db.from('site_events').insert({
        session_id: `contract-${vendorId}`,
        event_type: 'contract_signed',
        path: '/api/whatsapp/webhook',
        metadata: {
          vendor_application_id: vendorId,
          business_name: row.business_name,
          mode: 'type',
          print_name: printName.trim(),
          version: CONTRACT_VERSION,
          signed_at: signedAtIso,
          storage_path: path,
          source: 'whatsapp',
        },
      })
    } catch (e) {
      console.warn('[tool sign_contract] site_events insert failed:', (e as Error).message)
    }
  }

  return `Thank you, ${printName.trim()}. Your Vendor Contract 2026 is signed and saved. You can now pay your stall fee in your portal at ${PORTAL_LOGIN} under Payments.`
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
      const caption = 'Your Cape Town Halaal Festival invoice.'
      const res = await sendMedia(waPhone, { bytes: pdf, mimeType: 'application/pdf', filename: `CTH-Invoice-${slug}.pdf`, kind: 'document', caption })
      await logBotSend(waPhone, caption, 'invoice', res.messageId)
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

async function updateMyEmail(session: VendorSession, email: string): Promise<string> {
  const { repairVendorEmail } = await import('@/lib/exhibitor/repair-email')
  const r = await repairVendorEmail(session.vendorId!, email)

  if (!r.ok) {
    // Never invent a reason. The gate refusing is a real answer and the vendor
    // deserves the actual one, not a generic apology.
    await escalateToHuman(session, `Vendor asked to change their email to "${email}" but the repair was refused: ${r.reason}.`).catch(() => {})
    return `I could not change that for you: ${r.reason}. I have flagged it for the team and someone will sort it out with you here.`
  }

  if (r.resetDelivered) {
    return `Done, I have corrected your email to ${r.newEmail} and sent a fresh link to set your password. It should arrive within a few minutes, check promotions and spam too. Open the link, choose a password, then log in at ${PORTAL_LOGIN}.`
  }
  // Address updated but the mail still did not land: say so rather than let
  // them wait on another email that is not coming.
  return `I have corrected your email to ${r.newEmail}, but the link still did not go through. I have flagged it for the team and someone will get your access sorted with you here.`
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

  // THE WALL. The tool schema constrains the MODEL to canonical slugs, but a
  // direct executor call or a future model may pass free text. Resolve it to a
  // canonical slug first; if it cannot be resolved to exactly one tier, refuse
  // and show the menu so the vendor picks one we actually sell.
  const raw = (requestedTier || '').trim()
  const clean = resolveTierSlug(raw) || raw
  if (!TIER_META[clean]) {
    const menu = Object.entries(TIER_META)
      .map(([, m]) => `- ${m.label}, R${m.price.toLocaleString('en-ZA')}`)
      .join('\n')
    return `That is not one of our stall sizes, so I cannot log it. Here is everything we have:\n${menu}\n\nWhich one would you like? I will send it to the team for approval.`
  }

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
      body: `STALL CHANGE REQUEST via WhatsApp\nBusiness (on file): ${row.business_name}\nFrom: ${currentTier}\nWants: ${TIER_META[clean].label} (R${TIER_META[clean].price.toLocaleString('en-ZA')})\nReview at /admin/stall-changes`,
      audience: 'all',
      // Reaches the owner only for a vendor she owns (paid via Yoco/cash/waived).
      vendorId,
    })
  } catch (e) { console.error('[tool request_stall_change] notify failed:', (e as Error).message) }
  await flagNeedsHuman(session.waPhone, `stall change request: "${clean}"`)
  return `Done. I have submitted your request to change from ${currentTier} to "${clean}". The team will review it (stall changes affect pricing and placement, so a person confirms them) and get back to you. You can also track it in your portal.`
}


// Four vendors asked a HUMAN for this in the last nine days. The date is
// reviewed_at + 30, the same computePaymentDue the dashboard and the payments
// page already use, so there was never anything to escalate: the bot simply had
// no tool and could not see it.
async function getPaymentDueDate(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not load your application just now. Please try again shortly.'
  const { computePaymentDue, daysUntil, fmtDate } = await import('@/lib/exhibitor-paygate')

  // 1. Portal state is the live source of truth (payment reminders write here).
  const st = parsePortalState(row.admin_notes || '')
  let due: Date | null = st.payment?.due ? new Date(st.payment.due) : null
  if (due && isNaN(due.getTime())) due = null

  // 2. Fallback to explicit column / reviewed_at.
  if (!due) {
    due = computePaymentDue(row)
  }

  // 3. Final fallback: the APPROVED_NOTIFIED marker (set when the approval
  //    template went out) plus 30 days. This covers the common case where the
  //    application was approved but neither portal state nor reviewed_at are
  //    populated yet.
  if (!due && row.admin_notes) {
    const m = row.admin_notes.match(APPROVED_NOTIFIED_RE)
    if (m) {
      const notified = m[0].match(/:(\d{4}-\d{2}-\d{2}T[^⟧]+)/)?.[1]
      if (notified) {
        const d = new Date(notified)
        if (!isNaN(d.getTime())) {
          d.setDate(d.getDate() + 30)
          due = d
        }
      }
    }
  }

  if (!due) return 'I do not have a payment due date on your account yet. The team will confirm it with you.'
  if (st.payment?.status === 'paid' || st.payment?.status === 'collected') {
    return `Your stall fee is settled, thank you, so there is nothing outstanding. Your original due date was ${fmtDate(due)}.`
  }
  const n = daysUntil(due) ?? 0
  const when = n < 0
    ? `That was ${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ago, so it is overdue.`
    : n === 0 ? 'That is today.'
    : `That is ${n} day${n === 1 ? '' : 's'} from now.`
  return `Your stall fee is due on ${fmtDate(due)}. ${when} You can pay in your portal at ${PORTAL_LOGIN}.`
}

async function grantPaymentExtension(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not load your application just now. Please try again shortly.'
  const st = parsePortalState(row.admin_notes || '')
  if (st.payment?.status === 'paid' || st.payment?.status === 'collected') {
    return 'Your stall fee is already settled, thank you, so there is nothing to extend.'
  }
  // Persist the arrangement (deferral to 31 Aug) AND exclude from the EFT push,
  // so the reminder cron acknowledges the new date instead of chasing the old
  // one, and the vendor pays by card when ready (operator, 2026-08-10).
  const { grantExtension } = await import('@/lib/eft')
  await grantExtension(vendorId, '2026-08-31', 'extension to 31 Aug granted via WhatsApp')
  return "Done, you have until 31 August 2026 to settle your stall fee in full. Your spot stays reserved until then, just pay through Payments in your portal when you're ready."
}

async function whereIsMyStall(vendorId: string): Promise<string> {
  const row = await ownRow(vendorId)
  if (!row) return 'I could not load your application just now. Please try again shortly.'
  const alloc = parseAllocation(row.admin_notes || '')
  if (!alloc.stall) {
    return `Your stall has not been allocated yet, ${row.contact_name || 'you'} will get it once your payment is confirmed. You can check your portal at ${PORTAL_LOGIN} for updates.`
  }
  const geo = STALL_LIST.find((s) => s.code === alloc.stall)
  const zone = geo ? TYPE_META[geo.type]?.label : null
  const zoneLine = zone ? ` in the ${zone} zone` : ''
  return `Your stall is ${alloc.stall}${zoneLine}. You can see it on the map in your portal at ${PORTAL_LOGIN}.`
}

async function reportIssue(session: VendorSession, args: { issue_type?: string; description?: string }): Promise<string> {
  const vendorId = session.vendorId!
  const row = await ownRow(vendorId)
  if (!row) return 'I could not load your application just now. Please try again shortly.'
  const type = (args?.issue_type || 'other').trim()
  const description = (args?.description || '').trim()
  if (!description) return 'Tell me a bit more about what is going wrong so I can record it properly.'

  const category = ['payment', 'portal', 'documents', 'stall'].includes(type) ? type : 'other'
  const note = `[${category.toUpperCase()}] ${description}`

  // Self-service guidance for the common categories, while still logging the issue
  // so the team sees it if the vendor needs more help.
  let guidance = ''
  if (category === 'payment') {
    guidance = `For payment problems, the fastest fix is usually in your portal at ${PORTAL_LOGIN} under Payments. If the gateway is failing, try a different card or clear your browser.`
  } else if (category === 'portal') {
    guidance = `For login or portal issues, try a password reset at ${PORTAL_LOGIN} first. If that does not work, I have logged this for the team.`
  } else if (category === 'documents') {
    guidance = `You can upload your documents in your portal at ${PORTAL_LOGIN} under Documents. Make sure each file is under 10MB and is a PDF or image.`
  } else if (category === 'stall') {
    guidance = `I can check your stall allocation for you — just ask "where is my stall".`
  }

  await updatePortalState(vendorId, (s) => ({
    ...s,
    support: [...(s.support || []), { id: randomUUID(), from: 'vendor' as const, body: note, at: new Date().toISOString() }],
  }))

  // Notify owners for non-self-service or serious issues, but not for routine guidance.
  if (category === 'other' || category === 'stall') {
    await notifyOwners({
      event: 'vendor_support_message',
      body: `ISSUE REPORTED via WhatsApp\nBusiness (on file): ${row.business_name}\nType: ${category}\nNote: "${description.slice(0, 240)}"`,
      audience: 'all',
      vendorId,
    }).catch(() => {})
  }

  return guidance
    ? `I have noted that: "${description}". ${guidance}`
    : `I have noted that: "${description}". The team will follow up with you here if needed.`
}

// Canonical doc types accepted by the portal and admin document review flow.
const DOC_TYPES = ['halaal_cert', 'health_permit', 'gas_cert', 'fire_safety', 'public_liability', 'electrical_coc', 'contract', 'indemnity', 'other']
const MAX_DOC_BYTES = 5 * 1024 * 1024 // WhatsApp media fetch cap; portal allows 10MB, but we cannot fetch more than 5MB.

function extensionFrom(filename?: string, mimeType?: string): string {
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (ext) return ext
  }
  const map: Record<string, string> = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  }
  return map[mimeType?.toLowerCase() || ''] || 'bin'
}

function inferDocType(filename?: string, mimeType?: string): string {
  const text = `${filename || ''} ${mimeType || ''}`.toLowerCase()
  if (/halaal|halal|cert/.test(text) && !/liability|indemn/.test(text)) return 'halaal_cert'
  if (/health|permit|food/.test(text)) return 'health_permit'
  if (/gas/.test(text)) return 'gas_cert'
  if (/fire/.test(text)) return 'fire_safety'
  if (/liability|insurance/.test(text)) return 'public_liability'
  if (/electrical|elec|coa|coc/.test(text)) return 'electrical_coc'
  if (/contract/.test(text)) return 'contract'
  if (/indemn/.test(text)) return 'indemnity'
  return 'other'
}

export async function uploadDocument(session: VendorSession): Promise<string> {
  const vendorId = session.vendorId!
  const media = session.media
  if (!media || (media.kind !== 'image' && media.kind !== 'document')) {
    return `I do not see a document or photo to upload. Send the file here first, then say "upload it" and I will put it on your application.`
  }

  const fetched = await fetchMediaBytes(media.id)
  if (!fetched) {
    return `I could not fetch that file just now. It may be too large or the link expired. Please try uploading it in your portal at ${PORTAL_LOGIN} under Documents, or send it again.`
  }
  if (fetched.bytes.byteLength > MAX_DOC_BYTES) {
    return `That file is too large for me to fetch over WhatsApp. Please upload it in your portal at ${PORTAL_LOGIN} under Documents (up to 10MB there).`
  }

  const docType = inferDocType(media.filename, media.mimeType || fetched.contentType)
  const ext = extensionFrom(media.filename, media.mimeType || fetched.contentType)
  const safeName = (media.filename || `document-${Date.now()}.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)

  const db = createAdminClient()

  // LOGO ROUTING (2026-08-02, Taona: "if someone sends their logo or documents
  // the bot must upload them to their respective places, not still ask them
  // more questions"). A vendor with no logo yet who sends an IMAGE almost
  // always means it as their logo — especially right after the logo reminder.
  // Put it in the profile logo slot (same bucket + state as the portal logo
  // upload) instead of the generic Documents bucket, so they go live without
  // a second upload. Once a logo exists, further images stay documents.
  if (media.kind === 'image') {
    const { data: vrow } = await db
      .from('vendor_applications')
      .select('admin_notes')
      .eq('id', vendorId)
      .maybeSingle()
    const hasLogo = !!parsePortalState((vrow as { admin_notes?: string | null } | null)?.admin_notes || '').profile?.logo_path
    if (!hasLogo) {
      const logoPath = `${vendorId}/logo-${Date.now()}.${ext}`
      const { error: logoErr } = await db.storage.from('vendor-docs').upload(logoPath, fetched.bytes, {
        contentType: media.mimeType || fetched.contentType || `image/${ext}`,
        upsert: true,
      })
      if (logoErr) {
        console.error('[tool upload_document] logo upload failed:', logoErr.message)
        return `I could not save that logo just now. Please try uploading it in your portal at ${PORTAL_LOGIN} under Profile.`
      }
      await updatePortalState(vendorId, (s) => ({ ...s, profile: { ...(s.profile || {}), logo_path: logoPath } }))
      try {
        await db.from('site_events').insert({
          session_id: `vendor-${vendorId}`,
          event_type: 'profile_logo_uploaded',
          path: '/exhibitor/portal/profile',
          metadata: { vendor_application_id: vendorId, file_name: safeName, storage_path: logoPath, source: 'whatsapp' },
        })
      } catch { /* telemetry never blocks the reply */ }
      return `Done, jazakallah, your logo is uploaded and will show on your public profile. If your tagline/description is filled in on your portal Profile page, you are all set to go live in the sector listings.`
    }
  }

  const path = `${vendorId}/wa-${docType}-${Date.now()}.${ext}`
  const { error: upErr } = await db.storage.from('vendor-docs').upload(path, fetched.bytes, {
    contentType: media.mimeType || fetched.contentType || 'application/octet-stream',
    upsert: true,
  })
  if (upErr) {
    console.error('[tool upload_document] storage upload failed:', upErr.message)
    return `I could not save that file just now. Please try uploading it in your portal at ${PORTAL_LOGIN} under Documents.`
  }

  const record: DocRecord = {
    type: docType,
    path,
    name: safeName,
    status: 'pending',
    uploaded_at: new Date().toISOString(),
  }

  // Replace a previous doc of the same inferred type unless it is a catch-all
  // "other" upload, in which case we append so nothing is accidentally lost.
  await updatePortalState(vendorId, (s) => ({
    ...s,
    docs: docType === 'other'
      ? [...(s.docs || []), record]
      : [...(s.docs || []).filter((d) => d.type !== docType), record],
  }))

  // Mirror to the admin feed exactly like a portal upload would.
  try {
    await db.from('site_events').insert({
      session_id: `vendor-${vendorId}`,
      event_type: 'vendor_doc_uploaded',
      path: '/exhibitor/portal/documents',
      metadata: {
        vendor_application_id: vendorId,
        doc_type: docType,
        file_name: safeName,
        storage_path: path,
        source: 'whatsapp',
      },
    })
  } catch (e) {
    console.warn('[tool upload_document] site_events insert failed:', (e as Error).message)
  }

  // Notify owners, respecting lane scope (owner only sees her own vendors).
  try {
    const row = await ownRow(vendorId)
    await notifyOwners({
      event: 'document_uploaded',
      body: `New document uploaded via WhatsApp by ${row?.business_name || 'a vendor'}: ${docType}.`,
      audience: 'all',
      vendorId,
    })
  } catch (e) {
    console.error('[tool upload_document] notifyOwners failed:', (e as Error).message)
  }

  return `Thanks, I have uploaded your "${safeName}" to your portal Documents as ${docType.replace(/_/g, ' ')}. The team will review it and you can see it in your portal at ${PORTAL_LOGIN} under Documents.`
}

async function uploadEftProof(session: VendorSession): Promise<string> {
  const vendorId = session.vendorId!
  const media = session.media
  if (!media || (media.kind !== 'image' && media.kind !== 'document')) {
    return `I do not see a photo or PDF to upload. Send your proof of payment here first, then say "upload my proof" and I will pass it to the finance team.`
  }

  const fetched = await fetchMediaBytes(media.id)
  if (!fetched) {
    return `I could not fetch that file just now. It may be too large or the link expired. Please upload it in your portal at ${PORTAL_LOGIN} under Payments, or send it again.`
  }
  if (fetched.bytes.byteLength > MAX_DOC_BYTES) {
    return `That file is too large for me to fetch over WhatsApp. Please upload it in your portal at ${PORTAL_LOGIN} under Payments (up to 10MB there).`
  }

  const row = await ownRow(vendorId)
  if (!row) return 'I could not find your application just now. Please try again shortly.'

  const result = await recordEftProof({
    applicationId: vendorId,
    admin_notes: row.admin_notes,
    paid_at: null,
    email: row.email,
    phone: session.waPhone,
    business_name: row.business_name,
    contact_name: row.contact_name,
    file: { bytes: Buffer.from(fetched.bytes), name: media.filename, type: media.mimeType || fetched.contentType },
    source: 'whatsapp',
    // Capture the proof whatever the lane state (a card-only vendor may have paid
    // by EFT anyway); storage only, no lane marker, so Samreen's wall is untouched.
    // Removes the old 403 dead-end that told a stuck vendor to go to a portal they
    // often cannot reach.
    captureRegardless: true,
  })

  if (!result.ok) {
    return `Thanks, I've received your proof but couldn't file it automatically (${result.error}). I've noted it and the team will pick it up, they'll be in touch here.`
  }

  return `Jazakallah, I have received your proof of payment and passed it to the finance team. You will get a confirmation once it is checked against the account. You can also see it in your portal at ${PORTAL_LOGIN} under Payments.`
}

// Taona 2026-07-29, verbatim: "anytime a person text bot to withdraw or cancel
// it should ask why if its not mentioned, and then mentioned i will withdraw u
// now, confirm and thnen it does it then sends an email to them, samreen and
// also inform me master".
//
// The two gates below are the whole safety story. `confirmed` is set by the
// model only after the vendor says yes in their own words, and a PAID vendor is
// never withdrawn automatically because their money raises a refund question no
// rule here can answer.
async function withdrawSelf(session: VendorSession, args: { reason?: string; confirmed?: boolean }): Promise<string> {
  const vendorId = session.vendorId!
  const reason = (args?.reason || '').trim()
  if (!reason) return 'Before I do that, may I ask what is making you withdraw? It helps the team, and sometimes there is something we can sort out for you.'
  if (args?.confirmed !== true) {
    return `Just to be certain, I will withdraw you from the Young at Heart Festival 2026 and release your slot. Please reply to confirm and I will do it now.`
  }

  const row = await ownRow(vendorId)
  if (!row) return 'I could not load your application just now. Please try again shortly.'

  const { createAdminClient } = await import('@/lib/supabase/admin')
  const { withdrawApplication } = await import('@/lib/vendors/withdraw')
  const db = createAdminClient()
  const biz = String((row as { business_name?: string }).business_name || 'your business')
  const email = (row as { email?: string }).email || null

  const res = await withdrawApplication(db, {
    applicationId: vendorId, reason, actorEmail: email, actorRole: 'vendor',
  })

  if (!res.ok && res.reason === 'paid_needs_human') {
    await escalateToHuman(session, `WITHDRAWAL from a PAID vendor (${biz}): "${reason}". Needs a refund decision before anything is cancelled.`).catch(() => {})
    return 'Because your stall fee is already paid, a person needs to handle the refund side with you so nothing goes wrong with your payment. I have passed it to the team and they will come back to you here.'
  }
  if (!res.ok && res.reason === 'already_withdrawn') {
    return 'You are already withdrawn from the festival, so there is nothing further to do. If you are still getting messages from us, tell me and I will get that stopped.'
  }
  if (!res.ok) return 'I could not complete that just now. I have let the team know and they will follow up with you here.'

  // Tell the vendor by email, tell the festival owner, tell the master.
  const { sendEmail } = await import('@/lib/email/resend')
  await sendEmail({
    to: email || '',
    subject: `Your Young at Heart Festival 2026 application has been withdrawn, ${biz}`,
    text: `Hi,\n\nWe have withdrawn ${biz} from the Young at Heart Festival 2026 as you requested, and your slot has been released.\n\nReason recorded: ${reason}\n\nIf this was not what you wanted, or you change your mind, reply to this email or message us on WhatsApp and we will help.\n\nWe are sorry to see you go, and you are welcome to apply again in future.\n\nWarm regards,\nThe Young at Heart Festival Team`,
  }).catch(() => {})

  await notifyOwners({
    event: 'system_alert',
    audience: 'all',
    body: `${biz} has WITHDRAWN from the festival via WhatsApp. Reason: "${reason}".${res.freedStalls.length ? ` Slot ${res.freedStalls.join(', ')} released.` : ''}`,
  }).catch(() => {})

  return `That is done. I have withdrawn ${biz} from the Young at Heart Festival 2026 and released your slot, and I have emailed you a confirmation. We are sorry to see you go, and you are very welcome to apply again another year.`
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
      case 'get_electrical_setup': content = await getElectricalSetup(session.vendorId!); break
      case 'send_contract':
        deferred = sendContractDeferred(session)
        content = await contractStatusLine(session.vendorId!)
        break
      case 'sign_contract':
        content = await signContract(session, (args as { print_name?: string })?.print_name || '')
        break
      case 'get_logo_upload_link': content = getLogoUploadLink(); break
      case 'start_verification': content = await startVerification(session, (args as { email?: string })?.email || ''); break
      case 'request_password_reset': content = await requestPasswordReset(session); break
      case 'update_my_email': content = await updateMyEmail(session, (args as { email?: string })?.email || ''); break
      case 'request_stall_change': content = await requestStallChange(session, (args as { requested_tier?: string })?.requested_tier || ''); break
      case 'get_payment_due_date': content = await getPaymentDueDate(session.vendorId!); break
      case 'grant_payment_extension': content = await grantPaymentExtension(session.vendorId!); break
      case 'withdraw_application': content = await withdrawSelf(session, (args as { reason?: string; confirmed?: boolean })); break
      case 'where_is_my_stall': content = await whereIsMyStall(session.vendorId!); break
      case 'report_issue': content = await reportIssue(session, args as { issue_type?: string; description?: string }); break
      case 'upload_document': content = await uploadDocument(session); break
      case 'upload_eft_proof': content = await uploadEftProof(session); break
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
