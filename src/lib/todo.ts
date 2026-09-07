/**
 * The owner's To Do: only things that need HER action, gathered from the
 * surfaces she already works. Every source is the existing viewer-walled
 * handler (inbox, portal support, applications) or the fenced payment loader,
 * called as the current viewer, so the list can never show her more than the
 * pages do. ONE implementation feeds /admin/todo and the Claude connector's
 * `todo` tool.
 *
 * Items vanish when the underlying thing is done (a reply sent, a proof
 * confirmed), so there is nothing to tick and nothing to dismiss.
 * zanii-codef: no per-item snooze/dismiss; add when she asks for it.
 */
import { NextRequest } from 'next/server'
import { GET as inboxList } from '@/app/api/admin/inbox/unified/route'
import { GET as supportThreads } from '@/app/api/admin/support/route'
import { GET as applicationsList } from '@/app/api/admin/applications/route'
import { loadEftProofs } from '@/lib/payments/eft-proofs-list'

export type TodoItem = {
  kind: 'whatsapp_reply' | 'email_reply' | 'portal_support' | 'eft_proof' | 'applications'
  title: string
  detail: string
  since: string | null
  href: string
  /** identifiers a tool can act on */
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
  last_message_at?: string | null; last_preview?: string | null; needs_response?: boolean; unread?: number
}
type SupportThread = {
  application_id: string; business_name: string; contact_name: string | null; email: string | null; phone: string | null
  latest_preview: string; last_inbound_at: string | null; unread_count: number
}

const internal = (path: string) => new NextRequest(new URL(path, 'http://todo.internal'))
const json = async (res: Response) => { try { return await res.json() } catch { return null } }
// Drop every internal ⟦...⟧ marker (attachments, lane, portal state) before a
// preview reaches a human or a tool; only the words the sender wrote remain.
const clip = (s: string | null | undefined, n = 120) => (s || '').replace(/\u27e6[^\u27e7]*\u27e7?/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

export async function loadTodo(): Promise<Todo> {
  const [inboxRes, supportRes, appsRes, proofs] = await Promise.all([
    inboxList(internal('/api/admin/inbox/unified?channel=all')).then(json),
    supportThreads().then(json),
    applicationsList(internal('/api/admin/applications?status=pending&limit=1')).then(json),
    loadEftProofs().catch(() => ({ ownerEftActive: false, rows: [], totalAmount: 0, paidAmount: 0 })),
  ])

  const contacts: Contact[] = Array.isArray(inboxRes?.contacts) ? inboxRes.contacts : []
  const needs = contacts.filter((c) => c.needs_response)
  const who = (c: { business_name?: string | null; contact_name?: string | null; phone?: string | null; email?: string | null }) =>
    c.business_name || c.contact_name || c.phone || c.email || 'Unknown'

  const whatsapp: TodoItem[] = needs.filter((c) => c.last_channel === 'whatsapp').map((c) => ({
    kind: 'whatsapp_reply', title: who(c), detail: clip(c.last_preview), since: c.last_message_at ?? null,
    href: '/admin/inbox/whatsapp', phone: c.phone ?? null, email: c.email ?? null, applicationId: c.application_id ?? null,
  }))
  const email: TodoItem[] = needs.filter((c) => c.last_channel === 'email').map((c) => ({
    kind: 'email_reply', title: who(c), detail: clip(c.last_preview), since: c.last_message_at ?? null,
    href: c.mailbox === 'gmail' ? '/admin/inbox/gmail' : '/admin/inbox/support', phone: c.phone ?? null, email: c.email ?? null, applicationId: c.application_id ?? null,
  }))

  const threads: SupportThread[] = Array.isArray(supportRes?.threads) ? supportRes.threads : []
  const portal: TodoItem[] = threads.filter((t) => t.unread_count > 0).map((t) => ({
    kind: 'portal_support', title: t.business_name || t.contact_name || 'Vendor', detail: clip(t.latest_preview), since: t.last_inbound_at,
    href: `/admin/vendors/${t.application_id}`, phone: t.phone, email: t.email, applicationId: t.application_id,
  }))

  const eft: TodoItem[] = proofs.rows.filter((r) => !r.paid).map((r) => ({
    kind: 'eft_proof', title: r.name, detail: `Ref ${r.reference}, R${r.amount.toLocaleString('en-ZA')}${r.note ? `, "${clip(r.note, 60)}"` : ''}`, since: r.uploadedAt || null,
    href: '/admin/eft-proofs', applicationId: r.id,
  }))

  const pendingApps = Number(appsRes?.total ?? 0)
  const applications: TodoItem[] = pendingApps > 0 ? [{
    kind: 'applications', title: `${pendingApps} application${pendingApps === 1 ? '' : 's'} waiting for review`, detail: 'Approve or reject in Applications', since: null, href: '/admin/applications',
  }] : []

  const bySince = (a: TodoItem, b: TodoItem) => (a.since || '') < (b.since || '') ? -1 : 1 // oldest first: the longest wait is the most urgent
  const sections: Todo['sections'] = [
    { key: 'eft_proof', label: 'EFT proofs to confirm', items: eft.sort(bySince) },
    { key: 'whatsapp_reply', label: 'WhatsApp replies owed', items: whatsapp.sort(bySince) },
    { key: 'email_reply', label: 'Email replies owed', items: email.sort(bySince) },
    { key: 'portal_support', label: 'Vendor questions from the portal or bot', items: portal.sort(bySince) },
    { key: 'applications', label: 'Applications', items: applications },
  ]
  return { generatedAt: new Date().toISOString(), total: sections.reduce((s, x) => s + x.items.length, 0), sections }
}
