import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email/resend'
import { ApplicationConfirmation } from '@/lib/email/templates/ApplicationConfirmation'
import { ApplicationApproved } from '@/lib/email/templates/ApplicationApproved'
import { ApplicationRejected } from '@/lib/email/templates/ApplicationRejected'
import { ApplicationInfoRequested } from '@/lib/email/templates/ApplicationInfoRequested'
import { ApplicationIncomplete } from '@/lib/email/templates/ApplicationIncomplete'
import { ApplicationDelayNotice } from '@/lib/email/templates/ApplicationDelayNotice'
import { PasswordReset } from '@/lib/email/templates/PasswordReset'
import { Campaign } from '@/lib/email/templates/Campaign'
import { VendorPaymentReminder } from '@/lib/email/templates/VendorPaymentReminder'
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const maxDuration = 60

async function authorize(request: NextRequest): Promise<boolean> {
  // Header-only Bearer (constant-time). `?secret=` query branch removed
  // because it leaks into access logs / browser history / referrers.
  if (verifyCronAuth(request.headers.get('authorization'))) return true

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  return !!adminUser
}

const SAMPLES = {
  confirmation: () => ({
    subject: '[Preview] Application received, Young at Heart Festival 2026',
    react: ApplicationConfirmation({ contactName: 'Aisha', businessName: 'Spice & Soul Kitchen', email: 'aisha@example.com' }),
  }),
  approved: () => ({
    subject: '[Preview] Your application has been approved, Young at Heart Festival 2026',
    react: ApplicationApproved({ contactName: 'Aisha', businessName: 'Spice & Soul Kitchen', email: 'aisha@example.com', boothTier: 'Premium Food Stall (3m × 3m)', tempPassword: 'YAH-7K2P' }),
  }),
  delay: () => ({
    subject: '[Preview] An update on your application, Young at Heart Festival 2026',
    react: ApplicationDelayNotice({ firstName: 'Aisha', businessName: 'Spice & Soul Kitchen' }),
  }),
  rejected: () => ({
    subject: '[Preview] An update on your application, Young at Heart Festival 2026',
    react: ApplicationRejected({ contactName: 'Aisha', businessName: 'Spice & Soul Kitchen' }),
  }),
  info_requested: () => ({
    subject: '[Preview] A little more information needed, Young at Heart Festival 2026',
    react: ApplicationInfoRequested({ contactName: 'Aisha', businessName: 'Spice & Soul Kitchen' }),
  }),
  incomplete: () => ({
    subject: '[Preview] You’re almost there, Young at Heart Festival 2026',
    react: ApplicationIncomplete({ contactName: 'Aisha', businessName: 'Spice & Soul Kitchen' }),
  }),
  password_reset: () => ({
    subject: '[Preview] Reset your Young at Heart Festival exhibitor password',
    react: PasswordReset({ contactName: 'Aisha', resetUrl: 'https://cthalaal.co.za/exhibitor/set-password#example-token' }),
  }),
  campaign: () => ({
    subject: '[Preview] You’re invited, Young at Heart Festival 2026',
    react: Campaign({
      preview: 'Three days of food, fashion and family, 11–13 December 2026.',
      heading: 'The countdown is on',
      greeting: 'Hi Aisha,',
      paragraphs: [
        'We can’t wait to welcome you to the third Young at Heart Festival, three days of the finest halaal food, fashion, and family entertainment Cape Town has to offer.',
        'Over 350 vendors, live entertainment, and 25,000+ visitors across one unforgettable weekend at Youngsfield Military Base.',
      ],
      cta: { label: 'Get Your Tickets →', href: 'https://tickets.youngatheart.co.za' },
      showEvent: true,
      signoff: 'See you there,',
    }),
  }),
  payment_reminder: () => ({
    subject: '[Preview] Reminder, your YAH Festival stall fee, Spice & Soul Kitchen',
    react: VendorPaymentReminder({
      contactName: 'Aisha Khan',
      businessName: 'Spice & Soul Kitchen',
      amount: 6500,
      dueDate: '22 July 2026',
      daysRemaining: 14,
      invoiceUrl: 'https://cthalaal.co.za/exhibitor/portal/invoice',
      payUrl: 'https://cthalaal.co.za/exhibitor/portal/payments',
      weekNumber: 2,
    }),
  }),
} as const

export async function GET(request: NextRequest) {
  if (!(await authorize(request))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const template = (url.searchParams.get('template') || '') as keyof typeof SAMPLES
  const to = url.searchParams.get('to')
  if (!SAMPLES[template]) {
    return NextResponse.json({ error: `template must be one of: ${Object.keys(SAMPLES).join(', ')}` }, { status: 400 })
  }
  if (!to) return NextResponse.json({ error: 'to is required' }, { status: 400 })

  const { subject, react } = SAMPLES[template]()
  const result = await sendEmail({ to, subject, react })
  return NextResponse.json({ template, to, ...result })
}
