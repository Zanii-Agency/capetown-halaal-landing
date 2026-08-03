// Portal action audit log.
//
// vendor_login_alert.ts builds a summary of what a vendor has done when they log
// in, but that summary is only as good as the events it reads. Several portal
// routes already write vendor_application_events; this helper makes it trivial
// for the rest to do the same, so the login summary stays accurate.

import { createAdminClient } from '@/lib/supabase/admin'

export interface VendorActionInput {
  applicationId: string
  eventType: string
  actorEmail?: string | null
  note?: string
  beforeValue?: string | null
  afterValue?: string | null
}

/** Best-effort. Never throws. */
export async function recordVendorAction(input: VendorActionInput): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.from('vendor_application_events').insert({
      application_id: input.applicationId,
      event_type: input.eventType,
      actor_email: input.actorEmail || 'vendor@portal',
      actor_role: 'vendor',
      note: input.note || undefined,
      before_value: input.beforeValue || undefined,
      after_value: input.afterValue || undefined,
    })
  } catch (e) {
    console.error('[vendor-action-log] failed:', (e as Error).message)
  }
}
