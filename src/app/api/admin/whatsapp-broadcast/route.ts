// =============================================================================
// /api/admin/whatsapp-broadcast
//
// One route, two responsibilities, two modes:
//
//   GET  ?counts=1&<filters>
//       Returns the audience count for both channels (mail + wa) given the
//       supplied filter set. Used by the admin UI to gate the Send button
//       behind a confirmation modal with the exact number.
//
//   POST { channel, filters, template_key, custom_message? }
//       Builds the audience, then dispatches.
//         channel = 'mail' | 'wa' | 'both'
//         filters = same shape as GET querystring
//         template_key = 'doc_chase' | 'payment_reminder' | ...
//         custom_message = optional override text injected as {{custom_message}}
//
// Filter columns:
//   status            = one of pending|approved|rejected|info_requested
//   sector            = matches inside vendor_applications.product_categories[]
//   booth_tier        = exact match on preferred_booth_tier
//   has_docs          = true|false (true = admin_notes contains '⟦DOCS:complete⟧')
//   contract_signed   = true|false (true = vendor_applications.contract_signed_at IS NOT NULL,
//                       the column the /exhibitor/contract/sign route stamps)
//   paid              = true|false (true = paid_at IS NOT NULL OR
//                       parsePortalState(admin_notes).payment.status==='paid', same isPaid()
//                       truth the paygate + confirm.ts use; NO ⟦PAID⟧ marker is ever written)
//
// Doctrine notes:
//   - Outbound mail always goes through zanii-sender (Resend only).
//   - Outbound WA always goes through whatsapp/sender (WABA stub if not wired).
//   - We dedupe by email for mail, by phone for WA.
//   - We exclude mail_optout for mail; WA exclusion via wa_consent will land
//     when that column exists (defensive null-check in the meantime).
//   - Pacing: mail at 4/sec (250ms), WA at 1 every 250ms.
//   - Every message logs to mail_messages with full headers so inbound
//     reconciliation works.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendZaniiMail, pacer } from '@/lib/mail/zanii-sender'
import { sendTemplate } from '@/lib/whatsapp/sender'
import { renderTemplate, TEMPLATE_KEYS, type TemplateKey, type TemplateVars } from '@/lib/mail/templates'
import { buildUnsubUrl } from '@/lib/mail/unsubscribe-token'
import { renderTemplate as interpolate, type InterpolateVars } from '@/lib/interpolate'
import { parseAllocation } from '@/lib/stalls'
import { parsePortalState } from '@/lib/portal-state'
import { assertRole } from '@/lib/admin-rbac'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ---------------------------------------------------------------------------
// Auth helper.
//
// POST: requires owner|operator role so a leaked viewer session cannot blast
// the audience.
// GET (counts): viewer is OK because it's read-only audience sizing for the
// confirm modal.
// ---------------------------------------------------------------------------

async function assertAdmin(
  requireRole: boolean = false,
): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }
  const admin = createAdminClient()
  const { data: adminUser } = await admin
    .from('admin_users')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle()
  if (!adminUser) return { ok: false, status: 403, error: 'Forbidden' }
  if (requireRole) {
    // Fail-closed role gate. A null/unknown role must NOT default to operator —
    // assertRole throws on anything outside owner|operator.
    try {
      await assertRole(user.id, ['owner', 'operator'])
    } catch {
      return { ok: false, status: 403, error: 'insufficient_role' }
    }
  }
  return { ok: true, userId: user.id }
}

// ---------------------------------------------------------------------------
// H2: per-admin broadcast rate limit + audience cap + WA template allowlist.
// Mirrors the chase route. Map is process-local (Vercel single-instance fine);
// resets on cold start.
// ---------------------------------------------------------------------------

const broadcastRateBuckets = new Map<string, { count: number; resetAt: number }>()
const BROADCAST_RATE_WINDOW_MS = 60_000 // 1 minute
const BROADCAST_RATE_MAX = 3            // 3 broadcast POSTs / admin / minute
const BROADCAST_MAX_RECIPIENTS = 500

function checkBroadcastRate(actorKey: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()
  const bucket = broadcastRateBuckets.get(actorKey)
  if (!bucket || bucket.resetAt <= now) {
    broadcastRateBuckets.set(actorKey, { count: 1, resetAt: now + BROADCAST_RATE_WINDOW_MS })
    if (broadcastRateBuckets.size > 500) {
      for (const [k, v] of broadcastRateBuckets) if (v.resetAt <= now) broadcastRateBuckets.delete(k)
    }
    return { ok: true }
  }
  if (bucket.count >= BROADCAST_RATE_MAX) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  bucket.count++
  return { ok: true }
}

// Same allowlist as the chase route. Anything outside this list returns 400
// so a leaked admin session can't pivot to firing an arbitrary marketing
// template at the entire vendor list.
const ALLOWED_WA_TEMPLATES = new Set<string>([
  'general_announcement',
  'vendor_application_approved',
  'vendor_application_declined',
  'vendor_document_request',
  'vendor_payment_reminder',
  'vendor_stall_allocation',
  'vendor_setup_reminder',
  'contract_sign_reminder',
])

// ---------------------------------------------------------------------------
// Filter shape + parsing.
// ---------------------------------------------------------------------------

export interface BroadcastFilters {
  status?: string | null
  sector?: string | null
  booth_tier?: string | null
  has_docs?: boolean | null
  contract_signed?: boolean | null
  paid?: boolean | null
}

function parseBoolParam(v: string | null | undefined): boolean | null {
  if (v == null) return null
  if (v === '1' || v === 'true' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'no') return false
  return null
}

function filtersFromSearch(params: URLSearchParams): BroadcastFilters {
  return {
    status: params.get('status') || null,
    sector: params.get('sector') || null,
    booth_tier: params.get('booth_tier') || null,
    has_docs: parseBoolParam(params.get('has_docs')),
    contract_signed: parseBoolParam(params.get('contract_signed')),
    paid: parseBoolParam(params.get('paid')),
  }
}

// ---------------------------------------------------------------------------
// Audience builder.
//
// AND-of-filters. We pull a minimal column set and filter in-process for
// admin_notes marker conditions, since those are not indexed.
// ---------------------------------------------------------------------------

interface AudienceRow {
  id: string
  business_name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  preferred_booth_tier: string | null
  product_categories: string[] | null
  status: string | null
  admin_notes: string | null
  paid_at: string | null
  contract_signed_at: string | null
}

const DOCS_COMPLETE_MARKER = '⟦DOCS:complete⟧'

/**
 * Single source of "paid" truth. Mirrors lib/exhibitor-paygate.ts isPaid():
 * a vendor counts as paid when the first-class column says so (Yoco webhook /
 * admin mark-paid via confirm.ts) OR the legacy base64 portal-state marker
 * does. NO code ever writes a literal ⟦PAID⟧ marker, so the old
 * notes.includes('⟦PAID⟧') predicate always matched zero rows.
 */
function isPaidRow(r: AudienceRow): boolean {
  if (r.paid_at) return true
  return parsePortalState(r.admin_notes).payment?.status === 'paid'
}

/** Contract-signed truth: the column the /exhibitor/contract/sign route stamps. */
function isContractSignedRow(r: AudienceRow): boolean {
  return !!r.contract_signed_at
}

async function buildAudience(filters: BroadcastFilters): Promise<AudienceRow[]> {
  const admin = createAdminClient()
  let q = admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, preferred_booth_tier, product_categories, status, admin_notes, paid_at, contract_signed_at')

  if (filters.status) q = q.eq('status', filters.status)
  if (filters.booth_tier) q = q.eq('preferred_booth_tier', filters.booth_tier)
  if (filters.sector) q = q.contains('product_categories', [filters.sector])

  const { data, error } = await q
  if (error) {
    console.error('Audience query error', error)
    return []
  }
  const rows = (data || []) as AudienceRow[]
  return rows.filter((r) => {
    const notes = r.admin_notes || ''
    if (filters.has_docs === true && !notes.includes(DOCS_COMPLETE_MARKER)) return false
    if (filters.has_docs === false && notes.includes(DOCS_COMPLETE_MARKER)) return false
    if (filters.contract_signed === true && !isContractSignedRow(r)) return false
    if (filters.contract_signed === false && isContractSignedRow(r)) return false
    if (filters.paid === true && !isPaidRow(r)) return false
    if (filters.paid === false && isPaidRow(r)) return false
    return true
  })
}

async function loadOptOutEmails(): Promise<Set<string>> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('mail_optout').select('email')
  if (error) {
    // Table may not exist pre-migration. Fail open so dev preview works.
    return new Set()
  }
  return new Set((data || []).map((r: { email: string }) => r.email.toLowerCase()))
}

// ---------------------------------------------------------------------------
// GET — audience counts.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await assertAdmin(false)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const url = new URL(req.url)
  if (url.searchParams.get('counts') !== '1') {
    return NextResponse.json({ error: 'Use ?counts=1 with filters' }, { status: 400 })
  }
  const filters = filtersFromSearch(url.searchParams)
  const audience = await buildAudience(filters)
  const optout = await loadOptOutEmails()

  const mailRecipients = new Set<string>()
  const waRecipients = new Set<string>()
  for (const r of audience) {
    if (r.email) {
      const e = r.email.trim().toLowerCase()
      if (e && !optout.has(e)) mailRecipients.add(e)
    }
    if (r.phone) {
      const p = r.phone.replace(/[^0-9]/g, '')
      if (p.length >= 9) waRecipients.add(p)
    }
  }

  return NextResponse.json({
    audience_total: audience.length,
    mail_count: mailRecipients.size,
    wa_count: waRecipients.size,
    filters,
    optout_count: optout.size,
  })
}

// ---------------------------------------------------------------------------
// POST — dispatch.
// ---------------------------------------------------------------------------

interface BroadcastBody {
  channel: 'mail' | 'wa' | 'both'
  filters?: BroadcastFilters
  /** Required unless `free_text` is supplied. */
  template_key?: TemplateKey
  custom_message?: string
  /** Approved WABA template name override (defaults to template_key). */
  wa_template?: string
  /** Dry run — build audience and return counts without sending. */
  dry_run?: boolean
  /**
   * "Write your own" mode. When supplied, the body is sent verbatim (after
   * merge-tag interpolation) instead of rendering a registered template. WA
   * channel falls back to {{custom_message}} of `general_announcement` so the
   * approved WABA template name stays valid; mail bypasses the template
   * registry entirely.
   */
  free_text?: string
  /** Subject for free_text mode (mail only). Falls back to a generic line. */
  free_text_subject?: string
}

/**
 * Extract first token from contact_name. Returns `null` when absent so the
 * interpolation helper can drop the placeholder and clean surrounding
 * punctuation (e.g. "Hi {{first_name}}," -> "Hi,") instead of injecting a
 * stilted fallback like "Hi there,".
 */
function firstName(contact?: string | null): string | null {
  if (!contact) return null
  const t = contact.trim().split(/\s+/)[0]
  return t || null
}

function stallFromNotes(notes?: string | null): string | undefined {
  if (!notes) return undefined
  // Multi-booth: join the vendor's code list for the {{stall}} merge token.
  const { stalls } = parseAllocation(notes)
  return stalls.length ? stalls.join(', ') : undefined
}

export async function POST(req: NextRequest) {
  // H2: POST requires owner|operator. Viewer can size the audience via GET
  // but cannot dispatch.
  const auth = await assertAdmin(true)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  // H2: per-admin rate limit. Mirrors chase route.
  const rate = checkBroadcastRate(`broadcast:${auth.userId}`)
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retry_after_seconds: rate.retryAfter },
      { status: 429, headers: { 'retry-after': String(rate.retryAfter) } },
    )
  }

  let body: BroadcastBody
  try {
    body = await req.json() as BroadcastBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.channel || !['mail', 'wa', 'both'].includes(body.channel)) {
    return NextResponse.json({ error: 'channel must be mail | wa | both' }, { status: 400 })
  }
  const freeTextMode = !!(body.free_text && body.free_text.trim().length > 0)
  if (!freeTextMode && (!body.template_key || !TEMPLATE_KEYS.includes(body.template_key))) {
    return NextResponse.json({ error: 'unknown template_key' }, { status: 400 })
  }
  // H2: WA template allowlist (only matters when this dispatch will touch WA).
  if ((body.channel === 'wa' || body.channel === 'both') && body.wa_template && !ALLOWED_WA_TEMPLATES.has(body.wa_template)) {
    return NextResponse.json({ error: 'unknown wa_template' }, { status: 400 })
  }

  const filters = body.filters || {}
  const audience = await buildAudience(filters)
  const optout = await loadOptOutEmails()

  // H2: audience cap. Refuse to dispatch a >500 blast in a single call. Real
  // ops use either splits into approved-tier slices or fires a /chase loop.
  if (audience.length > BROADCAST_MAX_RECIPIENTS) {
    return NextResponse.json(
      {
        error: 'audience_too_large',
        max: BROADCAST_MAX_RECIPIENTS,
        got: audience.length,
        hint: 'Tighten the filters or split the send.',
      },
      { status: 413 },
    )
  }

  const dryRun = !!body.dry_run
  const channel = body.channel
  const adminDb = createAdminClient()

  const seenEmails = new Set<string>()
  const seenPhones = new Set<string>()
  const results = {
    audience_total: audience.length,
    mail: { attempted: 0, sent: 0, failed: 0, skipped: 0 },
    wa: { attempted: 0, sent: 0, failed: 0, skipped: 0 },
    dry_run: dryRun,
    errors: [] as Array<{ kind: 'mail' | 'wa'; to: string; error: string }>,
  }

  for (const row of audience) {
    const vars: TemplateVars = {
      first_name: firstName(row.contact_name),
      business_name: row.business_name || 'your stand',
      stall_code: stallFromNotes(row.admin_notes),
      custom_message: body.custom_message || '',
    }

    // ---------------- mail ----------------
    if (channel === 'mail' || channel === 'both') {
      const emailRaw = (row.email || '').trim().toLowerCase()
      if (emailRaw && !seenEmails.has(emailRaw) && !optout.has(emailRaw)) {
        seenEmails.add(emailRaw)
        results.mail.attempted++
        if (!dryRun) {
          const unsubscribeUrl = buildUnsubUrl(emailRaw)
          const rendered = freeTextMode
            ? await renderFreeText(body.free_text!, body.free_text_subject || 'An update from Young at Heart Festival', { ...vars, unsubscribe_url: unsubscribeUrl })
            : await renderTemplate(body.template_key!, { ...vars, unsubscribe_url: unsubscribeUrl })
          const send = await sendZaniiMail({
            to: emailRaw,
            subject: rendered.subject,
            html: rendered.body_html,
            text: rendered.body_text,
            unsubscribeToken: unsubscribeUrl.split('/').pop(),
            tags: [
              { name: 'template', value: body.template_key || 'free_text' },
              { name: 'channel', value: 'mail' },
            ],
          })
          if (send.ok) {
            results.mail.sent++
          } else {
            results.mail.failed++
            results.errors.push({ kind: 'mail', to: emailRaw, error: send.error || 'unknown' })
          }
          // Log to mail_messages. Best-effort; if the table is missing the
          // insert fails and we just log it.
          try {
            await adminDb.from('mail_messages').insert({
              direction: 'out',
              mailbox: send.fromUsed || 'hello@youngatheart.co.za',
              from_addr: send.fromUsed || 'hello@youngatheart.co.za',
              to_addr: emailRaw,
              subject: rendered.subject,
              body_text: rendered.body_text,
              body_html: rendered.body_html,
              message_id: send.messageId || `<broadcast-${Date.now()}@event.youngatheart.co.za>`,
              status: send.ok ? 'sent' : 'failed',
              error: send.ok ? null : (send.error || null),
              provider_message_id: send.providerMessageId || null,
              vendor_application_id: row.id,
            })
          } catch (e) {
            console.warn('mail_messages insert failed:', (e as Error).message)
          }
          await pacer(250) // 4/sec
        } else {
          results.mail.sent++
        }
      } else if (emailRaw && (seenEmails.has(emailRaw) || optout.has(emailRaw))) {
        results.mail.skipped++
      }
    }

    // ---------------- whatsapp ----------------
    if (channel === 'wa' || channel === 'both') {
      const phoneRaw = (row.phone || '').replace(/[^0-9]/g, '')
      if (phoneRaw && phoneRaw.length >= 9 && !seenPhones.has(phoneRaw)) {
        seenPhones.add(phoneRaw)
        results.wa.attempted++
        if (!dryRun) {
          const waTemplate =
            body.wa_template ||
            body.template_key ||
            // Free-text mode still needs an approved WABA template name; the
            // free text becomes {{custom_message}} inside general_announcement.
            'general_announcement'
          // H2: defence-in-depth. body-level check is the front door; this
          // catches the case where template_key was a non-allowlisted name.
          if (!ALLOWED_WA_TEMPLATES.has(waTemplate)) {
            results.wa.failed++
            results.errors.push({ kind: 'wa', to: phoneRaw, error: `template not allowed: ${waTemplate}` })
            continue
          }
          const waCustom = freeTextMode
            ? interpolate(body.free_text || '', vars as InterpolateVars)
            : (body.custom_message || '')
          const send = await sendTemplate({
            to: phoneRaw,
            template: waTemplate,
            variables: [
              // Meta WABA rejects empty positional vars, so we fall back to
              // 'there' here. Email uses the interpolate helper which drops
              // the placeholder gracefully instead.
              vars.first_name || 'there',
              vars.business_name || '',
              vars.stall_code || '',
              waCustom,
            ].filter((v) => v.length > 0),
          })
          if (send.ok) {
            results.wa.sent++
          } else if (send.skipped) {
            results.wa.skipped++
          } else {
            results.wa.failed++
            results.errors.push({ kind: 'wa', to: phoneRaw, error: send.error || 'unknown' })
          }
          await pacer(250)
        } else {
          results.wa.sent++
        }
      } else if (phoneRaw && seenPhones.has(phoneRaw)) {
        results.wa.skipped++
      }
    }
  }

  return NextResponse.json(results)
}

// ---------------------------------------------------------------------------
// Free-text renderer for the "Write your own" composer mode. Bypasses the
// template registry, interpolates merge tags via lib/interpolate, and wraps
// the body in a minimal HTML shell. The Campaign React template is skipped
// here because the operator is asserting the message is ready to send.
// ---------------------------------------------------------------------------

async function renderFreeText(
  text: string,
  subject: string,
  vars: TemplateVars & { unsubscribe_url?: string },
): Promise<{ subject: string; body_text: string; body_html: string }> {
  const body = interpolate(text, vars as InterpolateVars)
  const subj = interpolate(subject, vars as InterpolateVars)
  const escaped = body.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string))
  const html =
    `<div style="font-family:Inter,Arial,sans-serif;color:#1B1A17;line-height:1.55;font-size:15px">` +
    escaped.split('\n').map((l) => l.trim().length === 0 ? '<br/>' : `<p style="margin:0 0 12px">${l}</p>`).join('') +
    (vars.unsubscribe_url
      ? `<p style="margin-top:24px;font-size:12px;color:#666">Unsubscribe: <a href="${vars.unsubscribe_url}">${vars.unsubscribe_url}</a></p>`
      : '') +
    `</div>`
  return { subject: subj, body_text: body, body_html: html }
}
