// Shared decision side-effects for vendor-application approve / reject /
// info_requested.
//
// WHY THIS EXISTS (2026-06-19 audit):
//   The approval EMAIL, approval WhatsApp, portal-account provisioning, and
//   payment-default reservation used to live INLINE in the PATCH
//   /api/applications/[id] handler. The workbench (the most-used surface,
//   keyboard 'a' on /admin/applications) approves via
//   POST /api/admin/applications/[id]/action, which only flipped status +
//   wrote an audit row and called NONE of those side-effects. Result: 18+
//   vendors were marked "approved" on 2026-06-19 with zero notification and no
//   portal login (no temp password). Resend showed 0 "You're Approved!" sends.
//
//   Fix-at-source = ONE shared function called by every approval surface
//   (action, bulk, remediation) instead of duplicating the block. Same-node
//   fix: the side-effects belong to the decision, not to one route.
//
// This module owns the OUTBOUND side-effects only. Callers still write their
// own vendor_application_events audit row.

import { sendEmail } from '@/lib/email/resend'
import { ApplicationApproved } from '@/lib/email/templates/ApplicationApproved'
import { ApplicationRejected } from '@/lib/email/templates/ApplicationRejected'
import { ApplicationInfoRequested } from '@/lib/email/templates/ApplicationInfoRequested'
import { provisionExhibitorAccount } from '@/lib/exhibitor-auth'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { findWaTemplate, renderWaTemplatePreview } from '@/lib/templates/wa-meta'
import { parseAllocation } from '@/lib/stalls'
import { updatePortalState } from '@/lib/portal-state'
import type { createAdminClient } from '@/lib/supabase/admin'

type AdminClient = ReturnType<typeof createAdminClient>

export type DecisionStatus = 'approved' | 'rejected' | 'info_requested'

/** Marker appended to admin_notes once the approval notification has gone out,
 *  so remediation / double-taps never re-send. Mirrors the ⟦STALL:..⟧ pattern. */
export const APPROVED_NOTIFIED_RE = /⟦APPROVED_NOTIFIED:[^⟧]+⟧/

/** Minimal application shape the side-effects need. */
export interface DecisionApp {
  email: string
  business_name: string
  contact_name: string
  preferred_booth_tier?: string | null
  phone?: string | null
  whatsapp_number?: string | null
  admin_notes?: string | null
}

export interface DecisionNotifyResult {
  emailSent: boolean
  emailError?: string
  waSent: boolean
  waSkipped?: string
}

/**
 * Run the outbound side-effects for a vendor-application decision.
 *
 * approved        -> reserve booth + 30-day payment window, provision portal
 *                    account (temp password), send approval email, fire WA
 *                    approval template + paper-trail, stamp ⟦APPROVED_NOTIFIED⟧.
 * rejected        -> send rejection email, fire WA declined template.
 * info_requested  -> send "more info needed" email.
 *
 * Every step is best-effort and isolated: a WhatsApp failure never blocks the
 * email, provisioning failure never blocks the send. The returned flags let the
 * caller surface "was the vendor actually notified?".
 */
export async function notifyApplicationDecision({
  admin,
  id,
  app,
  status,
}: {
  admin: AdminClient
  id: string
  app: DecisionApp
  status: DecisionStatus
}): Promise<DecisionNotifyResult> {
  let emailSent = false
  let emailError: string | undefined
  let waSent = false
  let waSkipped: string | undefined

  try {
    let res: { ok: boolean; error?: string } | undefined

    if (status === 'approved') {
      // Reserve the booth + set the payment due date = today + 30 days. Each
      // vendor is approved on their own day, so each gets their own 30-day
      // window. There is NO payment_status / payment_due_date column on this
      // Supabase project (DDL is blocked, CTH-DOCTRINE Law 8): payment state
      // lives only in the base64 ⟦PORTAL⟧ marker on admin_notes. Write the
      // due date + pending status there so the exhibitor portal (which reads
      // state.payment?.due) actually shows it. Never downgrade a vendor who
      // has already paid back to pending.
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + 30)
      const dueDateIso = dueDate.toISOString().slice(0, 10) // YYYY-MM-DD
      try {
        await updatePortalState(id, (s) => ({
          ...s,
          payment: {
            ...(s.payment || {}),
            status: s.payment?.status === 'paid' ? 'paid' : 'pending',
            due: dueDateIso,
          },
        }))
      } catch (e) {
        console.error('[approve] payment due-date marker write failed:', (e as Error).message)
      }

      // Create (or reset) the vendor's real portal account + temp password.
      let tempPassword = ''
      try {
        const prov = await provisionExhibitorAccount({
          email: app.email,
          applicationId: id,
          businessName: app.business_name,
        })
        tempPassword = prov.tempPassword
        if (prov.userId) {
          const { error: linkErr } = await admin
            .from('vendor_applications')
            .update({ auth_user_id: prov.userId })
            .eq('id', id)
          if (linkErr) console.error('auth_user_id link skipped (migration v7 pending?):', linkErr.message)
        }
      } catch (e) {
        console.error('[approve] account provisioning failed:', (e as Error).message)
      }

      const dueDateLabel = dueDate.toLocaleDateString('en-GB', {
        day: '2-digit', month: 'long', year: 'numeric',
      })

      res = await sendEmail({
        to: app.email,
        subject: 'You\'re Approved! Welcome to Young at Heart Festival 2026',
        react: ApplicationApproved({
          businessName: app.business_name,
          contactName: app.contact_name,
          email: app.email,
          boothTier: app.preferred_booth_tier || undefined,
          applicationId: id,
          tempPassword,
          loginUrl: 'https://cthalaal.co.za/exhibitor/login',
          paymentDueDate: dueDateLabel,
        }),
      })

      // Fire approval WhatsApp template (vendor_application_approved).
      // Meta-approved body has EXACTLY 2 params: name + stall code. Passing 3
      // got silently rejected by Meta (2026-06-13 audit). Stall code from the
      // admin_notes ⟦STALL:code⟧ marker per CTH-DOCTRINE Law 8.
      try {
        const phone = (app.phone || app.whatsapp_number) as string | null
        if (phone) {
          const firstName = String(app.contact_name || '').trim().split(/\s+/)[0] || 'there'
          // Multi-booth: join the vendor's code list (strips any status suffix).
          // {{2}} is embedded mid-sentence as "Your stall: {{2}}". When stalls
          // are allocated we pass the code(s); when none are yet allocated we pass
          // a full clause so the sentence reads cleanly ("Your stall: to be
          // allocated and shared closer to the festival.") instead of a dangling
          // "Your stall: to be confirmed shortly" fragment.
          const allocatedCodes = parseAllocation(app.admin_notes as string).stalls
          const stallCode = allocatedCodes.length
            ? allocatedCodes.join(', ')
            : 'to be allocated and shared closer to the festival'
          const e164 = toE164(phone)
          const wa = await sendTemplate(
            e164,
            'vendor_application_approved',
            [firstName, stallCode],
            { category: 'utility' }
          )
          waSent = !wa.skipped
          waSkipped = wa.skipped
          // Paper-trail log so the auto-send is visible alongside broadcasts.
          // Render from the canonical Meta-approved body (wa-meta.ts) so the
          // inbox shows the real message text, not a hand-rolled fragment.
          const spec = findWaTemplate('vendor_application_approved')
          const loggedBody = spec
            ? renderWaTemplatePreview(spec, { first_name: firstName, stall_code: stallCode })
            : `Great news ${firstName}! Your stall application for Young at Heart Festival 2026 is approved. Your stall: ${stallCode}. We will share setup details and a payment link shortly.`
          try {
            await admin.from('wa_messages').insert({
              direction: 'out',
              wa_phone: e164.replace(/^\+/, ''),
              template_name: 'vendor_application_approved',
              category: 'utility',
              body: loggedBody,
              status: wa.skipped ? 'failed' : 'sent',
              error: wa.skipped || null,
              provider_message_id: wa.messageId || null,
            })
          } catch (logErr) {
            console.error('[approve] wa_messages log failed:', (logErr as Error).message)
          }
          if (wa.skipped) console.warn('[approve] WA template skipped:', wa.skipped)
        }
      } catch (e) {
        console.error('[approve] WA template send failed:', (e as Error).message)
      }

      // Follow-up: the "here is how to use it" message — tells the newly-approved
      // vendor the TWO ways to manage their stall (WhatsApp + portal) with simple
      // examples (template: vendor_welcome_options). Best-effort + gated: until
      // Meta approves the template this skips and NEVER affects the approval flow.
      try {
        const phoneW = (app.phone || app.whatsapp_number) as string | null
        if (phoneW) {
          const fnW = String(app.contact_name || '').trim().split(/\s+/)[0] || 'there'
          const wo = await sendTemplate(toE164(phoneW), 'vendor_welcome_options', [fnW], { category: 'utility' })
          if (wo.skipped) console.warn('[approve] welcome_options skipped (template pending Meta approval?):', wo.skipped)
        }
      } catch (e) {
        console.warn('[approve] welcome_options send failed (non-fatal):', (e as Error).message)
      }

      // Stamp the idempotency marker ONLY when the email actually went out, so a
      // failed send stays un-marked and remediation can retry it.
      if (res?.ok) {
        try {
          const existing = String(app.admin_notes || '').replace(/⟦APPROVED_NOTIFIED:[^⟧]+⟧\s*/g, '')
          const marker = `⟦APPROVED_NOTIFIED:${new Date().toISOString()}⟧`
          await admin
            .from('vendor_applications')
            .update({ admin_notes: `${marker}${existing ? ' ' + existing : ''}` })
            .eq('id', id)
        } catch (e) {
          console.error('[approve] notified-marker write failed:', (e as Error).message)
        }
      }
    } else if (status === 'rejected') {
      res = await sendEmail({
        to: app.email,
        subject: 'An update on your Young at Heart Festival 2026 application',
        react: ApplicationRejected({
          contactName: app.contact_name,
          businessName: app.business_name,
        }),
        text: `Hi ${app.contact_name},\n\nThank you for applying to trade at Young at Heart Festival 2026 with ${app.business_name}, and for your patience while our selection committee reviewed every submission.\n\nWe received an overwhelming number of vendor applications this year, far beyond the spaces we have available. After a careful and fair review, we are not able to offer ${app.business_name} a trading spot at this year's festival.\n\nPlease know this is not a reflection of your business. With limited stalls and so many strong applications, many wonderful vendors could not be accommodated this time. Your details stay on file, and we would warmly welcome a fresh application for future events.\n\nIf you'd like any feedback, simply reply to this email. Questions? support@youngatheart.co.za or +27 65 943 5012.\n\nWarm regards,\nThe Young at Heart Festival Team`,
      })
      try {
        const phone = (app.phone || app.whatsapp_number) as string | null
        if (phone) {
          const firstName = String(app.contact_name || '').trim().split(/\s+/)[0] || 'there'
          const wa = await sendTemplate(toE164(phone), 'vendor_application_declined', [firstName], { category: 'utility' })
          waSent = !wa.skipped
          waSkipped = wa.skipped
          if (wa.skipped) console.warn('[reject] WA template skipped:', wa.skipped)
        }
      } catch (e) {
        console.error('[reject] WA template send failed:', (e as Error).message)
      }
    } else if (status === 'info_requested') {
      res = await sendEmail({
        to: app.email,
        subject: 'A little more information needed, Young at Heart Festival 2026',
        react: ApplicationInfoRequested({
          contactName: app.contact_name,
          businessName: app.business_name,
        }),
        text: `Hi ${app.contact_name},\n\nThank you for applying to trade at Young at Heart Festival 2026 with ${app.business_name}. Your application is moving through review, and our committee just needs a little more detail before we can finalise a decision.\n\nWhat we need from you:\n- A clear description of what you plan to sell or showcase.\n- A few photos of your products, stall, or previous setups.\n- Your trading licence or relevant certification, if applicable.\n\nSimply reply to this email with the details above and we'll pick your application straight back up. Questions? support@youngatheart.co.za or +27 65 943 5012.\n\nWarm regards,\nThe Young at Heart Festival Team`,
      })
    }

    if (res) {
      emailSent = res.ok
      emailError = res.error
      if (!res.ok) {
        console.error(`[decision-notify ${id}] ${status} email FAILED for ${app.email}: ${res.error}`)
      }
    }
  } catch (e) {
    emailError = (e as Error).message
    console.error('[decision-notify] threw:', e)
  }

  return { emailSent, emailError, waSent, waSkipped }
}
