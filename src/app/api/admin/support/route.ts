// Lists every vendor support thread for the admin inbox. A "thread" is the
// support[] array stored inside each vendor_applications.admin_notes PORTAL
// marker. We scan every approved/active application, parse the marker, and
// return only those with at least one message, newest activity first.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, type SupportMessage } from '@/lib/portal-state'
import { laneScopeFor, hidesEftContent, stripEftMessages } from '@/lib/inbox-lane'
import { openCase, settledBy } from '@/lib/support-case'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export interface SupportThread {
  application_id: string
  business_name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  wa_phone: string | null
  app_status: string | null
  messages: SupportMessage[]
  latest_at: string | null
  latest_preview: string
  last_inbound_at: string | null
  unread_count: number
  case_opened_at?: string | null
  case_due_at?: string | null
  case_overdue?: boolean
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const { data: adminUser } = await db
    .from('admin_users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()
  if (!adminUser) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const { data: apps } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, wa_phone, app_status, admin_notes, paid_at')
    .order('updated_at', { ascending: false })
    .limit(1000)

  const scope = await laneScopeFor(user.email)
  const threads: SupportThread[] = []
  const hideEft = hidesEftContent(user.email)
  for (const row of apps || []) {
    // The legacy portal support[] thread must follow the same ownership rule as
    // the main inbox: master-lane vendors are not visible to the festival owner.
    const id = row.id as string
    const email = (row.email as string | null) || null
    const phone = (row.phone as string | null) || null
    if (scope.blocks({ applicationId: id, email, phone })) continue

    const state = parsePortalState(row.admin_notes as string)
    let messages = (state.support || []).slice().sort((a, b) => a.at.localeCompare(b.at))
    messages = stripEftMessages(messages, (m) => m.body, hideEft, {
      scope,
      identity: { applicationId: id, email, phone },
      at: (m) => m.at,
    })
    if (!messages.length) continue
    const latest = messages[messages.length - 1]
    const lastIn = [...messages].reverse().find((m) => m.from === 'vendor')
    // The open CASE (lib/support-case.ts): asks since the team last answered, in the
    // portal thread OR on WhatsApp/email (supportResolvedAt). Was portal-only, so a
    // vendor answered on WhatsApp stayed "unread" here for ever.
    const raw = openCase({ support: messages, supportResolvedAt: state.supportResolvedAt })
    // ...unless a later payment / decision / withdrawal already settled it (support-case.ts).
    const kase = raw && settledBy(`${raw.firstAsk} ${raw.latestAsk}`, raw.lastAskAt, { status: row.app_status as string, paid_at: row.paid_at as string, admin_notes: row.admin_notes as string }) ? null : raw
    const unread = kase?.asks ?? 0
    threads.push({
      application_id: row.id as string,
      business_name: (row.business_name as string) || 'Unnamed vendor',
      contact_name: (row.contact_name as string) || null,
      email: (row.email as string) || null,
      phone: (row.phone as string) || null,
      wa_phone: null,
      app_status: (row.app_status as string) || null,
      messages,
      latest_at: latest?.at || null,
      latest_preview: (latest?.body || '').slice(0, 200),
      last_inbound_at: lastIn?.at || null,
      unread_count: unread,
      case_opened_at: kase?.openedAt ?? null,
      case_due_at: kase?.dueAt ?? null,
      case_overdue: kase?.overdue ?? false,
    })
  }
  threads.sort((a, b) => (b.latest_at || '').localeCompare(a.latest_at || ''))

  return NextResponse.json({ threads })
}
