// Unified inbox vendor context — the at-a-glance facts a support agent needs
// without leaving the conversation: application status, payment, stall, docs,
// tier. Read from vendor_applications + portal_state markers (no DDL, Law 8).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { laneScopeFor, } from '@/lib/inbox-lane'
import { visiblePaymentStatus } from '@/lib/eft'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const applicationId = new URL(req.url).searchParams.get('applicationId')
  if (!applicationId) return NextResponse.json({ context: null, supported: false })

  // THE SEAL. This route takes an applicationId straight off the query string,
  // so it answers for ANY vendor whose id the caller can name — including one
  // the thread list deliberately withheld. A filtered list in front of an
  // unfiltered reader is cosmetic (lib/inbox-lane.ts:6). The list is what makes
  // this hard to reach, not this route, and "hard to reach" is not a wall.
  const scope = await laneScopeFor(user.email)
  if (scope.blocksApplicationId(applicationId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: app } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, status, preferred_booth_tier, sector, paid_at, docs_complete_at, contract_signed_at, admin_notes')
    .eq('id', applicationId)
    .maybeSingle()
  if (!app) return NextResponse.json({ context: null, supported: false })

  const portal = parsePortalState(app.admin_notes || '')
  // Multi-booth: join the vendor's code list ("FS1, FS2") for the context chip.
  const { stalls } = parseAllocation(app.admin_notes || '')
  const stall = stalls.length ? stalls.join(', ') : null
  const payment = portal.payment || {}

  return NextResponse.json({
    supported: true,
    context: {
      status: app.status || 'unknown',
      tier: app.preferred_booth_tier || null,
      sector: app.sector || null,
      payment: {
        // Masked, like the four other readers of this field. 'collected' is the
        // interim EFT state and means money the festival owner did not take;
        // showing it to her here would undo the wall the rest of the app keeps.
        status: visiblePaymentStatus(payment.status || (app.paid_at ? 'paid' : 'none'), user.email),
        amount: payment.amount ?? null,
        paid_at: payment.paid_at || app.paid_at || null,
      },
      stall: stall,
      docs_complete: !!app.docs_complete_at,
      contract_signed: !!app.contract_signed_at,
    },
  })
}
