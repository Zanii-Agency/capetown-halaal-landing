import { NextRequest, NextResponse } from 'next/server'
import { emailKey } from '@/lib/merge'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { sendEmail } from '@/lib/email/resend'
import { ApplicationConfirmation } from '@/lib/email/templates/ApplicationConfirmation'
import { recordConsent } from '@/lib/wa-consent'
import { toE164 } from '@/lib/whatsapp'
import { scoreCompleteness } from '@/lib/ai/completeness-scorer'
import { redactNotesForViewer } from '@/lib/eft'
import {
  checkHoneypot,
  checkEmail,
  checkTokens,
  checkIpThrottle,
  logGuardEvent,
  clientIp,
  HONEYPOT_FIELD,
} from '@/lib/security/abuse-guard'

const APPLY_ENDPOINT = 'applications'

// Escape user input before embedding in a Postgres ILIKE pattern.
// Mirror of /api/admin/search/route.ts:75 — must stay in sync.
function ilikeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

// Phone: accepts +27817534892, 0817534892, 27817534892, (081) 753 4892.
// Server strips non-digits and validates against SA mobile pattern.
const SA_MOBILE_RE = /^(\+?27|0)[1-9]\d{8}$/
const stripPhone = (raw: string) => raw.replace(/[^\d+]/g, '')

// 2026-06-14 (Agent 9): required-field surface cut from 9 to 5 to halve
// /apply drop-offs (111 in last window). Optional fields land in the queue
// with a low completeness_score so Samreen can chase if she wants to approve.
const applicationSchema = z.object({
  business_name: z.string().min(1, 'Business name required'),
  business_description: z.string().optional().default(''),
  product_categories: z.array(z.string()).min(1, 'Pick at least one category').default([]),
  website: z.string().url().optional().or(z.literal('')),
  instagram: z.string().optional(),
  facebook: z.string().optional(),
  contact_name: z.string().min(1, 'Contact name required'),
  email: z.string().email('Valid email required'),
  phone: z.string().min(1, 'Phone number required').refine(
    (v) => SA_MOBILE_RE.test(stripPhone(v)),
    'Enter a valid SA mobile number',
  ),
  preferred_booth_tier: z.string().optional(),
  special_requirements: z.string().optional(),
})

// POST: Create new application (public)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const supabase = createAdminClient()
    const ip = clientIp(request.headers)

    // 1. Honeypot. Silent 200 so bots cannot probe the defense.
    const hp = checkHoneypot(body)
    if (!hp.ok) {
      await logGuardEvent(supabase, { endpoint: APPLY_ENDPOINT, ip, reason: hp.reason!, fields: { hp: String(body[HONEYPOT_FIELD] ?? '').slice(0, 64) } })
      return NextResponse.json({ success: true, application: null, emailSent: false })
    }

    // 2. Attacker payloads in any free-text field. Done before Zod so
    // we never echo PWNED/<script back through validation errors.
    const tokenGuard = checkTokens(
      body?.business_name, body?.business_description, body?.contact_name,
      body?.email, body?.phone, body?.special_requirements, body?.preferred_booth_tier,
    )
    if (!tokenGuard.ok) {
      await logGuardEvent(supabase, { endpoint: APPLY_ENDPOINT, ip, reason: tokenGuard.reason!, fields: { email: body?.email } })
      return NextResponse.json({ error: 'Submission rejected.' }, { status: 400 })
    }

    const validated = applicationSchema.parse(body)

    // 3. Reserved TLDs + disposable providers. Real vendors do not use these.
    const emailGuard = checkEmail(validated.email)
    if (!emailGuard.ok) {
      await logGuardEvent(supabase, { endpoint: APPLY_ENDPOINT, ip, reason: emailGuard.reason!, fields: { email: validated.email } })
      return NextResponse.json({ error: 'Please use a real business email address.' }, { status: 400 })
    }

    // 4. Per-IP throttle. Fall-open on DB blip so real applicants are never blocked.
    const throttle = await checkIpThrottle(supabase, { ip, endpoint: APPLY_ENDPOINT, max: 3, windowMin: 10 })
    if (!throttle.ok) {
      await logGuardEvent(supabase, { endpoint: APPLY_ENDPOINT, ip, reason: throttle.reason!, fields: { email: validated.email } })
      return NextResponse.json({ error: 'Too many submissions. Please wait a few minutes and try again.' }, { status: 429 })
    }

    // Duplicate-email SOFT block (multi-apply, 2026-06-20). One person may run
    // several stalls, so they can submit multiple applications. We only block a
    // new submission while an existing one is still IN THE PIPELINE
    // (pending / info_requested) — that would just be a confusing double-submit.
    // Once prior applications are resolved (approved or rejected) a fresh
    // application is allowed and gets soft-linked by email at query time.
    // ilike, not eq. THE root cause of every duplicate in this database: `.eq`
    // is case-SENSITIVE, so when a vendor re-applied and their browser
    // capitalised the first letter (Israarahman91@ vs israarahman91@) this check
    // found nothing and waved a second application straight through. Six of the
    // seven live duplicate clusters differ ONLY by case. Those pairs then made
    // every email lookup ambiguous, which is how a paid vendor got told we could
    // not verify them (2026-07-26).
    const { data: existingApps } = await supabase
      .from('vendor_applications')
      .select('id, status')
      .ilike('email', emailKey(validated.email))

    const inPipeline = (existingApps || []).find(
      (a) => a.status === 'pending' || a.status === 'info_requested'
    )
    if (inPipeline) {
      return NextResponse.json(
        { error: 'You already have an application under review with this email address. We will be in touch. If you need to change it, reply to our email or contact support@youngatheart.co.za.' },
        { status: 409 }
      )
    }

    // Compute completeness server-side so the admin queue can rank by it
    // and Samreen can see at a glance which applications need chasing.
    const completeness = scoreCompleteness({
      contact_name: validated.contact_name,
      business_name: validated.business_name,
      business_description: validated.business_description,
      product_categories: validated.product_categories,
      phone: stripPhone(validated.phone),
      email: validated.email,
      instagram: validated.instagram,
      facebook: validated.facebook,
      website: validated.website || null,
      special_requirements: validated.special_requirements,
      preferred_booth_tier: validated.preferred_booth_tier,
    })

    const { data, error } = await supabase
      .from('vendor_applications')
      .insert({
        ...validated,
        phone: stripPhone(validated.phone),
        // Normalised on the way IN, so the stored row can never be the odd-case
        // one that a later ilike lookup has to compensate for.
        email: emailKey(validated.email),
        website: validated.website || null,
        completeness_score: completeness.score,
      })
      .select()
      .single()

    if (error) {
      console.error('Supabase error:', error)
      return NextResponse.json(
        { error: 'Failed to submit application' },
        { status: 500 }
      )
    }

    // Auto opt-in (T&C basis): submitting a vendor application = agreeing to
    // receive festival updates and communications. Record WhatsApp consent to
    // the proof ledger. Never blocks the application. STOP still hard-blocks.
    try {
      const waPhone = toE164(validated.phone)
      if (waPhone) {
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined
        await recordConsent({
          waPhone,
          source: 'vendor_form',
          ip,
          userAgent: request.headers.get('user-agent') || undefined,
          profileName: validated.business_name,
        })
      }
    } catch (consentError) {
      console.error('[applications] wa consent capture failed:', consentError)
    }

    // Send confirmation email. We never block the applicant on email, but we
    // no longer pretend it worked — the result is logged loudly and returned.
    let emailSent = false
    try {
      const res = await sendEmail({
        to: validated.email,
        subject: 'Application Received - Young at Heart Festival 2026',
        react: ApplicationConfirmation({
          businessName: validated.business_name,
          contactName: validated.contact_name,
          email: validated.email,
        }),
      })
      emailSent = res.ok
      if (!res.ok) {
        console.error(`[applications] confirmation email FAILED for ${validated.email}: ${res.error}`)
      }
    } catch (emailError) {
      console.error('[applications] confirmation email threw:', emailError)
    }

    // Best-effort owner notification — never block the applicant on this.
    try {
      const { notifyOwners } = await import('@/lib/bot/notify')
      await notifyOwners({
        event: 'application_received',
        body: `New vendor application: ${validated.business_name} (${validated.email}). Booth chosen: ${validated.preferred_booth_tier || 'not specified'}.`,
        audience: 'all',
        // CARVE-OUT: deliberately NO vendorId. A brand-new application has
        // admin_notes null and paid_at null, so the lane predicate would return
        // true under global EFT mode and mute the festival owner from EVERY new
        // applicant, which is her core duty. Operator-confirmed 2026-07-25.
      })
    } catch (notifyError) {
      console.error('[applications] notify owner failed:', notifyError)
    }

    // Best-effort: instant ack to the vendor on WhatsApp.
    try {
      const phone = (validated.phone || '') as string
      if (phone) {
        const { sendTemplate, toE164 } = await import('@/lib/whatsapp')
        const firstName = (validated.contact_name as string).trim().split(/\s+/)[0] || 'there'
        const wa = await sendTemplate(toE164(phone), 'vendor_application_received', [firstName], { category: 'utility' })
        if (wa.skipped) console.warn('[applications] WA ack skipped:', wa.skipped)
      }
    } catch (e) {
      console.error('[applications] WA ack failed:', (e as Error).message)
    }

    // Create a vendor ticket for the new application
    try {
      const { createAdminClient } = await import('@/lib/supabase/admin')
      const ticketAdmin = createAdminClient()
      await ticketAdmin.from('vendor_tickets').insert({
        vendor_application_id: data.id,
        status: 'open',
      })
    } catch (ticketError) {
      console.error('[applications] ticket creation failed:', ticketError)
    }

    return NextResponse.json({ success: true, application: data, emailSent })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.issues },
        { status: 400 }
      )
    }
    console.error('Application error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// GET: List applications (admin only)
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Check if user is authenticated
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if user is admin (use admin client to bypass RLS on admin_users)
    const admin = createAdminClient()
    const { data: adminUser } = await admin
      .from('admin_users')
      .select()
      .eq('id', user.id)
      .single()

    if (!adminUser) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Get query params for filtering
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const search = searchParams.get('search')

    // Build query (use admin client to bypass RLS)
    let query = admin
      .from('vendor_applications')
      .select('*')
      .order('created_at', { ascending: false })

    if (status && status !== 'all') {
      query = query.eq('status', status)
    }

    if (search) {
      // Strip PostgREST filter delimiters (comma, parens) before escaping the
      // ILIKE wildcards; cap to 100 chars so an attacker cannot flood the OR clause.
      const safeSearch = ilikeEscape(search.slice(0, 100).replace(/[,()]/g, ' '))
      const pattern = `%${safeSearch}%`
      query = query.or(
        `business_name.ilike.${pattern},contact_name.ilike.${pattern},email.ilike.${pattern}`
      )
    }

    const { data, error } = await query

    if (error) {
      console.error('Query error:', error)
      return NextResponse.json(
        { error: 'Failed to fetch applications' },
        { status: 500 }
      )
    }

    // Wall (CTH Law 2): this whole-roster read returns raw admin_notes, which
    // carries the covert ⟦EFT⟧ marker + base64 ⟦PORTAL⟧ payment state. Redact
    // the covert markers for every non-EFT-admin caller (a filtered UI in front
    // of an unfiltered route is a cosmetic seal). ⟦STALL:..⟧ + prose survive.
    const viewerEmail = (adminUser.email as string | null) || user.email || null
    const applications = (data || []).map((a) => ({
      ...a,
      admin_notes: redactNotesForViewer(a.admin_notes as string | null, viewerEmail),
    }))
    return NextResponse.json({ applications })
  } catch (error) {
    console.error('GET applications error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
