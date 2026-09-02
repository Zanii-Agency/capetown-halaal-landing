import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { PasswordReset } from '@/lib/email/templates/PasswordReset'
import { normalizeEmail } from '@/lib/email-normalize'
import {
  checkIpThrottle,
  logGuardEvent,
  clientIp,
} from '@/lib/security/abuse-guard'

export const dynamic = 'force-dynamic'

const ENDPOINT_IP = 'password-reset'
const ENDPOINT_EMAIL = 'password-reset-email'

// Sends a BRANDED exhibitor password-reset email instead of Supabase's generic
// default. We mint a recovery action_link with the service-role client and mail
// it through our own (DKIM-signed, Young at Heart branded) sender. Always
// responds { ok: true } so the endpoint never leaks which emails have accounts.
export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json()

    // TRUTH FOR INTERNAL CALLERS ONLY.
    //
    // This endpoint answers {ok:true} to everyone so an attacker cannot probe
    // which addresses have accounts. That contract is right for the public, and
    // it is exactly what hid a real failure from the vendor: the bot called
    // here, got {ok:true}, and told Raeesa Jenkins "Sent" three times over five
    // weeks while every message bounced off a typo'd address
    // (raeesajenkjns@ for raeesajenkins@). The same thing happened to
    // Mias Chill Station on 2026-07-27. Detection worked both times and alerted
    // the master; the person who needed to know was the only one not told.
    //
    // A caller bearing CRON_SECRET is our own server, acting for an ALREADY
    // VERIFIED vendor about the address on their OWN application. It cannot
    // enumerate anything it does not already hold, so it gets the real result.
    const secret = process.env.CRON_SECRET
    const auth = req.headers.get('authorization') || ''
    const isInternal = !!secret && auth === `Bearer ${secret}`
    let delivered = false
    let deliveryReason: string | null = 'no attempt made'
    const reply = () => NextResponse.json(isInternal ? { ok: true, delivered, reason: deliveryReason } : { ok: true })
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
    }

    // V8: throttle per-IP AND per-email so 10 rapid identical posts don't
    // email-bomb the user and rinse Resend domain reputation. checkIpThrottle
    // works as a generic "key throttle" — we use the email itself as the key
    // for the second guard.
    const admin = createAdminClient()
    const ip = clientIp(req.headers)
    const lowEmailEarly = normalizeEmail(email)

    const ipGuard = await checkIpThrottle(admin, {
      ip,
      endpoint: ENDPOINT_IP,
      max: 5,
      windowMin: 10,
    })
    if (!ipGuard.ok) {
      await logGuardEvent(admin, { endpoint: ENDPOINT_IP, ip, reason: ipGuard.reason!, fields: {} })
      return reply()
    }
    const emailGuard = await checkIpThrottle(admin, {
      ip: lowEmailEarly,
      endpoint: ENDPOINT_EMAIL,
      max: 3,
      windowMin: 10,
    })
    if (!emailGuard.ok) {
      await logGuardEvent(admin, {
        endpoint: ENDPOINT_EMAIL,
        ip: lowEmailEarly,
        reason: emailGuard.reason!,
        fields: { real_ip: ip ?? null },
      })
      deliveryReason = 'throttled, too many resets for this address'
      return reply()
    }
    // Increment counters so the next call sees this attempt.
    await logGuardEvent(admin, {
      endpoint: ENDPOINT_IP,
      ip,
      reason: 'rate_limited',
      fields: { kind: 'attempt' },
    })
    await logGuardEvent(admin, {
      endpoint: ENDPOINT_EMAIL,
      ip: lowEmailEarly,
      reason: 'rate_limited',
      fields: { kind: 'attempt', real_ip: ip ?? null },
    })

    // Route through /auth/callback so the PKCE code gets exchanged for a session
    // BEFORE the user lands on set-password. Otherwise set-password has no session
    // and updateUser({password}) silently fails.
    const origin = new URL(req.url).origin
    const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent('/exhibitor/set-password')}`

    const lowEmail = lowEmailEarly
    const tag = `[send-password-reset] ${lowEmail}`

    try {
      const { data, error } = await admin.auth.admin.generateLink({
        type: 'recovery',
        email: lowEmail,
        options: { redirectTo },
      })

      if (error) {
        // Most common cause: no Supabase Auth user for this email. Vendors only
        // get a Supabase Auth account after their application is APPROVED
        // (provisionExhibitorAccount in src/lib/exhibitor-auth.ts). Pending
        // applicants who hit "forgot password" land here.
        console.warn(`${tag} generateLink rejected: ${error.message} (often: no auth user, user may be unapproved)`)
        deliveryReason = 'no portal account exists for this address'
        return reply()
      }

      // IMPORTANT: we do NOT use data.properties.action_link directly. That
      // link points at Supabase's /auth/v1/verify endpoint which redirects back
      // with either ?code= (PKCE) or #access_token= (implicit). Neither works
      // cleanly here. Instead we use data.properties.hashed_token + type and
      // route through our own callback that calls verifyOtp({type, token_hash})
      // — stateless verification, no code_verifier needed.
      const hashedToken = data?.properties?.hashed_token
      const verificationType = data?.properties?.verification_type

      if (!hashedToken || !verificationType) {
        console.error(`${tag} generateLink returned no hashed_token (response shape changed?)`)
        deliveryReason = 'could not mint a reset link'
        return reply()
      }

      const params = new URLSearchParams({
        token_hash: hashedToken,
        type: verificationType,
        next: '/exhibitor/set-password',
      })
      const resetUrl = `${origin}/auth/callback?${params.toString()}`
      const contactName = (data.user?.user_metadata?.business_name as string | undefined) || undefined

      const sendRes = await sendEmail({
        to: email.trim(),
        subject: 'Reset your Young at Heart Festival exhibitor password',
        react: PasswordReset({ resetUrl, contactName }),
        text: `Hi ${contactName || 'there'},\n\nWe received a request to reset your Young at Heart Festival exhibitor password. Use this link (expires in 1 hour) to choose a new one:\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.\n\nWarm regards,\nThe Young at Heart Festival Team`,
        // KT #206657: Resend can accept the send and then silently suppress the
        // recipient. Confirm it actually left so the ops alert below fires on
        // suppression too, not just on hard API failures.
        confirmDelivery: true,
      })

      delivered = !!sendRes?.ok
      deliveryReason = sendRes?.ok ? null : (sendRes?.error || 'unknown')

      if (sendRes?.ok) {
        console.log(`${tag} reset email sent OK`)
      } else {
        console.error(`${tag} sendEmail FAILED:`, sendRes?.error || '(no error message)')

        // RECORD IT AS DATA, not only as an alert. The bot's update_my_email
        // tool will only repair an address that is PROVABLY broken, and it
        // needs something queryable to prove it with. Parsing the WhatsApp
        // alert text for that would be a second source of truth that drifts.
        // Law 8: rides site_events, no DDL.
        try {
          await admin.from('site_events').insert({
            session_id: 'email_undeliverable',
            event_type: 'email_undeliverable',
            path: '/api/exhibitor/send-password-reset',
            metadata: { email: lowEmail, reason: sendRes?.error || 'unknown' },
          })
        } catch (e) {
          console.error(`${tag} could not record undeliverable:`, (e as Error).message)
        }
        // MONITORING (KT #206651 P0.5): the endpoint deliberately returns
        // {ok:true} to avoid account enumeration, so a real send failure is
        // otherwise invisible until a vendor complains. Surface it to ops so a
        // rotated/expired RESEND key or a Resend suppression is caught fast.
        // Best-effort; never changes the user-facing contract.
        try {
          const { notifyOwners } = await import('@/lib/bot/notify')
          await notifyOwners({
            event: 'system_alert',
            body: `Password-reset email FAILED to send to a vendor (${email.trim()}). Reason: ${sendRes?.error || 'unknown'}. Check the Resend key + suppression list.`,
            audience: 'all',
          })
        } catch (e) {
          console.error(`${tag} ops-alert on send failure failed:`, (e as Error).message)
        }
      }
    } catch (e) {
      console.error(`${tag} threw:`, (e as Error).message)
    }

    return reply()
  } catch (error) {
    console.error('[send-password-reset] bad request:', error)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}
