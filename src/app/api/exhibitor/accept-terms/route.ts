// Records that the signed-in vendor has explicitly accepted the YAH terms &
// conditions inside the portal. Stores ISO timestamp on portal_state.
// Idempotent: re-accepting just refreshes the timestamp.

import { NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { updatePortalState } from '@/lib/portal-state'
import { recordVendorAction } from '@/lib/vendor-action-log'

export const dynamic = 'force-dynamic'

export async function POST() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const applicationId = ctx.application.id as string
  const at = new Date().toISOString()
  await updatePortalState(applicationId, (s) => ({ ...s, terms_accepted_at: at }))
  await recordVendorAction({ applicationId, eventType: 'terms_accepted', actorEmail: ctx.email })
  return NextResponse.json({ ok: true, terms_accepted_at: at })
}
