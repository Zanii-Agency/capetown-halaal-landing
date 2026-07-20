// =============================================================================
// /api/admin/broadcast/preview
//
// Drives the broadcast composer preview pane. Two responsibilities:
//
//   GET ?<filters>
//       Returns up to N audience members (id, business_name, contact_name)
//       so the UI can render a "preview as: <vendor> ▾" picker.
//
//   POST { template_key, custom_message?, vendor_id?, free_text? }
//       Renders the template for the chosen audience member (or the first
//       audience member if no vendor_id given), substituting merge tags via
//       lib/interpolate. Returns { subject, body_text } so the composer can
//       show exactly what each recipient will receive.
//
//       If `free_text` is supplied (the "Write your own" mode), the body is
//       returned verbatim after interpolation; no template is rendered.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import {
  TEMPLATE_KEYS,
  renderMailTemplatePreview,
  findMailTemplate,
  type TemplateKey,
  type TemplateVars,
} from '@/lib/mail/templates'
import { renderTemplate } from '@/lib/interpolate'
import { parseAllocation } from '@/lib/stalls'
import { parsePortalState } from '@/lib/portal-state'

export const dynamic = 'force-dynamic'

interface AudienceRow {
  id: string
  business_name: string | null
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

/** Paid truth, mirroring lib/exhibitor-paygate.ts isPaid(). No ⟦PAID⟧ marker exists. */
function isPaidRow(r: AudienceRow): boolean {
  if (r.paid_at) return true
  return parsePortalState(r.admin_notes).payment?.status === 'paid'
}

/** Contract-signed truth: the column the /exhibitor/contract/sign route stamps. */
function isContractSignedRow(r: AudienceRow): boolean {
  return !!r.contract_signed_at
}

async function assertAdmin(): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }
  const admin = createAdminClient()
  const { data: adminUser } = await admin
    .from('admin_users')
    .select('id')
    .eq('id', user.id)
    .single()
  if (!adminUser) return { ok: false, status: 403, error: 'Forbidden' }
  return { ok: true }
}

function parseBool(v: string | null): boolean | null {
  if (v == null) return null
  if (v === '1' || v === 'true' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'no') return false
  return null
}

async function buildAudience(params: URLSearchParams): Promise<AudienceRow[]> {
  const admin = createAdminClient()
  let q = admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, preferred_booth_tier, product_categories, status, admin_notes, paid_at, contract_signed_at')
    .limit(50)

  const status = params.get('status')
  const sector = params.get('sector')
  const boothTier = params.get('booth_tier')
  const hasDocs = parseBool(params.get('has_docs'))
  const contractSigned = parseBool(params.get('contract_signed'))
  const paid = parseBool(params.get('paid'))

  if (status) q = q.eq('status', status)
  if (boothTier) q = q.eq('preferred_booth_tier', boothTier)
  if (sector) q = q.contains('product_categories', [sector])

  const { data, error } = await q
  if (error) return []
  const rows = (data || []) as AudienceRow[]
  return rows.filter((r) => {
    const n = r.admin_notes || ''
    if (hasDocs === true && !n.includes('⟦DOCS:complete⟧')) return false
    if (hasDocs === false && n.includes('⟦DOCS:complete⟧')) return false
    if (contractSigned === true && !isContractSignedRow(r)) return false
    if (contractSigned === false && isContractSignedRow(r)) return false
    if (paid === true && !isPaidRow(r)) return false
    if (paid === false && isPaidRow(r)) return false
    return true
  })
}

function firstNameOrNull(contact?: string | null): string | null {
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

function varsFor(row: AudienceRow, customMessage: string): TemplateVars {
  return {
    first_name: firstNameOrNull(row.contact_name),
    business_name: row.business_name || null,
    stall_code: stallFromNotes(row.admin_notes),
    custom_message: customMessage || '',
  }
}

// ---------------------------------------------------------------------------
// GET — audience sample (for "preview as: <vendor>" dropdown).
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await assertAdmin()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const url = new URL(req.url)
  const audience = await buildAudience(url.searchParams)
  return NextResponse.json({
    audience: audience.slice(0, 25).map((r) => ({
      id: r.id,
      business_name: r.business_name || '',
      contact_name: r.contact_name || '',
    })),
    total: audience.length,
  })
}

// ---------------------------------------------------------------------------
// POST — render a single preview for a given (template_key | free_text) +
// audience member.
// ---------------------------------------------------------------------------

interface PreviewBody {
  template_key?: TemplateKey
  custom_message?: string
  vendor_id?: string
  free_text?: string
  filters?: Record<string, string | boolean | null>
}

export async function POST(req: NextRequest) {
  // RBAC: owner/operator only. POST renders vendor PII (merge-tag substitution
  // of names, business names, stall codes) into the preview, so a viewer-role
  // admin must not run it. requireOperator (centralized gate, replacing the
  // inline assertAdmin) preserves 401-before-403 semantics. The GET audience
  // sample stays membership-only by design (read-only picker data).
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  let body: PreviewBody
  try {
    body = await req.json() as PreviewBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Find an audience row to use as the preview sample. We use the supplied
  // filter set when building the audience so the preview reflects the actual
  // outbound slice.
  const params = new URLSearchParams()
  if (body.filters) {
    for (const [k, v] of Object.entries(body.filters)) {
      if (v != null && v !== '') params.set(k, String(v))
    }
  }
  const audience = await buildAudience(params)

  const sample =
    (body.vendor_id ? audience.find((a) => a.id === body.vendor_id) : audience[0]) ||
    audience[0] ||
    // Synthetic sample when audience is empty so the picker still renders.
    {
      id: 'sample',
      business_name: 'Spice & Soul Kitchen',
      contact_name: 'Aisha Mahomed',
      email: null,
      phone: null,
      preferred_booth_tier: null,
      product_categories: null,
      status: null,
      admin_notes: null,
    } as AudienceRow

  const vars = varsFor(sample, body.custom_message || '')

  // Free-text mode: interpolate the raw text and return as a single body.
  if (body.free_text != null) {
    const text = renderTemplate(body.free_text, vars as Record<string, string | number | null | undefined>)
    return NextResponse.json({
      mode: 'free_text',
      subject: '(no subject)',
      body_text: text,
      sample: { id: sample.id, business_name: sample.business_name, contact_name: sample.contact_name },
      audience_total: audience.length,
    })
  }

  // Template mode.
  if (!body.template_key || !TEMPLATE_KEYS.includes(body.template_key)) {
    return NextResponse.json({ error: 'Unknown or missing template_key' }, { status: 400 })
  }
  const spec = findMailTemplate(body.template_key)
  if (!spec) return NextResponse.json({ error: 'Template not found' }, { status: 400 })

  const { subject, body: bodyText } = renderMailTemplatePreview(spec, vars)

  return NextResponse.json({
    mode: 'template',
    template_key: body.template_key,
    subject,
    body_text: bodyText,
    sample: { id: sample.id, business_name: sample.business_name, contact_name: sample.contact_name },
    audience_total: audience.length,
  })
}
