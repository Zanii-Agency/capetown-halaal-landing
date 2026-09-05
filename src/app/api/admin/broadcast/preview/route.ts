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
import {
  type AudienceRow,
  buildAudience,
  filtersFromSearch,
  filtersFromBody,
} from '@/lib/broadcast-audience'

export const dynamic = 'force-dynamic'

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

// Audience building (filter parsing + derivation) is shared with the dispatch
// route via lib/broadcast-audience. buildAudience there reads all matching rows;
// this route only needs a sample, so callers slice after.

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
  const audience = await buildAudience(filtersFromSearch(url.searchParams))
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
  const audience = await buildAudience(filtersFromBody(body.filters))

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
      paid_at: null,
      contract_signed_at: null,
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
