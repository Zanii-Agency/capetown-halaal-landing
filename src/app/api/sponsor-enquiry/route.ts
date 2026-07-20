import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'
import { sendEmail, ADMIN_EMAIL } from '@/lib/email/resend'
import {
  checkHoneypot,
  checkEmail,
  checkTokens,
  checkIpThrottle,
  logGuardEvent,
  clientIp,
  HONEYPOT_FIELD,
} from '@/lib/security/abuse-guard'

const ENQUIRY_ENDPOINT = 'sponsor-enquiry'

// Mirror of the public form in src/components/sponsors-section.tsx. Name,
// company, email and phone are required there; message is optional. `tier`
// is the sponsorship package the enquirer clicked "Enquire" on.
const enquirySchema = z.object({
  name: z.string().min(1, 'Name required'),
  company: z.string().min(1, 'Company required'),
  email: z.string().email('Valid email required'),
  phone: z.string().min(1, 'Phone number required'),
  tier: z.string().min(1).optional().default('General sponsorship'),
  message: z.string().optional().default(''),
})

// POST: Sponsorship enquiry from the public sponsors section (real revenue lead).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const supabase = createAdminClient()
    const ip = clientIp(request.headers)

    // 1. Honeypot. Silent 200 so bots cannot probe the defense.
    const hp = checkHoneypot(body)
    if (!hp.ok) {
      await logGuardEvent(supabase, { endpoint: ENQUIRY_ENDPOINT, ip, reason: hp.reason!, fields: { hp: String(body[HONEYPOT_FIELD] ?? '').slice(0, 64) } })
      return NextResponse.json({ ok: true })
    }

    // 2. Attacker payloads in any free-text field, before Zod so we never echo
    //    scanner tokens back through a validation error.
    const tokenGuard = checkTokens(body?.name, body?.company, body?.email, body?.phone, body?.tier, body?.message)
    if (!tokenGuard.ok) {
      await logGuardEvent(supabase, { endpoint: ENQUIRY_ENDPOINT, ip, reason: tokenGuard.reason!, fields: { email: body?.email } })
      return NextResponse.json({ error: 'Submission rejected.' }, { status: 400 })
    }

    const validated = enquirySchema.parse(body)

    // 3. Reserved TLDs + disposable providers. Real sponsors do not use these.
    const emailGuard = checkEmail(validated.email)
    if (!emailGuard.ok) {
      await logGuardEvent(supabase, { endpoint: ENQUIRY_ENDPOINT, ip, reason: emailGuard.reason!, fields: { email: validated.email } })
      return NextResponse.json({ error: 'Please use a real business email address.' }, { status: 400 })
    }

    // 4. Per-IP throttle. Falls open on a DB blip so real sponsors are never blocked.
    const throttle = await checkIpThrottle(supabase, { ip, endpoint: ENQUIRY_ENDPOINT, max: 3, windowMin: 10 })
    if (!throttle.ok) {
      await logGuardEvent(supabase, { endpoint: ENQUIRY_ENDPOINT, ip, reason: throttle.reason!, fields: { email: validated.email } })
      return NextResponse.json({ error: 'Too many submissions. Please wait a few minutes and try again.' }, { status: 429 })
    }

    // No-em-dashes law (CTH-DOCTRINE Law 7): the subject is owner-facing internal
    // mail, but keep the convention. Use a colon separator, not an em-dash.
    const subject = `Sponsorship enquiry: ${validated.tier} (${validated.company})`
    const text = [
      'New sponsorship enquiry',
      `Package: ${validated.tier}`,
      `Name: ${validated.name}`,
      `Company: ${validated.company}`,
      `Email: ${validated.email}`,
      `Phone: ${validated.phone}`,
      validated.message ? `Message:\n${validated.message}` : '',
    ].filter(Boolean).join('\n')

    // Email the festival owner. Reply-To set to the enquirer so the owner can
    // respond to the lead directly from the inbox. This is the load-bearing
    // step: if it fails we surface a real error, never fake success.
    const res = await sendEmail({
      to: ADMIN_EMAIL,
      subject,
      text,
      replyTo: validated.email,
      extraHeaders: { 'X-Entity-Ref-ID': 'sponsor-enquiry' },
    })

    if (!res.ok) {
      console.error(`[sponsor-enquiry] owner email FAILED for ${validated.email}: ${res.error}`)
      return NextResponse.json(
        { error: 'We could not submit your enquiry right now. Please email support@youngatheart.co.za directly.' },
        { status: 502 }
      )
    }

    // Best-effort owner WhatsApp ping — never block the lead on this.
    try {
      const { notifyOwners } = await import('@/lib/bot/notify')
      await notifyOwners({
        event: 'system_alert',
        body: `New sponsorship enquiry: ${validated.company} (${validated.email}) for ${validated.tier}.`,
        audience: 'all',
      })
    } catch (notifyError) {
      console.error('[sponsor-enquiry] notify owner failed:', notifyError)
    }

    // Best-effort acknowledgement to the enquirer, mirroring the apply flow.
    try {
      await sendEmail({
        to: validated.email,
        subject: 'We received your sponsorship enquiry: Young at Heart Festival 2026',
        text: `Hi ${validated.name},\n\nThank you for your interest in sponsoring Young at Heart Festival 2026. We have received your enquiry about the ${validated.tier} package and our team will be in touch within 24 hours.\n\nYoung at Heart Festival\nsupport@youngatheart.co.za`,
      })
    } catch (ackError) {
      console.error('[sponsor-enquiry] enquirer ack failed:', ackError)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.issues },
        { status: 400 }
      )
    }
    console.error('Sponsor enquiry error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
