/**
 * The owner's To Do: only things that need HER action, gathered from the
 * surfaces she already works. Every source is the existing viewer-walled
 * handler (inbox, portal support) or the fenced payment loader, called as the
 * current viewer, so the list can never show her more than the pages do. ONE
 * implementation feeds /admin/todo, its GET endpoint, and the connector `todo`
 * tool.
 *
 * Each item carries `whatsNeeded` (a plain-words explanation of what to do) and
 * an `action` (the tool to run in place) so the operator never has to be
 * redirected into a raw chat to understand or act. Items vanish when the
 * underlying thing is done (a reply sent, a proof confirmed).
 */
import { NextRequest } from 'next/server'
import { GET as inboxList } from '@/app/api/admin/inbox/unified/route'
import { GET as supportThreads } from '@/app/api/admin/support/route'
import { GET as stallChanges } from '@/app/api/admin/stall-changes/route'
import { loadEftProofs } from '@/lib/payments/eft-proofs-list'
import { createAdminClient } from '@/lib/supabase/admin'
import { cleanEmailText } from '@/lib/inbox/email-body'
import { settledBy, type SettleRow } from '@/lib/support-case'
import { parsePortalState } from '@/lib/portal-state'

export type TodoAction =
  | { type: 'reply'; channel: 'whatsapp'; phone: string }
  | { type: 'reply'; channel: 'email'; email: string; subject?: string | null }
  | { type: 'reply_portal'; applicationId: string }
  | { type: 'confirm_eft'; applicationId: string; reference: string; amount: number; proofUrl: string | null }
  | { type: 'navigate'; href: string }
  | { type: 'stall_change'; applicationId: string; changeKind: 'size' | 'move' }

export type TodoItem = {
  kind: 'task' | 'whatsapp_reply' | 'email_reply' | 'portal_support' | 'stall_change' | 'eft_proof'
  /** Operational tasks carry a count of vendors behind the card. */
  count?: number
  title: string
  /** What the vendor actually said / wants — their words, markers stripped. */
  ask: string
  /** Plain instruction to the operator: what this needs from her. */
  whatsNeeded: string
  since: string | null
  /** A vendor case past the 72h the bot promised (lib/support-case.ts). */
  overdue?: boolean
  /** Unanswered asks on the case (2+ = the vendor chased). */
  asks?: number
  /** The tool to run without leaving To Do. */
  action: TodoAction
  /** Deep link, only as a fallback for the full history. */
  href: string
  phone?: string | null
  email?: string | null
  applicationId?: string | null
}

export type Todo = {
  generatedAt: string
  total: number
  sections: { key: TodoItem['kind']; label: string; items: TodoItem[] }[]
}

export type Contact = {
  application_id?: string | null; business_name?: string | null; contact_name?: string | null
  phone?: string | null; email?: string | null; last_channel?: string | null; mailbox?: string | null
  last_message_at?: string | null; last_preview?: string | null; needs_response?: boolean; unread?: boolean; bot_paused?: boolean
}
type SupportThread = {
  application_id: string; business_name: string; contact_name: string | null; email: string | null; phone: string | null
  latest_preview: string; last_inbound_at: string | null; unread_count: number
  case_opened_at?: string | null; case_due_at?: string | null; case_overdue?: boolean
}

const internal = (path: string) => new NextRequest(new URL(path, 'http://todo.internal'))
const json = async (res: Response) => { try { return await res.json() } catch { return null } }
// Drop every internal ⟦...⟧ marker (attachments, lane, portal state) before a
// preview reaches a human or a tool; only the words the sender wrote remain.
const clip = (s: string | null | undefined, n = 160) => (s || '').replace(/⟦[^⟧]*⟧?/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
const rand = (n: number) => `R${n.toLocaleString('en-ZA')}`

export async function loadTodo(): Promise<Todo> {
  const [inboxRes, supportRes, proofs, stallRes] = await Promise.all([
    inboxList(internal('/api/admin/inbox/unified?channel=all')).then(json),
    supportThreads().then(json),
    loadEftProofs().catch(() => ({ ownerEftActive: false, rows: [], totalAmount: 0, paidAmount: 0 })),
    stallChanges().then(json).catch(() => null),
  ])

  const contacts: Contact[] = Array.isArray(inboxRes?.contacts) ? inboxRes.contacts : []
  const needs = contacts.filter((c) => c.needs_response)
  const who = (c: { business_name?: string | null; contact_name?: string | null; phone?: string | null; email?: string | null }) =>
    c.business_name || c.contact_name || c.phone || c.email || 'Unknown'

  // WhatsApp: the bot answers every thread on its own. A thread is HERS only once
  // a human has taken it over (bot_paused) and the vendor is still waiting. A bot
  // escalation ("passed this to the team") lands in the portal-support section
  // below, not here, so nothing is double-listed.
  const whatsapp: TodoItem[] = needs.filter((c) => c.last_channel === 'whatsapp' && c.bot_paused && c.phone).map((c) => ({
    kind: 'whatsapp_reply', title: who(c), ask: clip(c.last_preview),
    whatsNeeded: `Reply to ${who(c)} on WhatsApp. This chat is off the bot (a person is handling it), so it is waiting on you.`,
    since: c.last_message_at ?? null,
    action: { type: 'reply', channel: 'whatsapp', phone: c.phone as string },
    href: '/admin/customer-inbox?view=needs', phone: c.phone ?? null, email: c.email ?? null, applicationId: c.application_id ?? null,
  }))
  // Email: no bot answers it, so a human owes every real one, but "real" means a
  // VENDOR (linked to an application). Cold marketing and outside senders have no
  // application; they stay in the full Inbox and never nag her from To Do.
  //
  // "Waiting" must be TRUE, not the inbox's needs_response flag, which over-reports
  // (its per-thread last-message lookup is capped at the 4000 newest support rows
  // and then falls back to a stale unread_count, so a thread we already replied to
  // still reads inbound — measured 2026-09-07: 7 of 10 were already answered). So
  // we re-derive it from the peer's genuine latest message: an email is owed only
  // if the newest message across that vendor's threads is INBOUND.
  // 2026-09-23 audit: 60 vendor emails on support@ sat unanswered with NO to-do
  // card, because (a) only inbox-flagged contacts were candidates and (b) an
  // AUTOMATED send (a payment reminder) after the vendor's question counted as the
  // answer. Every vendor contact is a candidate now; only a HUMAN reply answers.
  const email = await owedVendorEmails(contacts)

  const threads: SupportThread[] = Array.isArray(supportRes?.threads) ? supportRes.threads : []
  const portal: TodoItem[] = threads.filter((t) => t.unread_count > 0).map((t) => ({
    kind: 'portal_support', title: t.business_name || t.contact_name || 'Vendor', ask: clip(t.latest_preview),
    whatsNeeded: `${t.case_overdue ? 'OVERDUE: we promised an answer within 72 hours and it has passed. ' : ''}Answer ${t.business_name || 'this vendor'}'s question${t.unread_count > 1 ? ` (they have asked ${t.unread_count} times)` : ''}. It came through the portal or the WhatsApp assistant handed it over.`,
    since: t.case_opened_at ?? t.last_inbound_at,
    overdue: !!t.case_overdue, asks: t.unread_count,
    action: { type: 'reply_portal', applicationId: t.application_id },
    href: `/admin/vendors/${t.application_id}`, phone: t.phone, email: t.email, applicationId: t.application_id,
  }))

  const eft: TodoItem[] = proofs.rows.filter((r) => !r.paid).map((r) => ({
    kind: 'eft_proof', title: r.name,
    ask: `Uploaded proof of an EFT for ${rand(r.amount)}${r.note ? `, note: "${clip(r.note, 60)}"` : ''}.`,
    whatsNeeded: `Check the proof, then confirm it to mark ${r.name} paid (${rand(r.amount)}, ref ${r.reference}). Confirming sends them the payment-received message.`,
    since: r.uploadedAt || null,
    action: { type: 'confirm_eft', applicationId: r.id, reference: r.reference || '', amount: r.amount, proofUrl: r.proofUrl },
    href: '/admin/eft-proofs', applicationId: r.id,
  }))

  type SR = { id: string; business_name: string; fromTierLabel?: string; requestedTierLabel?: string; fromStall?: string; toStall?: string; reason?: string; requestedAt?: string | null }
  const mkStall = (r: SR, changeKind: 'size' | 'move'): TodoItem => ({
    kind: 'stall_change', title: r.business_name || 'Vendor',
    ask: clip(r.reason) || (changeKind === 'size' ? `${r.fromTierLabel || 'current'} → ${r.requestedTierLabel || 'new size'}` : `Move ${r.fromStall || ''} → ${r.toStall || 'new spot'}`),
    whatsNeeded: `Approve or decline ${r.business_name || 'this vendor'}'s ${changeKind === 'size' ? 'stall-size' : 'stall-move'} request, right here.`,
    since: r.requestedAt ?? null,
    action: { type: 'stall_change', applicationId: r.id, changeKind },
    href: '/admin/stall-changes', applicationId: r.id,
  })
  const stall: TodoItem[] = [
    ...((Array.isArray(stallRes?.requests) ? stallRes.requests : []) as SR[]).map((r) => mkStall(r, 'size')),
    ...((Array.isArray(stallRes?.moveRequests) ? stallRes.moveRequests : []) as SR[]).map((r) => mkStall(r, 'move')),
  ]

  const bySince = (a: TodoItem, b: TodoItem) => (a.since || '') < (b.since || '') ? -1 : 1 // oldest first: the longest wait is the most urgent
  const byRecent = (a: TodoItem, b: TodoItem) => (a.since || '') > (b.since || '') ? -1 : 1 // newest first
  // Cases: a broken 72h promise first, then vendors who chased, then the longest wait.
  const byCase = (a: TodoItem, b: TodoItem) =>
    Number(!!b.overdue) - Number(!!a.overdue) || (b.asks ?? 0) - (a.asks ?? 0) || bySince(a, b)
  const sections: Todo['sections'] = [
    { key: 'eft_proof', label: 'EFT proofs to confirm', items: eft.sort(byRecent) },
    { key: 'whatsapp_reply', label: 'WhatsApp replies owed', items: whatsapp.sort(bySince) },
    { key: 'email_reply', label: 'Email replies owed', items: email.sort(bySince) },
    { key: 'stall_change', label: 'Stall changes to approve', items: stall.sort(byRecent) },
    { key: 'portal_support', label: 'Special requests from vendors', items: portal.sort(byCase) },
  ]
  return { generatedAt: new Date().toISOString(), total: sections.reduce((s, x) => s + x.items.length, 0), sections }
}


/** Vendor emails on support@ still owed a HUMAN answer, as To Do items. One
 *  implementation: loadTodo calls it with the viewer-walled inbox contacts. */
export async function owedVendorEmails(contacts: Contact[]): Promise<TodoItem[]> {
  const whoOf = (c: Contact) => c.business_name || c.contact_name || c.phone || c.email || 'Unknown'
  const seenEmail = new Set<string>()
  const emailCandidates = contacts.filter((c) => {
    const e = (c.email || '').toLowerCase()
    if (!c.application_id || !e || seenEmail.has(e)) return false
    seenEmail.add(e); return true
  })
  const stillWaiting = await emailsAwaitingReply(emailCandidates.map((c) => (c.email as string).toLowerCase()))
  // Settled by what happened next (support-case.ts): an emailed proof followed by a
  // confirmed payment, "was I accepted?" followed by the decision, a withdrawal.
  const waitingIds = emailCandidates.filter((c) => stillWaiting.has((c.email as string).toLowerCase())).map((c) => c.application_id as string)
  const settleRows = new Map<string, SettleRow>()
  for (let i = 0; i < waitingIds.length; i += 100) {
    const { data } = await createAdminClient().from('vendor_applications').select('id, status, reviewed_at, paid_at, admin_notes').in('id', waitingIds.slice(i, i + 100))
    for (const r of (data || []) as Array<SettleRow & { id: string }>) settleRows.set(r.id, r)
  }
  const humanWaAt = new Map<string, string>()
  {
    const since = [...stillWaiting.values()].map((w) => w.at).sort()[0]
    if (since) {
      const { data } = await createAdminClient().from('wa_messages').select('wa_phone, created_at, metadata')
        .eq('direction', 'out').gte('created_at', since).not('metadata->>sent_by', 'is', null).limit(1000)
      for (const m of (data || []) as Array<{ wa_phone: string; created_at: string }>) {
        const k = String(m.wa_phone || '').replace(/\D/g, '').slice(-9)
        if (m.created_at > (humanWaAt.get(k) || '')) humanWaAt.set(k, m.created_at)
      }
    }
  }
  const email: TodoItem[] = emailCandidates.filter((c) => {
    const w = stillWaiting.get((c.email as string).toLowerCase())
    if (!w) return false
    const row = settleRows.get(c.application_id as string)
    if (row && settledBy(`${w.subject} ${w.preview}`, w.at, row)) return false
    // Answered on another channel: a human WhatsApp reply, or the case was closed
    // (supportResolvedAt: a human replied through the inbox) after this email.
    const k = (c.phone || '').replace(/\D/g, '').slice(-9)
    if (k && (humanWaAt.get(k) || '') > w.at) return false
    if (row && (parsePortalState(row.admin_notes).supportResolvedAt || '') > w.at) return false
    return true
  }).map((c) => {
    const w = stillWaiting.get((c.email as string).toLowerCase())!
    return {
      kind: 'email_reply', title: whoOf(c), ask: clip(w.preview),
      whatsNeeded: `Reply by email to ${whoOf(c)}, a vendor waiting on an answer.`,
      since: w.at,
      action: { type: 'reply', channel: 'email', email: c.email as string, subject: w.subject },
      href: '/admin/customer-inbox?view=needs', phone: c.phone ?? null, email: c.email ?? null, applicationId: c.application_id ?? null,
    }
  })

  return email
}

/**
 * Which vendor emails genuinely still await a HUMAN reply on support@: the vendor's
 * newest real message is later than our newest human reply. A human reply is an
 * outbound whose subject starts "Re:" (the only reliable human-vs-system signal:
 * sent_by is never set on email). Automated sends (reminders, confirmations) do not
 * answer anyone. Samreen's own Gmail is out of scope (Taona 2026-09-23). A bare
 * "thanks" / "ok" is not a question. Chunked + paged: PostgREST caps at 1000 rows.
 */
const THANKS_ONLY = /^(thanks?( you)?( so much)?|thank you.*|shukr\w*|jzk|jazak\w*|ok(ay)?|noted|great|perfect|will do|ameen\w*)[\s!.,🙏👍❤️😊]*$/i
export async function emailsAwaitingReply(emails: string[]): Promise<Map<string, { at: string; preview: string; subject: string }>> {
  const waiting = new Map<string, { at: string; preview: string; subject: string }>()
  const uniq = Array.from(new Set(emails.filter(Boolean)))
  if (uniq.length === 0) return waiting
  const db = createAdminClient()
  const emailByThread = new Map<string, string>()
  for (let i = 0; i < uniq.length; i += 100) {
    const { data } = await db.from('support_inbox_threads').select('id, peer_email').in('peer_email', uniq.slice(i, i + 100))
    for (const t of (data || []) as Array<{ id: string; peer_email: string | null }>) if (t.peer_email) emailByThread.set(t.id, t.peer_email.toLowerCase())
  }
  const threadIds = [...emailByThread.keys()]
  type M = { thread_id: string; direction: string | null; subject: string | null; body_text: string | null; received_at: string | null; created_at: string | null }
  const lastIn = new Map<string, M>(); const lastHuman = new Map<string, string>()
  for (let i = 0; i < threadIds.length; i += 100) {
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('support_inbox_messages')
        .select('thread_id, direction, subject, body_text, received_at, created_at')
        .in('thread_id', threadIds.slice(i, i + 100)).is('mailbox', null)
        .order('created_at', { ascending: true }).range(from, from + 999)
      for (const m of (data || []) as M[]) {
        const email = emailByThread.get(m.thread_id); if (!email) continue
        const ts = m.received_at || m.created_at || ''
        if (m.direction === 'in') {
          const own = cleanEmailText(m.body_text).split(/\n\s*On .+wrote:|\n>|\s+On (Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,? \d|_{8,}|\bFrom: |\bSent from (my|Outlook)|\bGet Outlook/)[0].replace(/\s+/g, ' ').trim()
          // A thank-you is not a question: exact thanks, or a short note that thanks
          // us and asks nothing ("Wslm Shukran", "Hi team thanks for letting me know").
          if (!own || THANKS_ONLY.test(own) || (own.length < 90 && !own.includes('?') && /thank|shukr|jzk|jazak|appreciat/i.test(own))) continue
          const cur = lastIn.get(email); if (!cur || ts > (cur.received_at || cur.created_at || '')) lastIn.set(email, { ...m, body_text: own })
        } else if (/^re:/i.test(m.subject || '')) {
          if (ts > (lastHuman.get(email) || '')) lastHuman.set(email, ts)
        }
      }
      if (!data || data.length < 1000) break
    }
  }
  for (const [email, m] of lastIn) {
    const at = m.received_at || m.created_at || ''
    if (at > (lastHuman.get(email) || '')) waiting.set(email, { at, preview: m.body_text || m.subject || '', subject: m.subject || '' })
  }
  return waiting
}



