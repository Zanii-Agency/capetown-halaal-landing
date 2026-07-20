import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'
import { sendEmail } from '@/lib/email/resend'
import { ApplicationApproved } from '@/lib/email/templates/ApplicationApproved'
import { ApplicationRejected } from '@/lib/email/templates/ApplicationRejected'
import { ApplicationInfoRequested } from '@/lib/email/templates/ApplicationInfoRequested'
import { provisionExhibitorAccount } from '@/lib/exhibitor-auth'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { assertRole } from '@/lib/admin-rbac'
import { capJsonbSize } from '@/lib/audit/cap'
import { findWaTemplate, renderWaTemplatePreview } from '@/lib/templates/wa-meta'
import { parseAllocation } from '@/lib/stalls'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'

// Validation for status updates
const updateSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'info_requested']).optional(),
  admin_notes: z.string().optional(),
})

// GET: Single application (admin only)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = await createClient()

    // Check auth
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check admin (use admin client to bypass RLS)
    const admin = createAdminClient()
    const { data: adminUser } = await admin
      .from('admin_users')
      .select()
      .eq('id', user.id)
      .single()

    if (!adminUser) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data, error } = await admin
      .from('vendor_applications')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    return NextResponse.json({ application: data })
  } catch (error) {
    console.error('GET application error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PATCH: Update application status (admin only)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const validated = updateSchema.parse(body)

    const supabase = await createClient()

    // Check auth
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Role gate (B7). PATCH mutates application status (approve/reject) —
    // a viewer must not be able to approve, reject, or update notes. Only
    // owner/operator can mutate. assertRole throws with a generic message;
    // we translate to a clean 403 here.
    try {
      await assertRole(user.id, ['owner', 'operator'])
    } catch {
      return NextResponse.json({ error: 'insufficient_role' }, { status: 403 })
    }

    const admin = createAdminClient()

    // Snapshot the pre-update row. Used for idempotency check below AND for
    // the vendor_application_events before_value diff (Logic broken wire #2).
    let previousStatus: string | null = null
    let previousReviewedAt: string | null = null
    let previousApprovedAt: string | null = null
    // Idempotency: if the application is already in the target status, no-op.
    // Re-running approve was previously a destructive action (it reset the
    // vendor's portal password and re-sent the approval email). This guard
    // makes a double-click safe.
    if (validated.status) {
      const { data: existing } = await admin
        .from('vendor_applications')
        .select('id, status, reviewed_at, approved_at, business_name, email, contact_name, admin_notes, preferred_booth_tier')
        .eq('id', id)
        .single()
      if (existing) {
        previousStatus = (existing.status as string | null) ?? null
        previousReviewedAt = (existing.reviewed_at as string | null) ?? null
        previousApprovedAt = (existing.approved_at as string | null) ?? null
      }
      if (existing && existing.status === validated.status && (existing.reviewed_at || existing.approved_at)) {
        // payment_status is NOT a column on this Supabase project; payment state
        // lives only in the ⟦PORTAL⟧ marker on admin_notes. Surface it from the
        // marker so the no-op response still carries a payment status.
        const paymentStatus =
          parsePortalState(existing.admin_notes as string).payment?.status ?? null
        return NextResponse.json({
          success: true,
          application: { ...existing, payment_status: paymentStatus },
          alreadyInStatus: true,
          emailSent: false,
        })
      }
    }

    // Resolve actor identity for the audit row. The admin_users row may not
    // exist for super-admins authenticated only via Supabase Auth, so fall
    // back to user.email when the lookup misses.
    const { data: actorRow } = await admin
      .from('admin_users')
      .select('email')
      .eq('id', user.id)
      .maybeSingle()
    const actorEmail = (actorRow?.email as string | null) || user.email || null

    // Update application
    const updateData: Record<string, unknown> = { ...validated }
    if (validated.status) {
      updateData.reviewed_at = new Date().toISOString()
      updateData.reviewed_by = user.id
    } else if (validated.admin_notes !== undefined) {
      // Touch reviewed_by on any admin-driven mutation so we know who edited last.
      updateData.reviewed_by = user.id
    }

    const { data, error } = await admin
      .from('vendor_applications')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Update error:', error)
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
    }

    // Audit event for single-row status changes. The bulk endpoint and the
    // /api/admin/applications/[id]/action endpoint both write to
    // vendor_application_events, but the most-used surface (Samreen's keyboard
    // 'a' on /admin/applications) hits THIS route and was previously silent.
    // event_type taxonomy mirrors the action route: approved | rejected |
    // info_requested. Falls back to reviewed for explicit pending writes.
    if (validated.status && data) {
      const nowIso = (updateData.reviewed_at as string) || new Date().toISOString()
      const eventType =
        validated.status === 'approved' ? 'approved' :
        validated.status === 'rejected' ? 'rejected' :
        validated.status === 'info_requested' ? 'info_requested' :
        'reviewed'
      const beforeValue = capJsonbSize({
        status: previousStatus,
        reviewed_at: previousReviewedAt,
        approved_at: previousApprovedAt,
      })
      const afterValue = capJsonbSize({
        status: validated.status,
        reviewed_at: nowIso,
        approved_at: validated.status === 'approved' ? nowIso : previousApprovedAt,
      })
      try {
        const { error: evErr } = await admin.from('vendor_application_events').insert({
          application_id: id,
          event_type: eventType,
          before_value: beforeValue,
          after_value: afterValue,
          actor_email: actorEmail,
          actor_role: 'operator',
          note: validated.admin_notes ?? null,
        })
        if (evErr) console.error('[applications PATCH] event insert failed:', evErr.message)
      } catch (e) {
        console.error('[applications PATCH] event insert threw:', (e as Error).message)
      }
    }

    // On approval, reserve the booth and set the payment due date = approved_at
    // + 30 days. Vendors are approved on different days, so each has their own
    // 30-day window. Weekly reminders fire from /api/cron/payment-reminders.
    // There is NO payment_status / payment_due_date column on this Supabase
    // project (DDL is blocked, CTH-DOCTRINE Law 8): payment state lives only in
    // the base64 ⟦PORTAL⟧ marker on admin_notes, and the exhibitor portal reads
    // state.payment?.due for the due date. Never downgrade a paid vendor.
    if (validated.status === 'approved') {
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
    }

    // Send status notification email. Capture the result so the admin UI can
    // tell the operator whether the applicant was actually notified.
    let emailSent = false
    let emailError: string | undefined
    if (validated.status && data) {
      try {
        let res: { ok: boolean; error?: string } | undefined
        if (validated.status === 'approved') {
          // Create (or reset) the vendor's real portal account + temp password.
          let tempPassword = ''
          try {
            const prov = await provisionExhibitorAccount({
              email: data.email,
              applicationId: id,
              businessName: data.business_name,
            })
            tempPassword = prov.tempPassword
            // best-effort link (auth_user_id column ships in migration v7)
            if (prov.userId) {
              const { error: linkErr } = await createAdminClient()
                .from('vendor_applications')
                .update({ auth_user_id: prov.userId })
                .eq('id', id)
              if (linkErr) console.error('auth_user_id link skipped (migration v7 pending?):', linkErr.message)
            }
          } catch (e) {
            console.error('[approve] account provisioning failed:', (e as Error).message)
          }

          const dueDate = new Date()
          dueDate.setDate(dueDate.getDate() + 30)
          const dueDateLabel = dueDate.toLocaleDateString('en-GB', {
            day: '2-digit', month: 'long', year: 'numeric',
          })

          res = await sendEmail({
            to: data.email,
            subject: 'You\'re Approved! Welcome to Young at Heart Festival 2026',
            react: ApplicationApproved({
              businessName: data.business_name,
              contactName: data.contact_name,
              email: data.email,
              boothTier: data.preferred_booth_tier || undefined,
              applicationId: id,
              tempPassword,
              loginUrl: 'https://cthalaal.co.za/exhibitor/login',
              paymentDueDate: dueDateLabel,
            }),
          })

          // Fire approval WhatsApp template (vendor_application_approved).
          // Meta-approved template body is:
          //   "Great news {{1}}! Your stall application for the Young at Heart
          //    Festival 2026 has been approved. Your stall: {{2}}"
          // So EXACTLY 2 params: name + stall code (or placeholder if not yet
          // allocated). Was previously passing 3 params, which Meta rejected
          // silently — root cause of zero approval messages ever delivered
          // (2026-06-13 audit). Stall code extracted from admin_notes
          // ⟦STALL:code⟧ marker per CTH-DOCTRINE Law 8.
          try {
            const phone = (data.phone || data.whatsapp_number) as string | null
            if (phone) {
              const firstName = String(data.contact_name || '').trim().split(/\s+/)[0] || 'there'
              // Multi-booth: join the vendor's code list (strips any status
              // suffix). {{2}} is embedded mid-sentence as "Your stall: {{2}}".
              // When stalls are allocated we pass the code(s); when none are yet
              // allocated we pass a full clause so the sentence reads cleanly
              // ("Your stall: to be allocated and shared closer to the
              // festival.") instead of a dangling fragment.
              const allocatedCodes = parseAllocation(data.admin_notes as string).stalls
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
              // Paper-trail log: write to wa_messages so the auto-send is
              // visible alongside broadcasts (was silent before — no way to
              // tell if Meta actually delivered). Render from the canonical
              // Meta-approved body (wa-meta.ts) so the inbox shows the real
              // message text, not a hand-rolled fragment.
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
              if (wa.skipped) {
                console.warn('[approve] WA template skipped:', wa.skipped)
              }
            }
          } catch (e) {
            console.error('[approve] WA template send failed:', (e as Error).message)
          }
        } else if (validated.status === 'rejected') {
          res = await sendEmail({
            to: data.email,
            subject: 'An update on your Young at Heart Festival 2026 application',
            react: ApplicationRejected({
              contactName: data.contact_name,
              businessName: data.business_name,
            }),
            text: `Hi ${data.contact_name},\n\nThank you for applying to trade at Young at Heart Festival 2026 with ${data.business_name}, and for your patience while our selection committee reviewed every submission.\n\nWe received an overwhelming number of vendor applications this year, far beyond the spaces we have available. After a careful and fair review, we are not able to offer ${data.business_name} a trading spot at this year's festival.\n\nPlease know this is not a reflection of your business. With limited stalls and so many strong applications, many wonderful vendors could not be accommodated this time. Your details stay on file, and we would warmly welcome a fresh application for future events.\n\nIf you'd like any feedback, simply reply to this email. Questions? support@youngatheart.co.za or +27 65 943 5012.\n\nWarm regards,\nThe Young at Heart Festival Team`,
          })
          // WhatsApp: vendor_application_declined template. Best-effort.
          try {
            const phone = (data.phone || data.whatsapp_number) as string | null
            if (phone) {
              const firstName = String(data.contact_name || '').trim().split(/\s+/)[0] || 'there'
              const wa = await sendTemplate(toE164(phone), 'vendor_application_declined', [firstName], { category: 'utility' })
              if (wa.skipped) console.warn('[reject] WA template skipped:', wa.skipped)
            }
          } catch (e) {
            console.error('[reject] WA template send failed:', (e as Error).message)
          }
        } else if (validated.status === 'info_requested') {
          res = await sendEmail({
            to: data.email,
            subject: 'A little more information needed, Young at Heart Festival 2026',
            react: ApplicationInfoRequested({
              contactName: data.contact_name,
              businessName: data.business_name,
            }),
            text: `Hi ${data.contact_name},\n\nThank you for applying to trade at Young at Heart Festival 2026 with ${data.business_name}. Your application is moving through review, and our committee just needs a little more detail before we can finalise a decision.\n\nWhat we need from you:\n- A clear description of what you plan to sell or showcase.\n- A few photos of your products, stall, or previous setups.\n- Your trading licence or relevant certification, if applicable.\n\nSimply reply to this email with the details above and we'll pick your application straight back up. Questions? support@youngatheart.co.za or +27 65 943 5012.\n\nWarm regards,\nThe Young at Heart Festival Team`,
          })
        }
        if (res) {
          emailSent = res.ok
          emailError = res.error
          if (!res.ok) {
            console.error(`[applications/${id}] ${validated.status} email FAILED for ${data.email}: ${res.error}`)
          }
        }
      } catch (e) {
        emailError = (e as Error).message
        console.error('[applications] status email threw:', e)
      }
    }

    return NextResponse.json({ success: true, application: data, emailSent, emailError })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.issues },
        { status: 400 }
      )
    }
    console.error('PATCH error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
