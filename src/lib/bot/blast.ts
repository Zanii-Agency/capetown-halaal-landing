// Send an email blast to a resolved segment, throttled to respect SMTP limits.
// Single chokepoint = single place to enforce rate / log / audit. Same shape
// as the Nisria send_newsletter pattern (queue → approve → blast).

import { sendEmail } from '@/lib/email/resend'
import { ApplicationRejected } from '@/lib/email/templates/ApplicationRejected'
import { ApplicationApproved } from '@/lib/email/templates/ApplicationApproved'
import { ApplicationInfoRequested } from '@/lib/email/templates/ApplicationInfoRequested'
import { ApplicationDelayNotice } from '@/lib/email/templates/ApplicationDelayNotice'
import { Campaign } from '@/lib/email/templates/Campaign'
import type { Recipient, SegmentKey } from './segments'
import { resolveSegment } from './segments'
import { createAdminClient } from '@/lib/supabase/admin'

export type BlastTemplate =
  | 'application_rejected'
  | 'application_approved'
  | 'application_info_requested'
  | 'application_delay_notice'
  | 'custom'

export interface BlastSpec {
  segment: SegmentKey
  template: BlastTemplate
  // custom-template only:
  subject?: string
  bodyMarkdown?: string
  /** Festival owner sent it: walled recipients are never reached. */
  ownerView?: boolean
}

export interface BlastResult {
  attempted: number
  sent: number
  failed: number
  errors: Array<{ email: string; error: string }>
}

function pickSubject(template: BlastTemplate, customSubject?: string): string {
  if (template === 'custom') return customSubject || 'A message from Young at Heart Festival 2026'
  if (template === 'application_rejected') return 'An update on your Young at Heart Festival 2026 application'
  if (template === 'application_approved') return 'Your stall application is approved · Young at Heart Festival 2026'
  if (template === 'application_info_requested') return 'A little more information needed, Young at Heart Festival 2026'
  if (template === 'application_delay_notice') return 'Quick update on your vendor application'
  return 'Young at Heart Festival 2026'
}

function renderFor(template: BlastTemplate, r: Recipient, spec: BlastSpec) {
  const contactName = r.name || 'there'
  const businessName = r.business_name || 'your business'
  if (template === 'application_rejected') {
    return ApplicationRejected({ contactName, businessName })
  }
  if (template === 'application_approved') {
    return ApplicationApproved({
      contactName,
      businessName,
      email: r.email || '',
      boothTier: undefined,
      applicationId: r.application_id || '',
      tempPassword: '',
      loginUrl: 'https://cthalaal.co.za/exhibitor/login',
      paymentDueDate: '1 September 2026',
    })
  }
  if (template === 'application_info_requested') {
    return ApplicationInfoRequested({ contactName, businessName })
  }
  if (template === 'application_delay_notice') {
    const firstName = contactName.trim().split(/\s+/)[0] || contactName
    return ApplicationDelayNotice({ firstName, businessName })
  }
  // custom
  return Campaign({
    preview: spec.subject || 'A message from Young at Heart Festival 2026',
    heading: spec.subject || 'A message from Young at Heart Festival 2026',
    greeting: `Hi ${contactName},`,
    paragraphs: (spec.bodyMarkdown || '')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean),
    showEvent: true,
  })
}

export async function runBlast(spec: BlastSpec): Promise<BlastResult> {
  const recipients = await resolveSegment(spec.segment, { ownerView: spec.ownerView })
  const subject = pickSubject(spec.template, spec.subject)
  const result: BlastResult = { attempted: recipients.length, sent: 0, failed: 0, errors: [] }

  // Throttle: 1 send every 250ms so we don't trip Resend's burst limiter or
  // saturate the SMTP fallback. ~240/min — enough for a 247-row rejection blast
  // in ~1 minute.
  for (const r of recipients) {
    try {
      const react = renderFor(spec.template, r, spec)
      const res = await sendEmail({ to: r.email, subject, react })
      if (res.ok) result.sent++
      else {
        result.failed++
        result.errors.push({ email: r.email, error: res.error || 'unknown' })
      }
    } catch (e) {
      result.failed++
      result.errors.push({ email: r.email, error: (e as Error).message })
    }
    await new Promise((r) => setTimeout(r, 250))
  }

  // Audit row — durable record of every blast for after-the-fact "what did
  // the bot send?" review. Stored as a wa_messages row with a marker so the
  // Bot Inbox can surface it under "system events".
  const db = createAdminClient()
  await db.from('wa_messages').insert({
    direction: 'out',
    wa_phone: 'system:blast',
    body: `[BLAST_AUDIT] segment=${spec.segment} template=${spec.template} sent=${result.sent}/${result.attempted} failed=${result.failed}`,
    status: 'sent',
    provider_message_id: null,
  })

  return result
}
