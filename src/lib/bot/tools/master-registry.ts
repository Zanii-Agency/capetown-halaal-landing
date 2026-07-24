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
import { parseAllocation, tierLabel } from '@/lib/stalls'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { segmentCount, SEGMENT_LABELS, type SegmentKey } from '@/lib/bot/segments'
import { hasEftMarker } from '@/lib/eft'

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
] as const

export interface MasterToolOutcome { content: string; isError?: boolean }

type VRow = {
  id: string; business_name: string | null; contact_name: string | null; email: string | null
  phone: string | null; status: string | null; admin_notes: string | null; paid_at: string | null
  preferred_booth_tier: string | null; special_requirements: unknown
}

const DAY = 86400000

function vendorSummary(r: VRow): string {
  const state = parsePortalState(r.admin_notes || '')
  const pay = state.payment
  const paid = !!r.paid_at || pay?.status === 'paid'
  let total = 0
  try { total = computeVendorPricing({ preferred_booth_tier: r.preferred_booth_tier as string, special_requirements: r.special_requirements }).total } catch { /* keep 0 */ }
  const received = Number(pay?.amount) || 0
  const outstanding = Math.max(0, total - received)
  const alloc = parseAllocation(r.admin_notes || '')
  let overdue = ''
  if (!paid && pay?.due) {
    const days = Math.floor((Date.now() - new Date(pay.due).getTime()) / DAY)
    if (days > 0) overdue = `, ${days} day${days === 1 ? '' : 's'} overdue`
  }
  const eft = hasEftMarker(r.admin_notes) ? ', on the Master lane (⟦EFT⟧)'
    : pay?.eft_submitted_at ? ', EFT proof uploaded (pending reconcile)'
    : pay?.eft_revealed_at ? ', revealed EFT details (likely paying)' : ''
  const payLine = paid
    ? `PAID${received ? ` (R${received})` : ''}`
    : `UNPAID${total ? `, R${outstanding} outstanding of R${total}` : ''}${overdue}`
  return `${r.business_name || 'Unnamed'} (${r.contact_name || 'no contact'}, ${r.email || 'no email'}, ${r.phone || 'no phone'}) [vendor_id ${r.id}]: application ${r.status || 'unknown'}, ${payLine}, stall ${alloc.stall || 'not allocated'}${r.preferred_booth_tier ? ` (${tierLabel(r.preferred_booth_tier)})` : ''}${eft}.`
}

async function findVendors(query: string): Promise<string> {
  const q = (query || '').trim()
  if (!q) return 'Give me a name, business, email, or phone to search for.'
  const db = createAdminClient()
  const like = `%${q.replace(/[%_]/g, '')}%`
  const { data } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, status, admin_notes, paid_at, preferred_booth_tier, special_requirements')
    .or(`business_name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
    .limit(12)
  const rows = (data || []) as VRow[]
  if (!rows.length) return `No vendor matches "${q}".`
  const head = rows.length === 1 ? '1 match:' : `${rows.length} matches${rows.length === 12 ? ' (showing first 12, narrow the search)' : ''}:`
  return `${head}\n` + rows.map((r) => `- ${vendorSummary(r)}`).join('\n')
}

async function pipelineNumbers(): Promise<string> {
  const keys: SegmentKey[] = ['pending', 'approved', 'approved_paid', 'approved_unpaid', 'info_requested', 'rejected', 'ticket_buyers']
  const counts = await Promise.all(keys.map(async (k) => `${SEGMENT_LABELS[k]}: ${await segmentCount(k)}`))
  return counts.join('\n')
}

async function vendorConversation(vendorId: string): Promise<string> {
  const db = createAdminClient()
  const { data: v } = await db.from('vendor_applications').select('business_name, phone, email').eq('id', vendorId).single()
  if (!v) return `No vendor with id ${vendorId}.`
  const lines: Array<{ at: string; who: string; body: string }> = []
  const phone = (v.phone as string || '').replace(/^\+/, '')
  if (phone) {
    const { data: wa } = await db
      .from('wa_messages')
      .select('direction, body, created_at')
      .or(`wa_phone.eq.+${phone},wa_phone.eq.${phone}`)
      .order('created_at', { ascending: false })
      .limit(12)
    for (const m of (wa || []) as Array<{ direction: string; body: string | null; created_at: string }>) {
      const raw = (m.body || '').trim()
      if (!raw || /^\s*\[[A-Z_]+\]/.test(raw) || /^\s*🛎/u.test(raw)) continue
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
  if (!lines.length) return `No conversation on file for ${v.business_name || vendorId}.`
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

/**
 * Execute a master tool. THE WALL: refuses unless role === 'master'. Every tool
 * here reads across vendors, so a non-master caller (festival_owner, vendor,
 * anything) is denied before any query runs. Read-only; never sends or mutates.
 */
export async function executeMasterTool(role: string, name: string, args: unknown): Promise<MasterToolOutcome> {
  if (role !== 'master') {
    return { content: 'Not authorised.', isError: true }
  }
  try {
    switch (name) {
      case 'find_vendors': return { content: await findVendors((args as { query?: string })?.query || '') }
      case 'pipeline_numbers': return { content: await pipelineNumbers() }
      case 'vendor_conversation': return { content: await vendorConversation((args as { vendor_id?: string })?.vendor_id || '') }
      case 'eft_lane_activity': return { content: await eftLaneActivity() }
      default: return { content: `Unknown tool: ${name}`, isError: true }
    }
  } catch (e) {
    console.error('[master-tool] failed:', name, (e as Error).message)
    return { content: 'That lookup failed. Try again or check the admin dashboard.', isError: true }
  }
}
