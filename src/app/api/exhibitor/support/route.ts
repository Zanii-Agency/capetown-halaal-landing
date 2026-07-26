import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { updatePortalState, parsePortalState, type SupportMessage } from '@/lib/portal-state'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  checkIpThrottle,
  logGuardEvent,
  clientIp,
} from '@/lib/security/abuse-guard'

const ENDPOINT = 'exhibitor-support'
// Hard cap to keep admin_notes JSON from unbounded growth if a vendor script
// somehow squeezes past the rate limit. Older messages truncate first.
const MAX_SUPPORT_MESSAGES = 200
// Per-vendor (NOT per-IP) ceiling: 10 messages / hour. A vendor running 5000
// posts would flood Samreen's WA + Resend reputation; this stops it dead.
const MAX_PER_HOUR = 10
const WINDOW_MIN = 60

// GET: the signed-in vendor's support thread.
export async function GET() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const state = parsePortalState(ctx.application.admin_notes as string)
  return NextResponse.json({ messages: state.support || [] })
}

// POST: vendor sends a message.
export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string
  const body = await req.json().catch(() => ({}))
  const text = String(body.body || '').trim().slice(0, 2000)
  // also_email defaults ON. The vendor can opt out via the toggle in
  // SupportThread; WA + inbox thread still fire either way.
  const alsoEmail = body.also_email !== false
  if (!text) return NextResponse.json({ error: 'Message is empty' }, { status: 400 })

  // Per-vendor throttle keyed on user.id so a single vendor cannot weaponise
  // the support thread. checkIpThrottle is a general "key throttle" against
  // site_events — passing user.id as the "ip" field keys it on the vendor.
  const admin = createAdminClient()
  const ip = clientIp(req.headers)
  const vendorKey = ctx.userId
  const throttle = await checkIpThrottle(admin, {
    ip: vendorKey,
    endpoint: ENDPOINT,
    max: MAX_PER_HOUR,
    windowMin: WINDOW_MIN,
  })
  if (!throttle.ok) {
    await logGuardEvent(admin, {
      endpoint: ENDPOINT,
      ip: vendorKey,
      reason: throttle.reason!,
      fields: { applicationId, real_ip: ip ?? null },
    })
    return NextResponse.json(
      { error: 'Too many support messages, slow down and try again later' },
      { status: 429 },
    )
  }
  // Log the hit so the throttle counter increments for THIS message too.
  await logGuardEvent(admin, {
    endpoint: ENDPOINT,
    ip: vendorKey,
    reason: 'rate_limited',
    fields: { applicationId, real_ip: ip ?? null, kind: 'send' },
  })

  const msg: SupportMessage = { id: `${Date.now()}`, from: 'vendor', body: text, at: new Date().toISOString() }
  const next = await updatePortalState(applicationId, (s) => {
    const existing = s.support || []
    const appended = [...existing, msg]
    // Truncate oldest first if the thread overflows the cap.
    const trimmed = appended.length > MAX_SUPPORT_MESSAGES
      ? appended.slice(appended.length - MAX_SUPPORT_MESSAGES)
      : appended
    return { ...s, support: trimmed }
  })

  // Best-effort owner notifications. Failure here never blocks the vendor's send.
  const bizName = ctx.application.business_name as string
  const contact = (ctx.application.contact_name as string) || ''
  // Vendor email MUST come from the authenticated Supabase session, never from
  // request body or the application row (which can drift). This is the address
  // admins reply to.
  const vendorEmail = ctx.email || ''
  const phone = (ctx.application.phone as string) || ''

  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'vendor_support_message',
      body: `${bizName} (${contact || vendorEmail}): ${text.slice(0, 240)}`,
      audience: 'all',
      // Questions reach the owner only from vendors SHE owns (paid via Yoco,
      // cash or waived). An unpaid vendor's question is the master's.
      vendorId: ctx.application.id as string,
    })
  } catch (e) {
    console.error('[exhibitor/support] notifyOwners failed:', (e as Error).message)
  }

  // Email is a bonus channel. WA + the inbox thread are durable; if Resend
  // throttles or fails we log it and still return success to the vendor.
  // CTH-DOCTRINE Law 5: append throttle hits to docs/throttle-log.md.
  // CTH-DOCTRINE Law 7: no em-dashes in subject/body.
  if (alsoEmail) {
    try {
      const { sendEmail } = await import('@/lib/email/resend')
      const snippet = text.slice(0, 30).replace(/[—–]/g, ':').trim()
      const subject = `Vendor support: ${bizName}, ${snippet}`
      const bodyText = [
        `Vendor: ${contact || '(name not on file)'}`,
        `Business: ${bizName}`,
        `Application ID: ${applicationId}`,
        `Phone: ${phone || '(not on file)'}`,
        `Vendor email: ${vendorEmail || '(not on file)'}`,
        '',
        'Message:',
        text,
        '',
        `Reply to the vendor directly at ${vendorEmail || 'support@youngatheart.co.za'} to respond. The inbox thread at /admin/support also captures this message.`,
      ].join('\n')
      const result = await sendEmail({
        to: 'support@youngatheart.co.za',
        subject,
        text: bodyText,
        replyTo: vendorEmail || undefined,
      })
      if (!result.ok) {
        const err = result.error || 'unknown'
        // CTH-DOCTRINE Law 5: throttle hits get tagged with a grep-able prefix
        // so they surface in Vercel logs and can be rolled into
        // docs/throttle-log.md on review. Filesystem appends do not persist on
        // serverless, so we lean on structured log lines + the site_events
        // table the abuse guard already writes to.
        if (/throttl|rate.?limit|429|too many/i.test(err)) {
          console.error(
            `[throttle-log] endpoint=exhibitor-support applicationId=${applicationId} channel=resend err=${err}`,
          )
          await logGuardEvent(admin, {
            endpoint: ENDPOINT,
            ip: vendorKey,
            reason: 'rate_limited',
            fields: { applicationId, channel: 'resend', err, kind: 'email_throttle' },
          }).catch(() => {})
        } else {
          console.error('[exhibitor/support] email send not ok:', err)
        }
      }
    } catch (e) {
      console.error('[exhibitor/support] email failed:', (e as Error).message)
    }
  }

  return NextResponse.json({ success: true, messages: next.support })
}
