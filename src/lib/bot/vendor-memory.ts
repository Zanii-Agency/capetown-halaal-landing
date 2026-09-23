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
import { hasPaid } from '@/lib/portal-state'
import { cleanEmailText } from '@/lib/inbox/email-body'

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
  emails: Array<{ date: string; subject: string; snippet: string; from?: 'vendor' | 'team' }>
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
    .select('id, business_name, contact_name, email, phone, status, admin_notes, paid_at, preferred_booth_tier, contract_signed_at')
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
      .select('subject, body_text, received_at, created_at, direction, from_address, to_address')
      // BOTH sides. The team's replies carry the decisions ("we confirmed the
      // duplicate, a refund is due", Zayaan 2026-09-11); vendor-only mail left the
      // bot guessing. Automated sends are noise, so outbound keeps human replies
      // only (subject "Re:", the one reliable human-vs-system signal here).
      .or(`from_address.ilike.%${v.email}%,to_address.ilike.%${v.email}%`)
      .order('created_at', { ascending: false })
      .limit(12)
    emails = (mail || [])
      // EXACT address match: the ilike above is a substring (ali@x matches khali@x).
      .filter((m) => (String(m.direction === 'in' ? m.from_address : m.to_address).toLowerCase().match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? ([] as string[])).includes(String(v.email).toLowerCase().trim()))
      .filter((m) => m.direction === 'in' || /^re:/i.test(String(m.subject || '')))
      // A TEAM reply is free prose from Samreen or the master: it can name the other
      // account, our internals, or bank digits. Any such reply never reaches the bot.
      .filter((m) => m.direction === 'in' || !TEAM_UNSAFE_RE.test(cleanEmailText(m.body_text)))
      .slice(0, 6)
      .map((m) => ({
        from: (m.direction === 'in' ? 'vendor' : 'team') as 'vendor' | 'team',
        date: String(m.received_at || m.created_at || '').slice(0, 10),
        subject: String(m.subject || '').slice(0, 60),
        // cleanEmailText first: Apple Mail rows are raw MIME, and stripQuote alone cut
        // them at "--Apple-Mail" to an EMPTY snippet (Zayaan's refund thread vanished).
        snippet: stripQuote(cleanEmailText(m.body_text)).slice(0, 180),
      }))
      .filter((e) => e.snippet || e.subject)
      .reverse()
  }

  return {
    business: (v.business_name as string) || 'this vendor',
    contact: (v.contact_name as string) || null,
    live: {
      status: (v.status as string) || 'unknown',
      // Vendor-facing words: 'collected' IS paid to the vendor (their portal says so);
      // the raw state name leaked as "payment collected" and read like pending.
      payment: v.paid_at || hasPaid(parsePortalState(notes)) ? 'paid' : ((p.status as string) || 'none'),
      amount: (p.amount as number) ?? null,
      stall: stall || null,
      dueDate: (p.due as string) || null,
      // The real column. The old marker guess said "not signed" for signed vendors,
      // contradicting the identity block the agent also sees.
      contractSigned: !!v.contract_signed_at,
      eftLane: hasEftMarker(notes) || p.status === 'collected',
    },
    atoms: readAtoms(notes),
    emails,
  }
}

/** Compact block to prepend to the agent's system prompt. Kept tight: it adds
 *  ONLY what ctx.history does not already carry (live state, durable facts, email
 *  side of the conversation), so it does not blow the WhatsApp token budget. */
const INTERNAL_RE = /\b(NOEFT|lane|covert|master rail|samreen_eft|OWNERVIS|the bot)\b|⟦/i
// Stricter, for TEAM email prose: also account names, account-number digits, other lanes.
const TEAM_UNSAFE_RE = /\b(NOEFT|lane|covert|master|samreen_eft|OWNERVIS|191|629|halaal hub)\b|\d{6,}|\d{4}[ -]\d{3,}|⟦/i

export function renderMemory(r: VendorRecall): string {
  const L: string[] = []
  L.push(`WHAT YOU ALREADY KNOW ABOUT ${r.business}${r.contact ? ` (${r.contact})` : ''}: trust this, do not re-ask what is here.`)
  const money = r.live.amount ? `${r.live.payment} (R${r.live.amount})` : r.live.payment
  L.push(`Live: application ${r.live.status}; payment ${money}; stall ${r.live.stall || r.live.stall === '' ? (r.live.stall || 'not yet allocated') : 'not yet allocated'}${r.live.dueDate ? `; fee due ${r.live.dueDate}` : ''}; contract ${r.live.contractSigned ? 'signed' : 'not signed'}.`)
  // NEVER the word "lane": the bot repeated it to Zayaan ("you're on a different
  // payment lane"). Their method is theirs to hear (see vendorContextLines); only
  // account details stay in the portal.
  if (r.live.eftLane) L.push(`Never state bank or account details (they are in the portal), and never describe how we route or process payments internally.`)
  if (r.atoms.length) {
    L.push('Known facts (arrangements and history, from past messages). They can be dated: if one conflicts with the live line above or with today\'s rules, the live line and today\'s rules win:')
    // Atoms were backfilled from old threads and some carry internal jargon
    // ("NOEFT (normally card-only lane)"). The bot repeats what it is given, so a
    // fact that names our internals never reaches it.
    for (const a of r.atoms.filter((x) => !INTERNAL_RE.test(x.fact) && !/^where things stand/i.test(x.fact)).slice(0, 8)) L.push(`- ${a.fact}${a.source === 'operator' ? ' (agreed by the team)' : ''}`)
  }
  if (r.emails.length) {
    L.push('Their recent email thread with the team (they may reference it on WhatsApp; what the TEAM wrote there is already decided, honour it):')
    for (const e of r.emails) L.push(`- [${e.date}] ${e.from === 'team' ? 'TEAM' : 'VENDOR'} "${e.subject}": ${e.snippet}`)
  }
  return L.join('\n')
}
