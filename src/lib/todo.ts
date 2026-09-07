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
import { loadEftProofs } from '@/lib/payments/eft-proofs-list'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isEftAdmin, rosterPaid, vendorInOwnerScope } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { isTestVendor } from '@/lib/test-vendors'

export type TodoAction =
  | { type: 'reply'; channel: 'whatsapp'; phone: string }
  | { type: 'reply'; channel: 'email'; email: string; subject?: string | null }
  | { type: 'reply_portal'; applicationId: string }
  | { type: 'confirm_eft'; applicationId: string; reference: string; amount: number; proofUrl: string | null }
  | { type: 'navigate'; href: string }

export type TodoItem = {
  kind: 'task' | 'whatsapp_reply' | 'email_reply' | 'portal_support' | 'eft_proof'
  /** Operational tasks carry a count of vendors behind the card. */
  count?: number
  title: string
  /** What the vendor actually said / wants — their words, markers stripped. */
  ask: string
  /** Plain instruction to the operator: what this needs from her. */
  whatsNeeded: string
  since: string | null
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

type Contact = {
  application_id?: string | null; business_name?: string | null; contact_name?: string | null
  phone?: string | null; email?: string | null; last_channel?: string | null; mailbox?: string | null
  last_message_at?: string | null; last_preview?: string | null; needs_response?: boolean; unread?: boolean; bot_paused?: boolean
}
type SupportThread = {
  application_id: string; business_name: string; contact_name: string | null; email: string | null; phone: string | null
  latest_preview: string; last_inbound_at: string | null; unread_count: number
}

const internal = (path: string) => new NextRequest(new URL(path, 'http://todo.internal'))
const json = async (res: Response) => { try { return await res.json() } catch { return null } }
// Drop every internal ⟦...⟧ marker (attachments, lane, portal state) before a
// preview reaches a human or a tool; only the words the sender wrote remain.
const clip = (s: string | null | undefined, n = 160) => (s || '').replace(/⟦[^⟧]*⟧?/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
const rand = (n: number) => `R${n.toLocaleString('en-ZA')}`

export async function loadTodo(): Promise<Todo> {
  // Gmail is master/dev only, so a non-eftAdmin viewer's email items must not
  // deep-link into the Gmail inbox she cannot open. The inline reply still works
  // (the reply route picks the right mailbox); only the fallback link changes.
  const { data: { user } } = await (await createClient()).auth.getUser()
  const canSeeGmail = isEftAdmin(user?.email)
  const [inboxRes, supportRes, proofs, tasks] = await Promise.all([
    inboxList(internal('/api/admin/inbox/unified?channel=all')).then(json),
    supportThreads().then(json),
    loadEftProofs().catch(() => ({ ownerEftActive: false, rows: [], totalAmount: 0, paidAmount: 0 })),
    loadOperationalTasks().catch(() => [] as TodoItem[]),
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
    href: '/admin/inbox/whatsapp', phone: c.phone ?? null, email: c.email ?? null, applicationId: c.application_id ?? null,
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
  const emailCandidates = needs.filter((c) => c.last_channel === 'email' && c.application_id && c.email)
  const stillWaiting = await emailsAwaitingReply(emailCandidates.map((c) => (c.email as string).toLowerCase()))
  const email: TodoItem[] = emailCandidates.filter((c) => stillWaiting.has((c.email as string).toLowerCase())).map((c) => ({
    kind: 'email_reply', title: who(c), ask: clip(c.last_preview),
    whatsNeeded: `Reply by email to ${who(c)}, a vendor waiting on an answer.`,
    since: c.last_message_at ?? null,
    action: { type: 'reply', channel: 'email', email: c.email as string },
    href: (c.mailbox === 'gmail' && canSeeGmail) ? '/admin/inbox/gmail' : '/admin/inbox/support', phone: c.phone ?? null, email: c.email ?? null, applicationId: c.application_id ?? null,
  }))

  const threads: SupportThread[] = Array.isArray(supportRes?.threads) ? supportRes.threads : []
  const portal: TodoItem[] = threads.filter((t) => t.unread_count > 0).map((t) => ({
    kind: 'portal_support', title: t.business_name || t.contact_name || 'Vendor', ask: clip(t.latest_preview),
    whatsNeeded: `Answer ${t.business_name || 'this vendor'}'s question. It came through the portal or the WhatsApp assistant handed it over.`,
    since: t.last_inbound_at,
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

  const bySince = (a: TodoItem, b: TodoItem) => (a.since || '') < (b.since || '') ? -1 : 1 // oldest first: the longest wait is the most urgent
  const sections: Todo['sections'] = [
    { key: 'task', label: 'Things to do', items: tasks },
    { key: 'eft_proof', label: 'EFT proofs to confirm', items: eft.sort(bySince) },
    { key: 'whatsapp_reply', label: 'WhatsApp replies owed', items: whatsapp.sort(bySince) },
    { key: 'email_reply', label: 'Email replies owed', items: email.sort(bySince) },
    { key: 'portal_support', label: 'Vendor questions from the portal or bot', items: portal.sort(bySince) },
  ]
  return { generatedAt: new Date().toISOString(), total: sections.reduce((s, x) => s + x.items.length, 0), sections }
}


/**
 * Which of these vendor emails genuinely still await a reply: the newest message
 * across all of a peer's support threads is INBOUND. Authoritative, unlike the
 * inbox needs_response flag. Two queries, whatever the number of candidates.
 */
async function emailsAwaitingReply(emails: string[]): Promise<Set<string>> {
  const waiting = new Set<string>()
  const uniq = Array.from(new Set(emails.filter(Boolean)))
  if (uniq.length === 0) return waiting
  const db = createAdminClient()
  const { data: threads } = await db
    .from('support_inbox_threads')
    .select('id, peer_email')
    .in('peer_email', uniq)
  const rows = (threads || []) as Array<{ id: string; peer_email: string | null }>
  const emailByThread = new Map<string, string>()
  for (const t of rows) if (t.peer_email) emailByThread.set(t.id, t.peer_email.toLowerCase())
  const threadIds = rows.map((t) => t.id)
  if (threadIds.length === 0) return waiting
  const { data: msgs } = await db
    .from('support_inbox_messages')
    .select('thread_id, direction, received_at, created_at')
    .in('thread_id', threadIds)
  // newest message per email by the true event time (received_at is the sender's
  // header and can be null/skewed on our own outbound, so coalesce to created_at).
  const newest = new Map<string, { dir: string; ts: string }>()
  for (const m of (msgs || []) as Array<{ thread_id: string; direction: string | null; received_at: string | null; created_at: string | null }>) {
    const email = emailByThread.get(m.thread_id)
    if (!email) continue
    const ts = m.received_at || m.created_at || ''
    const cur = newest.get(email)
    if (!cur || ts > cur.ts) newest.set(email, { dir: m.direction === 'in' ? 'in' : 'out', ts })
  }
  for (const [email, v] of newest) if (v.dir === 'in') waiting.add(email)
  return waiting
}


/**
 * Operational tasks the owner must DO (not messages): a single her-scoped scan of
 * vendor_applications, turned into count-cards that link to the page where she
 * acts. Scoped exactly like every owner page (vendorInOwnerScope), so a
 * master-lane vendor never becomes her task. Counts drop as she clears them.
 */
async function loadOperationalTasks(): Promise<TodoItem[]> {
  const db = createAdminClient()
  const { data } = await db
    .from('vendor_applications')
    .select('id, business_name, admin_notes, paid_at, status, contract_signed_at, is_duplicate')
    .neq('status', 'rejected')
  const rows = (data || []) as Array<{ id: string; business_name: string | null; admin_notes: string | null; paid_at: string | null; status: string | null; contract_signed_at: string | null; is_duplicate: boolean | null }>
  let stalls = 0, docs = 0, contracts = 0, overdue = 0, allocatedAnyone = 0
  const now = Date.now()
  for (const v of rows) {
    if (v.is_duplicate) continue
    if (isTestVendor({ business_name: v.business_name })) continue
    if (!vendorInOwnerScope(v.admin_notes, v.paid_at)) continue // only her vendors
    const paid = rosterPaid(v.admin_notes, v.paid_at)
    const portal = parsePortalState(v.admin_notes || '')
    const codes = parseAllocation(v.admin_notes).stalls
    if (codes.length > 0) allocatedAnyone++
    if (paid && codes.length === 0) stalls++
    if ((portal.docs || []).some((d) => d.status === 'pending')) docs++
    if (paid && !v.contract_signed_at) contracts++
    const due = portal.payment?.due
    if (!paid && v.status === 'approved' && due && new Date(due).getTime() < now) overdue++
  }
  const tasks: TodoItem[] = []
  const push = (n: number, title: string, whatsNeeded: string, href: string) => {
    if (n > 0) tasks.push({ kind: 'task', title, ask: '', whatsNeeded, since: null, count: n, action: { type: 'navigate', href }, href })
  }
  push(overdue, `${overdue} vendor${overdue === 1 ? '' : 's'} overdue on payment`, 'Follow up with vendors whose payment date has passed. Opens Finance.', '/admin/finance?payment=none')
  if (allocatedAnyone > 0) push(stalls, `${stalls} paid vendor${stalls === 1 ? '' : 's'} still need a stall`, 'Allocate a stall to each paid vendor who does not have one yet. Opens Allocation.', '/admin/allocation')
  push(docs, `${docs} vendor${docs === 1 ? '' : 's'} with documents to review`, 'Approve or reject the documents these vendors uploaded. Opens Documents.', '/admin/documents')
  push(contracts, `${contracts} paid vendor${contracts === 1 ? '' : 's'} without a signed contract`, 'Chase or resend the contract to paid vendors who have not signed. Opens Vendors.', '/admin/vendors')
  return tasks
}
