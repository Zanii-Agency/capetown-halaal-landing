// MASTER tool registry + executor: the operator (Taona) brain's tools.
//
// THE WALL, master edition. executeMasterTool refuses every tool unless the
// caller's role is 'master' (only Taona's own number resolves to that in
// admins.ts). These tools read ACROSS vendors on purpose: the operator is
// allowed to see the whole festival. That is the exact opposite of the vendor
// registry (tools/registry.ts), which is walled to session.vendorId. Keep the
// two registries separate so a vendor path can NEVER reach a cross-vendor read.
//
// READ + DRAFT ONLY. Nothing here sends a message to a vendor, flips a payment,
// or mutates vendor data. The brain answers questions and can draft a reply in
// its own text; actually sending stays on the operator's explicit SEND / swipe
// path. So the blast radius is a read, never a write.

import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation, tierLabel, STALL_LIST, TYPE_META, type StallStatus } from '@/lib/stalls'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { computePaymentDue, fmtDate } from '@/lib/exhibitor-paygate'
import { segmentCount, SEGMENT_LABELS, type SegmentKey } from '@/lib/bot/segments'
import { hasEftMarker, vendorInOwnerScope, revealsPaymentArrangement } from '@/lib/eft'
import { pendingStallChangeRequests } from '@/lib/stall-change-action'
import { APPROVED_NOTIFIED_RE } from '@/lib/applications/decision-notify'

export const MASTER_TOOL_DEFS = [
  {
    name: 'find_vendors',
    description:
      "Look up vendors by name, business, email, or phone and return their application status, payment status, amount outstanding, days overdue, allocated stall, and EFT-lane state. Call this whenever Taona asks about a specific vendor or a small group (\"is X approved\", \"what does Y owe\", \"has Z paid\", \"find the Turkish stall\").",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', description: 'A name, business name, email, or phone fragment to search for.' } },
      required: ['query'],
    },
  },
  {
    name: 'pipeline_numbers',
    description:
      'Return live counts across the whole pipeline: pending applications, approved, approved-and-paid, approved-and-unpaid, info-requested, rejected, and ticket buyers. Call when Taona asks how many vendors are in a state, how the numbers look, or a summary of where things stand.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'vendor_conversation',
    description:
      "Return the recent WhatsApp + email history for ONE vendor (by their vendor_id from find_vendors), most recent last, so you can draft a reply that fits what was actually said. Call before drafting a reply to a specific vendor.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { vendor_id: { type: 'string', description: 'The vendor_id returned by find_vendors.' } },
      required: ['vendor_id'],
    },
  },
  {
    name: 'eft_lane_activity',
    description:
      "List vendors actively engaging the EFT payment lane, with timestamps, most recent first: who OPENED / revealed the bank details (a signal they are about to pay), who UPLOADED a proof (awaiting Taona's reconcile), and who is on the Master lane. Call whenever Taona asks who opened or revealed the bank details, who is about to pay, who uploaded proof, who paid recently / last night on EFT, or what is happening on the EFT or Master lane.",
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'pending_stall_changes',
    description:
      'List every vendor with a pending stall-size or stall-position change request, showing current tier, requested tier, reason, and move details. Call when Taona asks what stall changes are waiting, who wants a different size, or who asked to move position.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'stall_occupancy',
    description:
      'Return the full stall occupancy map: which stalls are allocated/held/reserved/blocked and to which vendor, and which are still available. Call when Taona asks what stalls are free, who is on a specific stall, or for a floor-plan summary.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'vendor_documents',
    description:
      "List a single vendor's uploaded documents from their portal state: type, filename, status (pending/approved/rejected), and upload time. Call when Taona asks what docs a vendor uploaded, whether their documents are approved, or what is missing.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { vendor_id: { type: 'string', description: 'The vendor_id returned by find_vendors.' } },
      required: ['vendor_id'],
    },
  },
  {
    name: 'vendor_staff',
    description:
      "List a single vendor's registered staff members from their portal state: name, role, phone, ID number, vehicle registration, and badge order status. Call when Taona asks who a vendor registered, how many staff passes they have, or whether badges were ordered.",
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { vendor_id: { type: 'string', description: 'The vendor_id returned by find_vendors.' } },
      required: ['vendor_id'],
    },
  },
  {
    name: 'vendor_login_activity',
    description:
      'List vendor portal logins and recent portal activity for a specific date. Call when Taona asks "who logged in on the 31st", "who logged in yesterday", "what did vendors do today", or any question about vendor login/activity history. The date can be a day like "31", "31 July", "2026-07-31", "today", or "yesterday".',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { date: { type: 'string', description: 'The date to look up: day-of-month (e.g. "31"), "today", "yesterday", or an ISO date like "2026-07-31".' } },
      required: ['date'],
    },
  },
] as const

export interface MasterToolOutcome { content: string; isError?: boolean }

// ── THE FESTIVAL OWNER'S SUBSET ──────────────────────────────────────────────
//
// Taona 2026-07-28: "whenever she texts the bot u an help her with info sh
// needs as long as it deosnt open eft lane". So she gets the same brain, over a
// strictly smaller world.
//
// AN ALLOW-LIST, NOT A DENY-LIST. Naming what she MAY call means a tool added
// to MASTER_TOOL_DEFS later is invisible to her until someone adds it here on
// purpose. A deny-list would expose every future tool by default and rely on
// the author remembering this file exists. That is the exact shape of the leak
// on the morning of 2026-07-28: thirteen inbox readers were patched by hand and
// the fourteenth surface served bank notices to her for hours.
//
// eft_lane_activity is absent DELIBERATELY. Do not add it.
const OWNER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'find_vendors',        // scoped to her vendors, EFT posture stripped
  'pipeline_numbers',    // aggregate counts: pipeline, never payment posture
  'vendor_conversation', // her vendors only, EFT messages stripped
])

/** The tool definitions this role may see. The festival owner is never even
 *  TOLD eft_lane_activity exists: a model cannot call a tool absent from its
 *  schema, so this is a second, independent wall in front of executeMasterTool's
 *  authorisation check rather than a restatement of it. */
export function toolDefsForRole(role: string) {
  if (role === 'master') return MASTER_TOOL_DEFS
  return MASTER_TOOL_DEFS.filter((t) => OWNER_TOOL_NAMES.has(t.name))
}

export type VRow = {
  id: string; business_name: string | null; contact_name: string | null; email: string | null
  phone: string | null; status: string | null; admin_notes: string | null; paid_at: string | null
  preferred_booth_tier: string | null; special_requirements: unknown; reviewed_at: string | null
  payment_due_date: string | null
}

const DAY = 86400000

/** Extract the approval timestamp from the APPROVED_NOTIFIED marker, if present. */
function approvedAtFromNotes(admin_notes: string | null): Date | null {
  if (!admin_notes) return null
  const m = admin_notes.match(APPROVED_NOTIFIED_RE)
  if (!m) return null
  const ts = m[0].match(/:(\d{4}-\d{2}-\d{2}T[^⟧]+)/)?.[1]
  if (!ts) return null
  const d = new Date(ts)
  return isNaN(d.getTime()) ? null : d
}

export function vendorSummary(r: VRow, ownerScoped = false): string {
  const state = parsePortalState(r.admin_notes || '')
  const pay = state.payment
  const paid = !!r.paid_at || pay?.status === 'paid'
  let total = 0
  try { total = computeVendorPricing({ preferred_booth_tier: r.preferred_booth_tier as string, special_requirements: r.special_requirements }).total } catch { /* keep 0 */ }
  const received = Number(pay?.amount) || 0
  const outstanding = Math.max(0, total - received)
  const alloc = parseAllocation(r.admin_notes || '')

  // DUE DATE: portal state override → computePaymentDue (explicit column or
  // reviewed_at + 30 days) → APPROVED_NOTIFIED marker + 30 days. This matches
  // the vendor dashboard and the vendor bot so the master brain never says "no
  // due date" while the vendor's own portal shows one.
  let due: Date | null = pay?.due ? new Date(pay.due) : null
  if (due && isNaN(due.getTime())) due = null
  if (!due) {
    due = computePaymentDue({ payment_due_date: r.payment_due_date, reviewed_at: r.reviewed_at })
  }
  if (!due) {
    const approvedAt = approvedAtFromNotes(r.admin_notes)
    if (approvedAt) {
      approvedAt.setDate(approvedAt.getDate() + 30)
      due = approvedAt
    }
  }
  let dueLine = ''
  let overdue = ''
  if (!paid && due && !isNaN(due.getTime())) {
    const left = Math.ceil((due.getTime() - Date.now()) / DAY)
    dueLine = `, stall fee due ${fmtDate(due)}${left >= 0 ? ` (${left} day${left === 1 ? '' : 's'} left)` : ''}`
    if (left < 0) overdue = `, ${Math.abs(left)} day${Math.abs(left) === 1 ? '' : 's'} overdue`
  }
  // Every branch below names the EFT arrangement, which is the one thing the
  // festival owner must never learn. She only reaches this function for vendors
  // already inside her scope, so in practice these are all empty for her; the
  // guard is here because "in practice" is not a wall.
  const eft = ownerScoped ? ''
    : hasEftMarker(r.admin_notes) ? ', on the Master lane (⟦EFT⟧)'
    : pay?.eft_submitted_at ? ', EFT proof uploaded (pending reconcile)'
    : pay?.eft_revealed_at ? ', revealed EFT details (likely paying)' : ''
  const payLine = paid
    ? `PAID${received ? ` (R${received})` : ''}`
    : `UNPAID${total ? `, R${outstanding} outstanding of R${total}` : ''}${dueLine}${overdue}`
  return `${r.business_name || 'Unnamed'} (${r.contact_name || 'no contact'}, ${r.email || 'no email'}, ${r.phone || 'no phone'}) [vendor_id ${r.id}]: application ${r.status || 'unknown'}, ${payLine}, stall ${alloc.stall || 'not allocated'}${r.preferred_booth_tier ? ` (${tierLabel(r.preferred_booth_tier)})` : ''}${eft}.`
}

/**
 * Character-insensitive normalisation for vendor matching. The straight vs
 * curly apostrophe cost the master a live lookup: the row is stored as
 * "It’s SnackTime" (U+2019) and a search for "It's SnackTime" (U+0027)
 * returned zero rows, so the brain concluded the vendor did not exist while
 * the login alert for them was still warm in the chat (2026-08-01).
 */
export function normalizeVendorText(s: string | null | undefined): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[^\p{L}\p{N}\s@.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
}

/** True when any of the vendor's name/contact/email/phone fields contains the
 *  (already normalised) query, or the query contains a full field for short
 *  lookups. Pure: unit-tested without a DB. */
export function vendorMatchesQuery(
  row: { business_name?: string | null; contact_name?: string | null; email?: string | null; phone?: string | null },
  normQuery: string,
): boolean {
  if (!normQuery) return false
  const fields = [row.business_name, row.contact_name, row.email, row.phone].map(normalizeVendorText)
  for (const f of fields) {
    if (!f) continue
    if (f.includes(normQuery)) return true
    // Short query fully covered by one field word ("snacktime" in "it s snacktime"
    // is handled above; this covers field-inside-query like "hoosain allie cth").
    if (normQuery.includes(f) && f.length >= 4) return true
  }
  // Token overlap: every query token of 4+ chars appears in some field.
  const tokens = normQuery.split(' ').filter((t) => t.length >= 4)
  if (tokens.length && tokens.every((t) => fields.some((f) => f.includes(t)))) return true
  return false
}

async function findVendors(query: string, ownerScoped = false): Promise<string> {
  const q = (query || '').trim()
  if (!q) return 'Give me a name, business, email, or phone to search for.'
  const db = createAdminClient()
  // Strip PostgREST-structural characters as well as wildcards: a comma, paren
  // or dot in the query can break the .or() filter string (same misparse class
  // as the +27 wa_phone bug fixed 2026-08-01).
  const like = `%${q.replace(/[%_,().]/g, '')}%`
  // Filter AFTER the query, not with a WHERE clause: the lane lives in markers
  // on admin_notes plus paid_at, and vendorInOwnerScope is the single canonical
  // predicate for it. Re-expressing that as PostgREST filters would be a second
  // implementation of the rule, free to drift from the one every other surface
  // uses. Over-fetch instead and let the predicate decide.
  const { data } = await db
    .from('vendor_applications')
    // NO payment_due_date: the column does not exist on this project (DDL is
    // blocked, Law 8) and selecting it fails the WHOLE query with 42703, which
    // read downstream as "No vendor matches" for every search. The due date is
    // computed from reviewed_at + 30 by computePaymentDue instead.
    .select('id, business_name, contact_name, email, phone, status, admin_notes, paid_at, preferred_booth_tier, special_requirements, reviewed_at')
    .or(`business_name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
    .limit(ownerScoped ? 40 : 12)
  let rows = (data || []) as VRow[]

  // FUZZY FALLBACK. The direct query is character-literal: curly apostrophes,
  // diacritics, doubled spaces and case all defeat it, and a zero result then
  // reads to the brain as "this vendor does not exist". Only fires when the
  // direct query found nothing, so every search that works today is unchanged.
  if (!rows.length) {
    const nq = normalizeVendorText(q)
    // Broadest distinctive anchor: the longest word of 4+ letters.
    const anchor = nq.split(' ').filter((t) => t.length >= 4).sort((a, b) => b.length - a.length)[0]
    if (anchor) {
      const broad = `%${anchor.replace(/[%_,().]/g, '')}%`
      const { data: candidates } = await db
        .from('vendor_applications')
        .select('id, business_name, contact_name, email, phone, status, admin_notes, paid_at, preferred_booth_tier, special_requirements, reviewed_at')
        .or(`business_name.ilike.${broad},contact_name.ilike.${broad},email.ilike.${broad}`)
        .limit(50)
      rows = ((candidates || []) as VRow[]).filter((r) => vendorMatchesQuery(r, nq))
    }
  }

  if (ownerScoped) rows = rows.filter((r) => vendorInOwnerScope(r.admin_notes, r.paid_at))
  rows = rows.slice(0, 12)
  if (!rows.length) {
    // Say nothing about WHY a match was withheld. "Outside your lane" tells her
    // a lane exists (Taona 2026-07-27: "she doesnt need to know about any
    // lane"), so a filtered-out vendor must be indistinguishable from no vendor.
    return `No vendor matches "${q}".`
  }
  const head = rows.length === 1 ? '1 match:' : `${rows.length} matches${rows.length === 12 ? ' (showing first 12, narrow the search)' : ''}:`
  return `${head}\n` + rows.map((r) => `- ${vendorSummary(r, ownerScoped)}`).join('\n')
}

async function pipelineNumbers(): Promise<string> {
  const keys: SegmentKey[] = ['pending', 'approved', 'approved_paid', 'approved_unpaid', 'info_requested', 'rejected', 'ticket_buyers']
  const counts = await Promise.all(keys.map(async (k) => `${SEGMENT_LABELS[k]}: ${await segmentCount(k)}`))
  return counts.join('\n')
}

async function vendorConversation(vendorId: string, ownerScoped = false): Promise<string> {
  const db = createAdminClient()
  const { data: v } = await db.from('vendor_applications').select('business_name, phone, email, admin_notes, paid_at').eq('id', vendorId).single()
  if (!v) return `No vendor with id ${vendorId}.`
  // A vendor id is guessable and the brain sees ids in find_vendors output, so
  // re-check the scope here rather than trusting that she could only have got
  // this id from a list we already filtered.
  if (ownerScoped && !vendorInOwnerScope(v.admin_notes as string | null, v.paid_at as string | null)) {
    return `No vendor with id ${vendorId}.` // same answer as absent, on purpose
  }
  let lines: Array<{ at: string; who: string; body: string }> = []
  const phone = (v.phone as string || '').replace(/^\+/, '')
  if (phone) {
    const { data: wa } = await db
      .from('wa_messages')
      .select('direction, body, created_at')
      .in('wa_phone', [`+${phone}`, phone])
      .order('created_at', { ascending: false })
      .limit(12)
    for (const m of (wa || []) as Array<{ direction: string; body: string | null; created_at: string }>) {
      const raw = (m.body || '').trim()
      if (!raw || /^\s*\[[A-Z_]+[:\]]/.test(raw) || /HUMAN_HANDOVER/.test(raw) || /^\s*🛎/u.test(raw)) continue
      lines.push({ at: m.created_at, who: m.direction === 'in' ? 'vendor' : 'us', body: raw.slice(0, 240) })
    }
  }
  const email = (v.email as string || '').toLowerCase()
  if (email) {
    const { data: threads } = await db.from('support_inbox_threads').select('id').ilike('peer_email', email)
    const ids = (threads || []).map((t) => t.id)
    if (ids.length) {
      const { data: msgs } = await db
        .from('support_inbox_messages')
        .select('direction, body_text, subject, received_at')
        .in('thread_id', ids)
        .order('received_at', { ascending: false })
        .limit(12)
      for (const m of (msgs || []) as Array<{ direction: string; body_text: string | null; subject: string | null; received_at: string }>) {
        const body = (m.body_text || m.subject || '').trim()
        if (!body) continue
        lines.push({ at: m.received_at, who: m.direction === 'in' ? 'vendor' : 'us', body: body.slice(0, 240) })
      }
    }
  }
  // A vendor in her scope can still have EFT wording in their history: someone
  // who asked about a bank transfer before settling by card, or the bot's own
  // reply about it. The vendor-level check above does not catch that, so the
  // message level gets its own pass, using the same mentionsEft predicate the
  // inbox and the alert router use so the three cannot drift.
  const kept = ownerScoped ? lines.filter((l) => !revealsPaymentArrangement(l.body)) : lines
  if (!kept.length) return `No conversation on file for ${v.business_name || vendorId}.`
  lines = kept
  lines.sort((a, b) => +new Date(a.at) - +new Date(b.at))
  return `Recent thread with ${v.business_name || vendorId} (oldest first):\n` + lines.map((l) => `[${l.at.slice(0, 16).replace('T', ' ')}] ${l.who}: ${l.body}`).join('\n')
}

// Who is actively on the EFT lane: revealed the bank details (about to pay),
// uploaded a proof (awaiting reconcile), or was added to the Master lane. This is
// the tool that answers "anyone opened the bank details / who is about to pay /
// who uploaded proof". Reads the same portal-state stamps the reveal button
// (eft_revealed_at) and proof upload (eft_submitted_at) write. Excludes reconciled
// vendors (paid). Timestamps are ISO/UTC so the brain can reason about "last night".
async function eftLaneActivity(): Promise<string> {
  const db = createAdminClient()
  const { data } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, phone, admin_notes, paid_at, preferred_booth_tier, special_requirements')
    .limit(2000)
  const rows = (data || []) as VRow[]
  type Act = { name: string; phone: string | null; state: string; at: string | null; rank: number; sortAt: number }
  const acts: Act[] = []
  for (const r of rows) {
    if (r.paid_at) continue
    const p = parsePortalState(r.admin_notes || '').payment
    if (p?.status === 'paid') continue
    const submitted = p?.eft_submitted_at
    const revealed = p?.eft_revealed_at
    const marked = hasEftMarker(r.admin_notes)
    if (!submitted && !revealed && !marked) continue
    // rank: proof uploaded (needs your action) first, then revealed, then just added.
    let state: string, at: string | null, rank: number
    if (submitted) { state = 'proof UPLOADED, awaiting your reconcile'; at = submitted; rank = 0 }
    else if (revealed) { state = 'OPENED the bank details, likely about to pay'; at = revealed; rank = 1 }
    else { state = 'on the Master lane (has not opened the details yet)'; at = null; rank = 2 }
    acts.push({ name: r.business_name || 'Unnamed', phone: r.phone, state, at, rank, sortAt: at ? new Date(at).getTime() : 0 })
  }
  if (!acts.length) return 'No vendor has opened the EFT bank details, uploaded a proof, or been added to the Master lane yet.'
  acts.sort((a, b) => a.rank - b.rank || b.sortAt - a.sortAt)
  const line = (a: Act) => `- ${a.name}${a.phone ? ` (${a.phone})` : ''}: ${a.state}${a.at ? ` at ${a.at.slice(0, 16).replace('T', ' ')} UTC` : ''}`
  return `${acts.length} vendor${acts.length === 1 ? '' : 's'} active on the EFT lane:\n` + acts.map(line).join('\n')
}

// Build the occupancy map from every vendor's stall marker. Codes not held by
// anyone are available. Held/allocated/reserved/blocked are all shown so Taona
// can see the real floor state.
async function stallOccupancy(): Promise<string> {
  const db = createAdminClient()
  const { data } = await db
    .from('vendor_applications')
    .select('business_name, admin_notes')
    .limit(2000)
  const held = new Map<string, { vendor: string; status: StallStatus }>()
  for (const r of (data || []) as Array<{ business_name: string | null; admin_notes: string | null }>) {
    const alloc = parseAllocation(r.admin_notes)
    if (!alloc.stalls.length) continue
    for (const code of alloc.stalls) {
      held.set(code, { vendor: r.business_name || 'Unnamed', status: alloc.status })
    }
  }

  const typeOrder: Array<'FT' | 'FS' | 'TS' | 'BS'> = ['FT', 'FS', 'TS', 'BS']
  const lines: string[] = []
  for (const type of typeOrder) {
    const stalls = STALL_LIST.filter((s) => s.type === type)
    const free = stalls.filter((s) => !held.has(s.code)).length
    lines.push(`${TYPE_META[type].label} (${type}): ${free}/${stalls.length} free`)
    for (const s of stalls) {
      const h = held.get(s.code)
      if (h) lines.push(`  ${s.code}: ${h.status} — ${h.vendor}`)
    }
  }
  const totalFree = STALL_LIST.length - held.size
  lines.unshift(`Total stalls: ${STALL_LIST.length}, ${held.size} held, ${totalFree} available.`)
  return lines.join('\n')
}

async function vendorDocuments(vendorId: string): Promise<string> {
  const db = createAdminClient()
  const { data: v } = await db.from('vendor_applications').select('business_name, admin_notes').eq('id', vendorId).single()
  if (!v) return `No vendor with id ${vendorId}.`
  const docs = parsePortalState(v.admin_notes).docs || []
  if (!docs.length) return `${v.business_name || 'Vendor'} has no documents uploaded yet.`
  return `${v.business_name || 'Vendor'} documents:\n` + docs.map((d) =>
    `- ${d.type}${d.name ? ` (${d.name})` : ''}: ${d.status}${d.note ? ` — note: ${d.note}` : ''}, uploaded ${d.uploaded_at.slice(0, 16).replace('T', ' ')}`
  ).join('\n')
}

async function vendorStaff(vendorId: string): Promise<string> {
  const db = createAdminClient()
  const { data: v } = await db.from('vendor_applications').select('business_name, admin_notes').eq('id', vendorId).single()
  if (!v) return `No vendor with id ${vendorId}.`
  const staff = parsePortalState(v.admin_notes).staff || []
  if (!staff.length) return `${v.business_name || 'Vendor'} has no staff registered yet.`
  return `${v.business_name || 'Vendor'} staff (${staff.length}):\n` + staff.map((s) => {
    const badge = s.revoked_at ? 'revoked' : s.wc_order_id ? 'ordered' : 'pending'
    const checkedIn = s.checked_in_at ? ', checked in' : ''
    return `- ${s.name}${s.role ? ` (${s.role})` : ''}: ${s.id_number}${s.phone ? `, ${s.phone}` : ''}${s.vehicle_reg ? `, vehicle ${s.vehicle_reg}` : ''} — badge ${badge}${checkedIn}`
  }).join('\n')
}

function resolveDateRange(phrase: string): { start: Date; end: Date; label: string } | null {
  const now = new Date()
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  const p = (phrase || '').trim().toLowerCase()

  if (p === 'today') {
    return { start: today, end: new Date(today.getTime() + 86400000), label: 'today' }
  }
  if (p === 'yesterday') {
    const y = new Date(today.getTime() - 86400000)
    return { start: y, end: today, label: 'yesterday' }
  }

  // ISO date: 2026-07-31
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
    const d = new Date(`${p}T00:00:00Z`)
    if (!isNaN(d.getTime())) {
      return { start: d, end: new Date(d.getTime() + 86400000), label: p }
    }
  }

  // Day-of-month: "31" → current month/year
  const dayOnly = /^\d{1,2}$/.exec(p)
  if (dayOnly) {
    const day = parseInt(dayOnly[0], 10)
    if (day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), day))
      if (!isNaN(d.getTime())) {
        return { start: d, end: new Date(d.getTime() + 86400000), label: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
      }
    }
  }

  // "31 July" / "July 31" / "31 jul"
  const monthDay = /^(\d{1,2})\s+([a-z]{3,})$/.exec(p)
  const dayMonth = /^([a-z]{3,})\s+(\d{1,2})$/.exec(p)
  const parsed = monthDay ? { day: parseInt(monthDay[1], 10), month: monthDay[2] }
    : dayMonth ? { day: parseInt(dayMonth[2], 10), month: dayMonth[1] }
    : null
  if (parsed) {
    const monthIdx = new Date(`${parsed.month} 1, 2000`).getMonth()
    if (!isNaN(monthIdx) && parsed.day >= 1 && parsed.day <= 31) {
      const d = new Date(Date.UTC(now.getFullYear(), monthIdx, parsed.day))
      return { start: d, end: new Date(d.getTime() + 86400000), label: `${now.getFullYear()}-${String(monthIdx + 1).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}` }
    }
  }

  return null
}

async function vendorLoginActivity(datePhrase: string): Promise<string> {
  const range = resolveDateRange(datePhrase)
  if (!range) return `I did not understand the date "${datePhrase}". Try "31", "31 July", "2026-07-31", "today", or "yesterday".`

  const db = createAdminClient()
  const { data: events } = await db
    .from('site_events')
    .select('created_at, metadata')
    .eq('event_type', 'vendor_login')
    .gte('created_at', range.start.toISOString())
    .lt('created_at', range.end.toISOString())
    .order('created_at', { ascending: false })
    .limit(500)

  const logins = (events || []) as Array<{ created_at: string; metadata: { business_name?: string; application_id?: string; ip?: string | null; place?: string; source?: string } | null }>
  if (!logins.length) return `No vendor portal logins recorded for ${range.label}.`

  const dubaiTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const dubaiDate = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    day: 'numeric',
    month: 'short',
  })

  const lines = logins.map((e) => {
    const m = e.metadata || {}
    const biz = m.business_name || 'Unnamed vendor'
    const at = new Date(e.created_at)
    const time = dubaiTime.format(at)
    const date = dubaiDate.format(at)
    const place = m.place || 'unknown location'
    const source = m.source || 'portal'
    return `- ${time} UAE (${date}) · ${biz} · ${place}${m.ip ? ` · ${m.ip}` : ''} · via ${source}`
  })

  return `${logins.length} vendor login${logins.length === 1 ? '' : 's'} on ${range.label}:\n` + lines.join('\n')
}

/**
 * Execute a master tool. THE WALL: refuses unless role === 'master'. Every tool
 * here reads across vendors, so a non-master caller (festival_owner, vendor,
 * anything) is denied before any query runs. Read-only; never sends or mutates.
 */
export async function executeMasterTool(role: string, name: string, args: unknown): Promise<MasterToolOutcome> {
  // The festival owner is admitted to the allow-listed tools only, and every
  // one of them runs owner-scoped. Any other role, and any tool she is not
  // named for (eft_lane_activity), is refused before a query runs.
  const isMaster = role === 'master'
  const ownerScoped = role === 'festival_owner'
  if (!isMaster && !(ownerScoped && OWNER_TOOL_NAMES.has(name))) {
    return { content: 'Not authorised.', isError: true }
  }
  try {
    switch (name) {
      case 'find_vendors': return { content: await findVendors((args as { query?: string })?.query || '', ownerScoped) }
      case 'pipeline_numbers': return { content: await pipelineNumbers() }
      case 'vendor_conversation': return { content: await vendorConversation((args as { vendor_id?: string })?.vendor_id || '', ownerScoped) }
      case 'eft_lane_activity': return { content: await eftLaneActivity() }
      case 'pending_stall_changes': return { content: await pendingStallChangeRequests() }
      case 'stall_occupancy': return { content: await stallOccupancy() }
      case 'vendor_documents': return { content: await vendorDocuments((args as { vendor_id?: string })?.vendor_id || '') }
      case 'vendor_staff': return { content: await vendorStaff((args as { vendor_id?: string })?.vendor_id || '') }
      case 'vendor_login_activity': return { content: await vendorLoginActivity((args as { date?: string })?.date || '') }
      default: return { content: `Unknown tool: ${name}`, isError: true }
    }
  } catch (e) {
    console.error('[master-tool] failed:', name, (e as Error).message)
    return { content: 'That lookup failed. Try again or check the admin dashboard.', isError: true }
  }
}
