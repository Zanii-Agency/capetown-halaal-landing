// Per-vendor memory for the WhatsApp/email bot.
//
// The vendor agent already gets the last 8 WhatsApp turns (ctx.history) and live
// tools. Two things it CANNOT see, which is why it answers generically:
//   1. EMAIL history — support@ mail lands in support_inbox_messages, siloed from
//      the WhatsApp bot, so it never knows what the vendor emailed.
//   2. DURABLE facts — an arrangement made weeks ago ("Samreen granted an
//      extension to 31 Aug") scrolls out of the 8-message window and is forgotten.
//
// recallVendorContext() closes both: it reads the LIVE record (never stale), the
// vendor's recent EMAILS (the cross-channel gap), and durable ATOMS stored as a
// ⟦MEM⟧ marker on admin_notes (DDL is blocked, Law 8 — same marker pattern as
// ⟦PORTAL⟧/⟦EFT⟧/⟦STALL⟧). renderMemory() turns it into a compact block the agent
// prepends to its system prompt.
//
// Gated by VENDOR_MEMORY=on. Default off = the agent behaves exactly as today, so
// this ships inert and the live flip is a soak-gated switch, not a code change.
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { hasEftMarker } from '@/lib/eft'

/** Flag: the whole memory layer is inert unless this is 'on'. */
export const MEMORY_ON = (process.env.VENDOR_MEMORY || '').toLowerCase() === 'on'

// ── Atom store: durable facts as ⟦MEM:base64(json)⟧ on admin_notes ────────────
// Only ever touches its own marker; every other marker (⟦PORTAL⟧, ⟦EFT⟧, ⟦STALL⟧,
// ⟦OWNERVIS⟧ …) is preserved, the same contract withEftMarker / updatePortalState
// honour.
const MEM_RE = /⟦MEM:([A-Za-z0-9+/=]+)⟧/

export interface VendorAtom {
  fact: string          // "Extension to 31 Aug granted by Samreen"
  source: 'whatsapp' | 'email' | 'record' | 'operator'
  at?: string           // ISO, when it was learned
}

export function readAtoms(adminNotes: string | null | undefined): VendorAtom[] {
  const m = MEM_RE.exec(adminNotes || '')
  if (!m) return []
  try {
    const d = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
    return Array.isArray(d?.atoms) ? d.atoms : []
  } catch {
    return []
  }
}

/** Return adminNotes with the ⟦MEM⟧ marker set to these atoms, preserving all
 *  other markers and human prose. Pure; the caller persists it. */
export function withAtoms(adminNotes: string | null | undefined, atoms: VendorAtom[]): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, atoms })).toString('base64')
  const marker = `⟦MEM:${payload}⟧`
  const notes = adminNotes || ''
  if (MEM_RE.test(notes)) return notes.replace(MEM_RE, marker)
  const t = notes.trim()
  return t ? `${t}\n${marker}` : marker
}

// ── Recall ────────────────────────────────────────────────────────────────────
export interface VendorRecall {
  business: string
  contact: string | null
  live: {
    status: string
    payment: string          // raw portal status (the vendor's own truth; masking is Samreen's, not the vendor's)
    amount: number | null
    stall: string | null
    dueDate: string | null
    contractSigned: boolean
    eftLane: boolean          // on the private lane — the agent must not discuss bank arrangements (banking-guard already enforces)
  }
  atoms: VendorAtom[]
  emails: Array<{ date: string; subject: string; snippet: string }>
}

const stripQuote = (b: string | null | undefined) =>
  String(b || '')
    .split(/\n\s*On .+wrote:|\n\s*-----Original|\nFrom: |\n>{1,}|Return-Path:|--Apple-Mail|Content-Type:/)[0]
    .replace(/\s+/g, ' ')
    .trim()

/** Assemble everything the agent should know about ONE vendor: live record +
 *  durable atoms + recent support emails (the cross-channel gap). Reads fresh so
 *  payment/allocation are never stale. */
export async function recallVendorContext(vendorId: string): Promise<VendorRecall | null> {
  const db = createAdminClient()
  const { data: v } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, status, admin_notes, paid_at, preferred_booth_tier')
    .eq('id', vendorId)
    .maybeSingle()
  if (!v) return null

  const notes = (v.admin_notes as string) || ''
  const p = parsePortalState(notes).payment || {}
  const { stall } = parseAllocation(notes)

  // Recent support emails for this vendor (the WhatsApp bot never sees these).
  let emails: VendorRecall['emails'] = []
  if (v.email) {
    const { data: mail } = await db
      .from('support_inbox_messages')
      .select('subject, body_text, received_at, created_at')
      .eq('direction', 'in')
      .ilike('from_address', `%${v.email}%`)
      .order('created_at', { ascending: false })
      .limit(4)
    emails = (mail || [])
      .map((m) => ({
        date: String(m.received_at || m.created_at || '').slice(0, 10),
        subject: String(m.subject || '').slice(0, 60),
        snippet: stripQuote(m.body_text).slice(0, 180),
      }))
      .filter((e) => e.snippet || e.subject)
      .reverse()
  }

  return {
    business: (v.business_name as string) || 'this vendor',
    contact: (v.contact_name as string) || null,
    live: {
      status: (v.status as string) || 'unknown',
      payment: (p.status as string) || (v.paid_at ? 'paid' : 'none'),
      amount: (p.amount as number) ?? null,
      stall: stall || null,
      dueDate: (p.due as string) || null,
      contractSigned: !!(notes.match(/⟦CONTRACT/) || (p as { contract_signed_at?: string }).contract_signed_at),
      eftLane: hasEftMarker(notes) || p.status === 'collected',
    },
    atoms: readAtoms(notes),
    emails,
  }
}

/** Compact block to prepend to the agent's system prompt. Kept tight: it adds
 *  ONLY what ctx.history does not already carry (live state, durable facts, email
 *  side of the conversation), so it does not blow the WhatsApp token budget. */
export function renderMemory(r: VendorRecall): string {
  const L: string[] = []
  L.push(`WHAT YOU ALREADY KNOW ABOUT ${r.business}${r.contact ? ` (${r.contact})` : ''} — trust this, do not re-ask what is here.`)
  const money = r.live.amount ? `${r.live.payment} (R${r.live.amount})` : r.live.payment
  L.push(`Live: application ${r.live.status}; payment ${money}; stall ${r.live.stall || r.live.stall === '' ? (r.live.stall || 'not yet allocated') : 'not yet allocated'}${r.live.dueDate ? `; fee due ${r.live.dueDate}` : ''}; contract ${r.live.contractSigned ? 'signed' : 'not signed'}.`)
  if (r.live.eftLane) L.push(`This vendor is on the private payment lane. Do NOT discuss bank details or their payment method; help with everything else normally.`)
  if (r.atoms.length) {
    L.push('Known facts (arrangements and history, from past messages):')
    for (const a of r.atoms.slice(0, 8)) L.push(`- ${a.fact}${a.source === 'operator' ? ' (agreed by the team)' : ''}`)
  }
  if (r.emails.length) {
    L.push('They have also emailed support (they may reference this on WhatsApp):')
    for (const e of r.emails) L.push(`- [${e.date}] "${e.subject}": ${e.snippet}`)
  }
  return L.join('\n')
}
