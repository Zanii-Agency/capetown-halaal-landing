// Vendor WhatsApp opt-in from the exhibitor portal banner.
//
// Captures consent (per wa-consent.ts source-of-truth), persists the chosen WA
// number on the application's portal-state marker (no DDL), and fires an
// approved welcome template so the vendor immediately gets a real message in
// their inbox — that's their "did it actually work?" feedback.
//
// Only logged-in approved exhibitors can opt in for themselves.
//
// PHONE-CHANGE GATE (B4, 2026-06-15):
// If the submitted phone differs from the application's existing phone, we
// DO NOT update vendor_applications.phone or fire the welcome template. We
// stash the proposed number under portal_state.phone_change_pending with a
// hashed 6-digit code, deliver the code to the NEW number via the utility
// template, and return { ok: true, verification_pending: true }. The vendor
// then POSTs the code to /api/exhibitor/wa-optin/verify which copies the
// pending phone over the live one. Reason: prior version trusted any phone
// body field a logged-in vendor sent and silently overwrote vendor_applications.phone,
// which an attacker who phished/intercepted a session could use to hijack
// every future outbound (approval, reminders, payment links) to a number
// they control.

import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomInt } from 'node:crypto'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { recordConsent } from '@/lib/wa-consent'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { tierLabel } from '@/lib/stalls'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function hashOtp(code: string, applicationId: string): string {
  return createHash('sha256').update(`${code}:${applicationId}`).digest('hex')
}

export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ ok: false, error: 'Sign in first.' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const rawPhone = String(body.phone || '').trim()
  if (!rawPhone) return NextResponse.json({ ok: false, error: 'Phone is required.' }, { status: 400 })

  const e164 = toE164(rawPhone)
  if (!/^\+\d{8,15}$/.test(e164)) {
    return NextResponse.json({ ok: false, error: 'Not a valid WhatsApp number.' }, { status: 400 })
  }

  const app = ctx.application
  const applicationId = app.id as string
  const contactName = (app.contact_name as string) || ctx.email
  const firstName = contactName.trim().split(/\s+/)[0] || contactName
  const tier = (app.preferred_booth_tier as string) || ''
  const stallLabel = tier ? tierLabel(tier) : 'your stall'

  // Existing phone on file. Compare in E.164 to be tolerant of formatting
  // differences. If the vendor is changing to a new number, we gate; if they
  // are confirming their existing number (first-time opt-in), we fast-path.
  const existingPhoneRaw = (app.phone as string | null) || ''
  const existingE164 = existingPhoneRaw ? toE164(existingPhoneRaw) : ''
  const isPhoneChange = existingE164 && existingE164 !== e164

  // ---------------- PATH A: phone-change verification gate ----------------
  if (isPhoneChange) {
    // RE-MINT THROTTLE (audit MED-3 / cost-drain). Each mint fires a WhatsApp
    // template to an attacker-typed `new_phone`, so an unthrottled re-request is
    // both a send-cost drain AND a way to spam a third party's number with codes.
    // Refuse a fresh code within 60s of the last one (reuse the existing
    // requested_at — no new field, no DDL).
    const prevPending = parsePortalState((app.admin_notes as string) || '').phone_change_pending
    if (prevPending?.requested_at && Date.now() - Date.parse(prevPending.requested_at) < 60_000) {
      return NextResponse.json(
        { ok: false, error: 'A code was just sent to that number. Please wait a minute before requesting another.' },
        { status: 429 },
      )
    }
    // Mint a 6-digit code, hash it (we never persist the plaintext), and
    // park the candidate phone in portal_state.phone_change_pending. The
    // verify endpoint validates against this hash before promoting the phone.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const codeHash = hashOtp(code, applicationId)
    const now = new Date().toISOString()

    await updatePortalState(applicationId, (s) => ({
      ...s,
      phone_change_pending: {
        new_phone: e164,
        code_hash: codeHash,
        requested_at: now,
        attempts: 0,
      },
    }))

    // Deliver the code to the NEW number. We use the existing
    // `vendor_application_approved` utility template with the code substituted
    // into the stall slot as the user-visible payload. A purpose-built
    // `vendor_phone_verify` template should land via Meta approval next
    // sprint; until then this re-use keeps the OTP delivery on a utility
    // template (always sendable) without requiring template provisioning.
    let codeSent = false
    let codeError: string | null = null
    try {
      const res = await sendTemplate(
        e164,
        'vendor_application_approved',
        [firstName, `Verification code ${code}, enter this in the portal to confirm your new WhatsApp number.`],
        { category: 'utility' }
      )
      codeSent = !res.skipped
      codeError = res.skipped || null
      const db = createAdminClient()
      await db.from('wa_messages').insert({
        direction: 'out',
        wa_phone: e164,
        body: `[phone_change_verify] code sent to ${contactName} for ${applicationId}`,
        status: res.skipped ? 'failed' : 'sent',
        provider_message_id: res.messageId || null,
        error: res.skipped || null,
      })
    } catch (e) {
      codeError = (e as Error).message
      console.error('[wa-optin] code send failed:', codeError)
    }

    return NextResponse.json({
      ok: true,
      verification_pending: true,
      message: 'A 6-digit code has been sent to the new WhatsApp number. Enter it in the portal to confirm the change.',
      codeSent,
      codeError,
    })
  }

  // ---------------- PATH B: first-time opt-in (no phone change) ----------------

  // 1) Mark portal-state as opted-in so the banner disappears for them.
  await updatePortalState(applicationId, (s) => ({
    ...s,
    wa: {
      phone: e164,
      opted_in_at: new Date().toISOString(),
      welcome_sent: false, // updated below after send
    },
  }))

  // 2) Source-of-truth consent in wa_contacts. This is the table the consent
  // gate (canSend) reads, so future marketing templates are NOT blocked.
  try {
    await recordConsent({
      waPhone: e164,
      source: 'vendor_form',
      profileName: contactName,
    })
  } catch (e) {
    console.error('[wa-optin] recordConsent failed:', (e as Error).message)
  }

  // 3) Sync vendor_applications.phone to the opted-in number — but ONLY when
  // there was no existing phone on file (first-time opt-in). When the vendor
  // is changing an existing number we go through PATH A above and never reach
  // this branch unverified.
  if (!existingE164) {
    try {
      const admin = createAdminClient()
      await admin.from('vendor_applications').update({ phone: e164 }).eq('id', applicationId)
    } catch (e) {
      console.error('[wa-optin] sync phone failed:', (e as Error).message)
    }
  }

  // 4) Immediate welcome via the approved vendor_application_approved template.
  //    Body slots: {{1}} = first name, {{2}} = stall label.
  //    Why this template: their action ("I want updates") is most-similarly
  //    framed as "you're approved + we'll be in touch", and it's already
  //    approved on Meta. Outside the 24h window so we MUST use a template.
  let welcomeSent = false
  try {
    const res = await sendTemplate(
      e164,
      'vendor_application_approved',
      [firstName, stallLabel],
      { category: 'utility' }
    )
    welcomeSent = !res.skipped
    const db = createAdminClient()
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: e164,
      body: `[vendor_application_approved] Welcome WA for ${contactName}, stall: ${stallLabel}`,
      status: res.skipped ? 'failed' : 'sent',
      provider_message_id: res.messageId || null,
      error: res.skipped || null,
    })
  } catch (e) {
    console.error('[wa-optin] welcome send failed:', (e as Error).message)
  }

  // Mark welcome sent so we don't re-fire on subsequent opt-in clicks.
  if (welcomeSent) {
    await updatePortalState(applicationId, (s) => ({
      ...s,
      wa: { ...(s.wa as NonNullable<typeof s.wa>), welcome_sent: true },
    }))
  }

  // 5) Owners get a notification — duplicate to Taona per his rule.
  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'system_alert',
      body: `WA opt-in: ${contactName} (${app.business_name}) subscribed at ${e164}.`,
      audience: 'all',
    })
  } catch (e) {
    console.error('[wa-optin] notify owners failed:', (e as Error).message)
  }

  return NextResponse.json({ ok: true, welcomeSent, e164 })
}
