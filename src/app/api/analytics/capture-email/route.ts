import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { ApplicationIncomplete } from '@/lib/email/templates/ApplicationIncomplete'
import {
  checkHoneypot,
  checkEmail,
  checkTokens,
  checkIpThrottle,
  logGuardEvent,
  clientIp,
} from '@/lib/security/abuse-guard'

const ENDPOINT = 'capture-email'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { email, name, business } = body as {
      email?: string
      name?: string
      business?: string
    }

    const admin = createAdminClient()
    const ip = clientIp(req.headers)

    // 1. Honeypot. Silent success so bots cannot fingerprint the defense.
    const hp = checkHoneypot(body)
    if (!hp.ok) {
      await logGuardEvent(admin, { endpoint: ENDPOINT, ip, reason: hp.reason!, fields: { email } })
      return NextResponse.json({ ok: true })
    }

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
    }

    // 2. Email format + reserved TLD + disposable provider.
    const emailGuard = checkEmail(email)
    if (!emailGuard.ok) {
      await logGuardEvent(admin, { endpoint: ENDPOINT, ip, reason: emailGuard.reason!, fields: { email } })
      return NextResponse.json({ ok: true })
    }

    // 3. Obvious scanner payloads in any free-text field.
    const tokenGuard = checkTokens(email, name, business)
    if (!tokenGuard.ok) {
      await logGuardEvent(admin, { endpoint: ENDPOINT, ip, reason: tokenGuard.reason!, fields: { email, name, business } })
      return NextResponse.json({ ok: true })
    }

    // 4. Per-IP throttle on guard hits + previous captures.
    const throttle = await checkIpThrottle(admin, { ip, endpoint: ENDPOINT, max: 5, windowMin: 10 })
    if (!throttle.ok) {
      await logGuardEvent(admin, { endpoint: ENDPOINT, ip, reason: throttle.reason!, fields: { email } })
      return NextResponse.json({ ok: true })
    }

    // Check if we already captured this email (don't spam)
    const { data: existing } = await admin
      .from('site_events')
      .select('id')
      .eq('event_type', 'apply_email_captured')
      .contains('metadata', { email })
      .limit(1)

    if (existing && existing.length > 0) {
      return NextResponse.json({ ok: true, already_captured: true })
    }

    // Store the captured email
    await admin.from('site_events').insert({
      session_id: 'capture',
      event_type: 'apply_email_captured',
      path: '/apply',
      metadata: { email, name: name || '', business: business || '', ip: ip ?? null },
    })

    // Send follow-up email to the potential vendor
    try {
      await sendEmail({
        to: email,
        subject: 'Complete Your Vendor Application, Young at Heart Festival 2026',
        react: ApplicationIncomplete({
          contactName: name || undefined,
          businessName: business || undefined,
        }),
        text: `Hi ${name || 'there'},

We noticed you started a vendor application for ${business ? business + ' at ' : ''}Young at Heart Festival 2026 but didn't complete it.

We'd love to have you. Here's what you need to know:
- 264 booth spaces available across food, fashion, wellness, and more
- Booth prices from R3,700 to R12,000
- Festival dates: December 11-13, 2026 at Youngsfield Military Base, Cape Town
- 25,000+ expected visitors over 3 days

Complete your application here: https://cthalaal.co.za/apply

Spots are filling up fast. If you have any questions, reply to this email or contact us at:
- Email: support@youngatheart.co.za
- Phone: 065 943 5012
- Instagram: @youngatheart_capetown

We look forward to welcoming you.

Warm regards,
The Young at Heart Festival Team
youngatheart.co.za`,
      })
    } catch (emailError) {
      console.error('Capture email send error:', emailError)
    }

    // Notify admin team
    const adminText = `A potential vendor started the application but didn't finish.

Email: ${email}
Name: ${name || 'Not provided'}
Business: ${business || 'Not provided'}

They've been sent a follow-up email automatically.

View all applications: https://cthalaal.co.za/admin/applications
Contacts (started/incomplete applications): https://cthalaal.co.za/admin/contacts`

    try {
      // Lead notice goes to the festival owner only. No agency copy.
      await sendEmail({
        to: 'capetownhalaal@gmail.com',
        subject: `[Lead] ${business || email} started but didn't complete vendor application`,
        text: adminText,
      })
    } catch (adminEmailError) {
      console.error('Admin notification error:', adminEmailError)
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true }) // Never break UX
  }
}
