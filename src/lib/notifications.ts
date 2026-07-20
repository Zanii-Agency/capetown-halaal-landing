import { createAdminClient } from './supabase/admin'
import { sendTemplate } from './whatsapp'
import { findWaTemplate, buildWaTemplateParams } from './templates/wa-meta'
import { sendEmail } from './email/resend'

type NotificationChannel = 'whatsapp' | 'email'

// Outcome of the (best-effort) WhatsApp leg, so a future failure is never
// invisible the way the old silent try/catch made it.
type WaLegResult =
  | { status: 'sent'; template: string; messageId: string }
  | { status: 'skipped'; template?: string; reason: string }
  | { status: 'failed'; template?: string; error: string }

type NotifyEvent =
  | 'stall_allocated'
  | 'document_approved'
  | 'document_rejected'
  | 'stall_change_approved'
  | 'stall_change_rejected'

interface NotifyVendorParams {
  event: NotifyEvent
  applicationId: string
  data?: Record<string, string>
}

export async function notifyVendor(params: NotifyVendorParams) {
  const supabase = createAdminClient()

  const { data: app } = await supabase
    .from('vendor_applications')
    .select('business_name, email, phone, admin_notes')
    .eq('id', params.applicationId)
    .single()

  if (!app) {
    return {
      applicationId: params.applicationId,
      event: params.event,
      whatsapp: { status: 'skipped', reason: 'application not found' } as WaLegResult,
      email: 'skipped' as const,
    }
  }

  const state = JSON.parse(Buffer.from(
    (app.admin_notes || '').match(/⟦PORTAL:([A-Za-z0-9+/=]+)⟧/)?.[1] || 'e30=',
    'base64'
  ).toString() || '{}')

  const prefs = state.notification_preferences || {}

  const shouldSend = (channel: NotificationChannel, eventKey: string): boolean => {
    return prefs[`${eventKey}_${channel}`] !== false
  }

  // First name for template personalization (Meta templates greet by first name).
  const firstName = (app.business_name || '').trim().split(/\s+/)[0] || 'there'

  // Each WhatsApp send goes through a Meta-approved business-initiated template,
  // because notifyVendor fires from an admin action (stall allocation, document
  // decision) and the vendor is almost never inside the 24h customer service
  // window. waTemplate.name MUST be a key registered in lib/templates/wa-meta.ts
  // (the single source of truth for what Meta has approved), and waTemplate.params
  // is keyed by that spec's param keys so we validate + order before sending.
  const templates: Record<NotifyEvent, {
    waTemplate?: { name: string; params: Record<string, string> }
    emailSubject: string
    emailBody: string
  }> = {
    stall_allocated: {
      waTemplate: {
        name: 'vendor_stall_allocation',
        params: {
          first_name: firstName,
          stall_code: params.data?.stall || '',
          section_name: params.data?.section || 'your section',
        },
      },
      emailSubject: `Your stall has been allocated: ${params.data?.stall || ''}`,
      emailBody: `Hi ${app.business_name},\n\nYour stall ${params.data?.stall || ''} has been allocated. Log in to the exhibitor portal to view your placement on the floor plan.\n\nExhibitor portal: https://cthalaal.co.za/exhibitor/portal/stand`,
    },
    document_approved: {
      waTemplate: {
        name: 'vendor_document_approved',
        params: {
          first_name: firstName,
          document_label: params.data?.docType || 'document',
        },
      },
      emailSubject: 'Document approved',
      emailBody: `Hi ${app.business_name},\n\nYour ${params.data?.docType || 'document'} has been approved. Thank you for submitting.\n\nExhibitor portal: https://cthalaal.co.za/exhibitor/portal/documents`,
    },
    document_rejected: {
      waTemplate: {
        name: 'vendor_document_rejected',
        params: {
          first_name: firstName,
          document_label: params.data?.docType || 'document',
          reason: params.data?.reason || 'Please upload a valid version.',
        },
      },
      emailSubject: 'Document needs attention',
      emailBody: `Hi ${app.business_name},\n\nYour ${params.data?.docType || 'document'} was not approved. Reason: ${params.data?.reason || 'Please upload a valid version.'}\n\nPlease log in to upload a replacement: https://cthalaal.co.za/exhibitor/portal/documents`,
    },
    stall_change_approved: {
      emailSubject: `Your stall change has been approved${params.data?.tier ? `: ${params.data.tier}` : ''}`,
      emailBody: `Hi ${app.business_name},\n\nYour stall change request${params.data?.tier ? ` to ${params.data.tier}` : ''} was approved. Log in to the exhibitor portal to review your stand details.\n\nExhibitor portal: https://cthalaal.co.za/exhibitor/portal/stand`,
    },
    stall_change_rejected: {
      emailSubject: 'Update on your stall change request',
      emailBody: `Hi ${app.business_name},\n\nYour stall change request was not approved.${params.data?.reason ? ` ${params.data.reason}` : ''}\n\nReach out via the exhibitor portal if you would like to discuss options.\n\nExhibitor portal: https://cthalaal.co.za/exhibitor/portal/stand`,
    },
  }

  const tpl = templates[params.event]

  // Best-effort WhatsApp leg. Result is OBSERVABLE: we always know whether the
  // WA message sent, was skipped (no phone / opt-out / outside 24h window /
  // unknown template), or failed (Meta API error). This never blocks the email.
  let waResult: WaLegResult = { status: 'skipped', reason: 'not attempted' }

  if (!tpl.waTemplate) {
    waResult = { status: 'skipped', reason: 'no whatsapp template for this event' }
  } else if (!app.phone) {
    waResult = { status: 'skipped', template: tpl.waTemplate.name, reason: 'no phone on file' }
  } else if (!shouldSend('whatsapp', params.event)) {
    waResult = { status: 'skipped', template: tpl.waTemplate.name, reason: 'vendor opted out of whatsapp for this event' }
  } else {
    const templateName = tpl.waTemplate.name
    const spec = findWaTemplate(templateName)
    if (!spec) {
      // Guard against the exact class of bug we are fixing: a template name that
      // the Meta registry does not know. Fail loud, not silent.
      waResult = { status: 'failed', template: templateName, error: 'template not registered in wa-meta.ts' }
      console.error(`[notify] WA template "${templateName}" is not in the Meta registry for ${params.applicationId}. Send aborted.`)
    } else {
      const built = buildWaTemplateParams(spec, tpl.waTemplate.params)
      if (!built.ok) {
        waResult = { status: 'failed', template: templateName, error: built.error }
        console.error(`[notify] WA template "${templateName}" param error for ${params.applicationId}: ${built.error}`)
      } else {
        try {
          const res = await sendTemplate(app.phone, templateName, built.ordered)
          if (res.skipped) {
            waResult = { status: 'skipped', template: templateName, reason: res.skipped }
            console.error(`[notify] WA "${templateName}" skipped for ${params.applicationId}: ${res.skipped}`)
          } else {
            waResult = { status: 'sent', template: templateName, messageId: res.messageId }
          }
        } catch (e) {
          // Meta 400 (e.g. template not yet approved in Business Manager) lands
          // here. Surface the template name + the real Meta error, do not swallow.
          waResult = { status: 'failed', template: templateName, error: (e as Error).message }
          console.error(`[notify] WA "${templateName}" failed for ${params.applicationId}:`, e)
        }
      }
    }
  }

  let emailResult: 'sent' | 'skipped' | 'failed' = 'skipped'

  if (app.email && shouldSend('email', params.event)) {
    try {
      await sendEmail({
        to: app.email,
        subject: tpl.emailSubject,
        text: tpl.emailBody,
      })
      emailResult = 'sent'
    } catch (e) {
      emailResult = 'failed'
      console.error(`[notify] Email failed for ${params.applicationId}:`, e)
    }
  }

  // Return the per-channel outcome so callers (and tests) can assert what
  // actually happened. The old code returned void and swallowed WA errors.
  return {
    applicationId: params.applicationId,
    event: params.event,
    whatsapp: waResult,
    email: emailResult,
  }
}
