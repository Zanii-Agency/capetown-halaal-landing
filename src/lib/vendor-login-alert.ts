// Fires the master alert when a vendor signs in, and records the login.
//
// Split out of the login route so the route stays a login route: this is
// best-effort telemetry and must never be able to fail a sign-in. Every path
// here swallows its own errors.
//
// Law 8 (no DDL): logins ride site_events, the same table the admin login log
// uses, so there is nothing to migrate.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loginFacts, placeLabel } from '@/lib/admin-login-log'
import { buildLoginAlert, type VendorActivityInput } from '@/lib/vendor-activity'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { computePaymentDue, daysUntil } from '@/lib/exhibitor-paygate'
import { getRequiredDocs } from '@/lib/exhibitor/required-docs'

type Headers = { get(name: string): string | null }

/** Best-effort. Never throws, never blocks the login. */
export async function recordVendorLogin(
  db: SupabaseClient,
  headers: Headers,
  user: { id: string; email?: string | null },
  source = 'portal',
): Promise<void> {
  try {
    const email = (user.email || '').toLowerCase()
    if (!email) return

    const { data: apps } = await db
      .from('vendor_applications')
      .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, reviewed_at, contract_signed_at, status, preferred_booth_tier, special_requirements')
      .ilike('email', email)
      .limit(1)
    const app = (apps || [])[0] as Record<string, unknown> | undefined
    if (!app) return // not a vendor row, nothing to summarise

    const appId = String(app.id)
    const facts = loginFacts(headers)
    const place = placeLabel(facts)

    // Prior logins BEFORE inserting this one, so "3rd login" counts correctly.
    const { data: priorRows } = await db
      .from('site_events')
      .select('created_at, metadata')
      .eq('event_type', 'vendor_login')
      .order('created_at', { ascending: false })
      .limit(400)
    const priorLogins = (priorRows || [])
      .filter((r) => (r as { metadata?: { application_id?: string } }).metadata?.application_id === appId)
      .map((r) => ({ at: String((r as { created_at: string }).created_at) }))

    await db.from('site_events').insert({
      session_id: 'vendor_login',
      event_type: 'vendor_login',
      path: '/exhibitor/login',
      metadata: {
        actor: email,
        application_id: appId,
        business_name: app.business_name,
        ip: facts.ip, city: facts.city, region: facts.region, country: facts.country,
        place, source,
      },
    })

    const state = parsePortalState(app.admin_notes as string)
    const due = computePaymentDue(app as { payment_due_date?: string | null; reviewed_at?: string | null })

    // Their own recent words, and their recent portal events.
    const [{ data: ev }, { data: inbound }] = await Promise.all([
      db.from('vendor_application_events').select('event_type, created_at')
        .eq('application_id', appId).order('created_at', { ascending: false }).limit(25),
      db.from('wa_messages').select('body, created_at')
        .eq('direction', 'in').eq('wa_phone', String(app.phone || ''))
        .order('created_at', { ascending: false }).limit(1),
    ])

    let docsRequired = 0
    try { docsRequired = getRequiredDocs(app as never).length } catch { docsRequired = 0 }

    const activity: VendorActivityInput = {
      payment: state.payment as VendorActivityInput['payment'],
      contractSignedAt: (app.contract_signed_at as string) || null,
      termsAcceptedAt: (state.terms_accepted_at as string) || null,
      docsUploaded: ((state.docs as unknown[]) || []).length,
      docsRequired,
      staffCount: ((state.staff as unknown[]) || []).length,
      logoUploaded: !!state.profile?.logo_path,
      stallCode: parseAllocation(app.admin_notes as string).stall || null,
      events: (ev || []) as { event_type: string; created_at: string }[],
      inbound: (inbound || []) as { body: string | null; created_at: string }[],
      priorLogins,
      dueDate: due,
      daysToDue: daysUntil(due),
    }

    const body = buildLoginAlert({
      businessName: String(app.business_name || 'A vendor'),
      contactName: (app.contact_name as string) || null,
      place, ip: facts.ip, activity, source,
    })

    // MASTER ONLY. This is Taona watching his own platform, and the summary
    // carries payment posture, which is exactly what the festival owner is
    // walled off from. audience:'master' plus no vendorId, so notifyOwners does
    // not re-derive a lane and hand it to her.
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({ event: 'system_alert', audience: 'master', body }).catch(() => {})
  } catch (e) {
    console.error('[vendor-login] telemetry failed:', (e as Error).message)
  }
}
