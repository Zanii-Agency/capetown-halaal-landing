import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email/resend'
import { ApplicationDelayNotice } from '@/lib/email/templates/ApplicationDelayNotice'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { assertRole } from '@/lib/admin-rbac'

export const maxDuration = 300

function getFirstName(contactName: string | null | undefined): string {
  if (!contactName) return 'there'
  const first = contactName.trim().split(/\s+/)[0]
  return first || 'there'
}

type AuthResult =
  | { ok: true; caller: 'admin' | 'cron' }
  | { ok: false; response: NextResponse }

async function authorize(request: NextRequest): Promise<AuthResult> {
  if (verifyCronAuth(request.headers.get('authorization'))) {
    return { ok: true, caller: 'cron' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const admin = createAdminClient()
  const { data: adminUser } = await admin
    .from('admin_users')
    .select('id')
    .eq('id', user.id)
    .single()

  if (!adminUser) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  // Role gate (admin path only — the cron path returned above and is unaffected).
  // Broadcasting delay notices sends live email; viewer must not trigger it.
  try {
    await assertRole(user.id, ['owner', 'operator'])
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'insufficient_role' }, { status: 403 }) }
  }

  return { ok: true, caller: 'admin' }
}

async function findEligibleApplicants(minDaysOld: number) {
  const admin = createAdminClient()
  let query = admin
    .from('vendor_applications')
    .select('id, email, contact_name, business_name, created_at')
    .in('status', ['pending', 'info_requested'])
    .is('delay_notice_sent_at', null)
    .order('created_at', { ascending: true })

  if (minDaysOld > 0) {
    const threshold = new Date(Date.now() - minDaysOld * 24 * 60 * 60 * 1000).toISOString()
    query = query.lt('created_at', threshold)
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

async function broadcastDelayNotices(minDaysOld: number) {
  const admin = createAdminClient()
  const eligible = await findEligibleApplicants(minDaysOld)

  let sent = 0
  let failed = 0
  const failures: Array<{ email: string; error: string }> = []

  for (const app of eligible) {
    const firstName = getFirstName(app.contact_name)
    try {
      await sendEmail({
        to: app.email,
        subject: 'An update on your Young at Heart Festival 2026 application',
        react: ApplicationDelayNotice({
          firstName,
          businessName: app.business_name,
        }),
      })

      const { error: stampError } = await admin
        .from('vendor_applications')
        .update({ delay_notice_sent_at: new Date().toISOString() })
        .eq('id', app.id)

      if (stampError) {
        console.error(`Failed to stamp delay_notice_sent_at for ${app.email}:`, stampError)
      }

      sent++
    } catch (e) {
      failed++
      const message = e instanceof Error ? e.message : String(e)
      failures.push({ email: app.email, error: message })
      console.error(`Failed to send delay notice to ${app.email}:`, e)
    }

    await new Promise((r) => setTimeout(r, 2000))
  }

  return {
    eligibleCount: eligible.length,
    sent,
    failed,
    failures: failures.slice(0, 20),
  }
}

export async function GET(request: NextRequest) {
  const auth = await authorize(request)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(request.url)
  const minDaysOld = parseInt(searchParams.get('minDaysOld') || '0', 10)

  if (auth.caller === 'cron') {
    try {
      const result = await broadcastDelayNotices(minDaysOld)
      console.log('Cron delay-notice broadcast:', result)
      return NextResponse.json(result)
    } catch (e) {
      console.error('Cron broadcast failed:', e)
      return NextResponse.json({ error: 'Broadcast failed' }, { status: 500 })
    }
  }

  try {
    const eligible = await findEligibleApplicants(minDaysOld)
    return NextResponse.json({
      eligibleCount: eligible.length,
      preview: eligible.slice(0, 10).map((a) => ({
        email: a.email,
        firstName: getFirstName(a.contact_name),
        businessName: a.business_name,
        createdAt: a.created_at,
      })),
    })
  } catch (e) {
    console.error('Preview error:', e)
    return NextResponse.json({ error: 'Failed to load eligible applicants' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(request.url)
  const minDaysOld = parseInt(searchParams.get('minDaysOld') || '0', 10)
  const dryRun = searchParams.get('dryRun') === 'true'

  if (dryRun) {
    try {
      const eligible = await findEligibleApplicants(minDaysOld)
      return NextResponse.json({ dryRun: true, eligibleCount: eligible.length })
    } catch (e) {
      console.error('Query error:', e)
      return NextResponse.json({ error: 'Failed to load eligible applicants' }, { status: 500 })
    }
  }

  try {
    const result = await broadcastDelayNotices(minDaysOld)
    return NextResponse.json(result)
  } catch (e) {
    console.error('Broadcast failed:', e)
    return NextResponse.json({ error: 'Broadcast failed' }, { status: 500 })
  }
}
