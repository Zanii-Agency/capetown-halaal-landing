/**
 * Logo-upload reminder — shared logic for three callers:
 *   1. confirmPayment()  → fire once, immediately after a vendor pays.
 *   2. /api/cron/logo-reminders → weekly catch-up sweep until the logo is up.
 *   3. /api/admin/vendors/logo-campaign → manual operator trigger / preview.
 *
 * A vendor "needs a logo reminder" when they have PAID (portal payment.status
 * === 'paid') but have NOT uploaded a logo (no profile.logo_path). The reminder
 * goes out on email (Resend) + WhatsApp (the approved `vendor_logo_reminder`
 * template). We stamp logo_prompt_sent_at so the weekly sweep re-nudges on a
 * cadence (minDaysBetween) instead of every run, and stops entirely once the
 * logo lands (the needs-logo gate goes false).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState, type PortalState } from '@/lib/portal-state'
import { sendEmail } from '@/lib/email/resend'
import { Campaign } from '@/lib/email/templates/Campaign'
import { sendTemplate } from '@/lib/whatsapp'

export const LOGO_PORTAL_URL = 'https://cthalaal.co.za/exhibitor/portal/profile'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PACE_MS = 300
const DEFAULT_LIMIT = 500
const DEFAULT_MIN_DAYS = 7

export function firstNameOf(n?: string | null): string {
  const f = (n || '').trim().split(/\s+/)[0]
  return f ? f.charAt(0).toUpperCase() + f.slice(1) : 'there'
}

/** Paid + no logo yet. */
export function vendorNeedsLogo(state: PortalState): boolean {
  return state.payment?.status === 'paid' && !state.profile?.logo_path
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface LogoReminderResult {
  emailed: boolean
  emailError?: string
  waSent: boolean
  waSkipped?: string
  waError?: string
}

/**
 * Send the logo reminder to ONE vendor (email + WhatsApp) and stamp
 * logo_prompt_sent_at. Never throws — every channel failure is captured in the
 * returned result so callers on the money path stay safe.
 */
export async function sendLogoReminder(args: {
  applicationId: string
  name: string
  email?: string | null
  phone?: string | null
  channels?: { email?: boolean; whatsapp?: boolean }
}): Promise<LogoReminderResult> {
  const name = firstNameOf(args.name)
  const doEmail = args.channels?.email !== false
  const doWhatsapp = args.channels?.whatsapp !== false
  const out: LogoReminderResult = { emailed: false, waSent: false }

  if (doEmail && args.email && EMAIL_RE.test(args.email.trim())) {
    try {
      const res = await sendEmail({
        to: args.email.trim(),
        subject: 'One step left: add your logo to go live',
        react: Campaign({
          preview: 'Add your logo so shoppers see your brand in the festival listings.',
          heading: 'Upload your logo',
          greeting: `Hi ${name},`,
          paragraphs: [
            'Your stall at Young at Heart Festival 2026 is paid and confirmed, thank you.',
            'One step is left to go live on the public festival site: your logo. Vendors with a logo appear with their branding in the sector listings shoppers browse before the show. Vendors without one are easy to scroll past.',
            'It takes under a minute in your vendor portal.',
          ],
          cta: { label: 'Upload your logo', href: LOGO_PORTAL_URL },
          signoff: 'See you in December,',
        }),
      })
      if (res.ok) out.emailed = true
      else out.emailError = res.error || 'unknown'
    } catch (e) {
      out.emailError = (e as Error).message
    }
  }

  if (doWhatsapp && args.phone) {
    try {
      const res = await sendTemplate(args.phone, 'vendor_logo_reminder', [name], { category: 'utility' })
      if (res.skipped) out.waSkipped = res.skipped
      else if (res.messageId) out.waSent = true
      else out.waError = 'no message id'
    } catch (e) {
      out.waError = (e as Error).message
    }
  }

  // Stamp so the weekly sweep paces re-nudges. Best-effort.
  try {
    await updatePortalState(args.applicationId, (s) => ({
      ...s,
      logo_prompt_sent_at: new Date().toISOString(),
    }))
  } catch {
    // non-fatal
  }

  return out
}

export interface LogoSweepCounts {
  total_paid_no_logo: number
  due: number
  targeted: number
  emailed: number
  emailFailed: number
  waSent: number
  waSkipped: number
  waFailed: number
  errors: Array<{ id: string; channel: string; error: string }>
}

/**
 * Sweep every approved vendor and remind those who are paid + logo-less + due.
 * "Due" = never reminded, OR last reminded >= minDaysBetween days ago, OR force.
 * dryRun returns the counts without sending.
 */
export async function runLogoReminderSweep(opts: {
  force?: boolean
  minDaysBetween?: number
  limit?: number
  dryRun?: boolean
  channels?: { email?: boolean; whatsapp?: boolean }
} = {}): Promise<LogoSweepCounts & { dryRun?: boolean; sample?: Array<{ name: string; has_email: boolean; has_phone: boolean }> }> {
  const force = opts.force === true
  const minDays = Math.max(0, opts.minDaysBetween ?? DEFAULT_MIN_DAYS)
  const limit = Math.min(Math.max(1, opts.limit || DEFAULT_LIMIT), DEFAULT_LIMIT)
  const now = Date.now()

  const db = createAdminClient()
  const { data, error } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes')
    .eq('status', 'approved')
    .order('business_name', { ascending: true })
  if (error) throw new Error(`Could not read vendors: ${error.message}`)

  type Row = {
    id: string; business_name: string; contact_name: string | null
    email: string | null; phone: string | null; admin_notes: string | null
  }

  const paidNoLogo: Array<{ id: string; name: string; email: string | null; phone: string | null; due: boolean }> = []
  for (const r of (data || []) as Row[]) {
    const state = parsePortalState(r.admin_notes || '')
    if (!vendorNeedsLogo(state)) continue
    const sentAt = state.logo_prompt_sent_at ? Date.parse(state.logo_prompt_sent_at) : 0
    const dueByTime = !sentAt || (now - sentAt) >= minDays * 86400000
    paidNoLogo.push({
      id: r.id,
      name: firstNameOf(r.contact_name),
      email: r.email,
      phone: r.phone,
      due: force || dueByTime,
    })
  }

  const queue = paidNoLogo.filter((t) => t.due).slice(0, limit)
  const counts: LogoSweepCounts = {
    total_paid_no_logo: paidNoLogo.length,
    due: paidNoLogo.filter((t) => t.due).length,
    targeted: 0, emailed: 0, emailFailed: 0, waSent: 0, waSkipped: 0, waFailed: 0, errors: [],
  }

  if (opts.dryRun) {
    return {
      ...counts,
      targeted: queue.length,
      dryRun: true,
      sample: queue.slice(0, 10).map((t) => ({ name: t.name, has_email: !!t.email, has_phone: !!t.phone })),
    }
  }

  for (const t of queue) {
    const res = await sendLogoReminder({ applicationId: t.id, name: t.name, email: t.email, phone: t.phone, channels: opts.channels })
    counts.targeted++
    if (res.emailed) counts.emailed++
    else if (res.emailError) { counts.emailFailed++; counts.errors.push({ id: t.id, channel: 'email', error: res.emailError }) }
    if (res.waSent) counts.waSent++
    else if (res.waSkipped) counts.waSkipped++
    else if (res.waError) { counts.waFailed++; counts.errors.push({ id: t.id, channel: 'whatsapp', error: res.waError }) }
    await sleep(PACE_MS)
  }
  counts.errors = counts.errors.slice(0, 50)
  return counts
}
