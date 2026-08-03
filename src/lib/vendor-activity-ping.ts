// "Vendor is on their portal RIGHT NOW" ping for the master.
//
// The login announcer only fires on a FRESH sign-in. Portal sessions live for
// days, so a vendor with a live session can upload documents, request stall
// changes and pay without any login event — Angelpie's stall change on
// 2026-08-01 alerted the action but Taona reasonably asked "why no login
// alert?". This ping closes that: the first portal page load in a 12-hour
// window records a vendor_active event and alerts the master with the same
// summary shape the login alert carries.
//
// MASTER ONLY, same rule as the login alert: the summary carries payment
// posture, which the festival owner is walled off from.
//
// Law 8: rides site_events, no DDL. Best-effort: never throws, never blocks a
// page render (the portal layout calls it inside after()).

import type { SupabaseClient } from '@supabase/supabase-js'
import { loginFacts, placeLabel } from '@/lib/admin-login-log'
import { shouldPing } from '@/lib/admin-activity-ping'
import { buildLoginAlert, type VendorActivityInput } from '@/lib/vendor-activity'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { computePaymentDue, daysUntil } from '@/lib/exhibitor-paygate'
import { getRequiredDocs } from '@/lib/exhibitor/required-docs'

type Headers = { get(name: string): string | null }

export interface VendorPingApp {
  id: string
  business_name?: string | null
  contact_name?: string | null
  email?: string | null
  phone?: string | null
  admin_notes?: string | null
  paid_at?: string | null
  reviewed_at?: string | null
  contract_signed_at?: string | null
  preferred_booth_tier?: string | null
  special_requirements?: unknown
}

export async function pingVendorActivity(
  db: SupabaseClient,
  headers: Headers,
  app: VendorPingApp,
): Promise<void> {
  try {
    const appId = String(app.id)

    // Read-back dedupe: one ping per vendor per 12h, however many pages load.
    const { data } = await db
      .from('site_events')
      .select('created_at, metadata')
      .eq('event_type', 'vendor_active')
      .order('created_at', { ascending: false })
      .limit(50)
    const last = ((data || []) as Array<{ created_at: string; metadata: { application_id?: string } | null }>)
      .find((e) => e.metadata?.application_id === appId)?.created_at ?? null
    if (!shouldPing(last)) return

    const facts = loginFacts(headers)
    const place = placeLabel(facts)
    const state = parsePortalState(app.admin_notes || null)
    const due = computePaymentDue({ reviewed_at: app.reviewed_at || null })

    await db.from('site_events').insert({
      session_id: 'vendor_active',
      event_type: 'vendor_active',
      path: '/exhibitor/portal',
      metadata: {
        actor: (app.email || '').toLowerCase() || null,
        application_id: appId,
        business_name: app.business_name || null,
        ip: facts.ip, city: facts.city, region: facts.region, country: facts.country, place,
      },
    })

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
      stallCode: parseAllocation(app.admin_notes || null).stall || null,
      events: (ev || []) as { event_type: string; created_at: string }[],
      inbound: (inbound || []) as { body: string | null; created_at: string }[],
      priorLogins: [],
      dueDate: due,
      daysToDue: daysUntil(due),
    }

    const body = buildLoginAlert({
      businessName: String(app.business_name || 'A vendor'),
      contactName: (app.contact_name as string) || null,
      place,
      ip: facts.ip,
      activity,
      source: 'existing session',
      action: 'is on their portal right now.',
    })

    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({ event: 'system_alert', audience: 'master', body }).catch(() => {})
  } catch (e) {
    console.error('[vendor-activity-ping] failed:', (e as Error).message)
  }
}
