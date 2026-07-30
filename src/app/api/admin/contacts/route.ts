import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { laneScopeFor } from '@/lib/inbox-lane'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Unified Contacts: aggregates every person across 4 sources so admins can
 * see/search/email everyone in one place.
 *
 * Sources:
 *  - vendor_applications (2026 applicants)
 *  - site_events where event_type LIKE 'ticket_buyer_archive_%' (2023-2025 buyers, full archive)
 *  - ticket_buyers (current-year buyers synced from WC)
 *  - site_events where event_type='apply_email_captured' (drop-offs)
 *
 * Returns a single flat list. Each row carries a `source` label + `year`
 * so the UI can filter. Dedup by email (first seen wins).
 */

export interface Contact {
  email: string
  name: string | null
  phone: string | null
  source: 'vendor_applicant' | 'ticket_buyer_archive' | 'ticket_buyer_2026' | 'captured_email'
  year: string
  created_at: string
  meta: Record<string, unknown>
}

async function requireAdmin(req: NextRequest) {
  void req
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  if (!adminUser) return null
  return user
}

export async function GET(request: NextRequest) {
  const user = await requireAdmin(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const scope = await laneScopeFor(user.email)
  const contacts: Contact[] = []

  // 1) 2026 vendor applicants
  const { data: vendors } = await db
    .from('vendor_applications')
    .select('id, email, contact_name, business_name, phone, created_at')
    .order('created_at', { ascending: false })
  for (const v of vendors || []) {
    if (!v.email) continue
    if (scope.blocks({ applicationId: v.id, email: v.email, phone: v.phone })) continue
    contacts.push({
      email: v.email.toLowerCase(),
      name: v.contact_name || v.business_name || null,
      phone: v.phone || null,
      source: 'vendor_applicant',
      year: '2026',
      created_at: v.created_at,
      meta: { business_name: v.business_name },
    })
  }

  // 2) Archived ticket buyers (2023-2025) from site_events
  // event_type pattern: ticket_buyer_archive_YYYY
  const { data: archived } = await db
    .from('site_events')
    .select('event_type, metadata, created_at')
    .like('event_type', 'ticket_buyer_archive_%')
    .order('created_at', { ascending: false })
  for (const e of archived || []) {
    const m = (e.metadata || {}) as Record<string, unknown>
    const email = (m.buyer_email as string | undefined)?.toLowerCase()
    if (!email) continue
    const year = (e.event_type as string).replace('ticket_buyer_archive_', '')
    const first = (m.buyer_first_name as string | undefined) || ''
    const last = (m.buyer_last_name as string | undefined) || ''
    const name = `${first} ${last}`.trim() || null
    contacts.push({
      email,
      name,
      phone: (m.buyer_phone as string | undefined) || null,
      source: 'ticket_buyer_archive',
      year,
      created_at: (m.date_created as string | undefined) || e.created_at,
      meta: {
        wc_order_id: m.wc_order_id,
        total: m.total,
        currency: m.currency,
        city: m.buyer_city,
        country: m.buyer_country,
        line_items: m.line_items,
      },
    })
  }

  // 3) Current-year ticket buyers (synced from WC, if any)
  const { data: tb } = await db
    .from('ticket_buyers')
    .select('email, name, phone, created_at')
    .order('created_at', { ascending: false })
  for (const t of tb || []) {
    if (!t.email) continue
    contacts.push({
      email: t.email.toLowerCase(),
      name: t.name || null,
      phone: t.phone || null,
      source: 'ticket_buyer_2026',
      year: '2026',
      created_at: t.created_at,
      meta: {},
    })
  }

  // 4) Captured email drop-offs (people who started applying but didn't finish)
  const { data: captured } = await db
    .from('site_events')
    .select('metadata, created_at')
    .eq('event_type', 'apply_email_captured')
    .order('created_at', { ascending: false })
  for (const e of captured || []) {
    const m = (e.metadata || {}) as Record<string, unknown>
    const email = (m.email as string | undefined)?.toLowerCase()
    if (!email) continue
    contacts.push({
      email,
      name: (m.name as string | undefined) || null,
      phone: null,
      source: 'captured_email',
      year: (e.created_at || '????').slice(0, 4),
      created_at: e.created_at,
      meta: { business: m.business },
    })
  }

  // Dedup by email + source (someone can be both a vendor applicant and a ticket buyer — keep both rows for that)
  // Within source, dedup by email keeping the most recent
  const seenKey = new Set<string>()
  const deduped: Contact[] = []
  for (const c of contacts.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))) {
    const k = `${c.source}|${c.email}`
    if (seenKey.has(k)) continue
    seenKey.add(k)
    deduped.push(c)
  }

  return NextResponse.json({
    contacts: deduped,
    total: deduped.length,
    by_source: deduped.reduce<Record<string, number>>((acc, c) => {
      acc[c.source] = (acc[c.source] || 0) + 1
      return acc
    }, {}),
    by_year: deduped.reduce<Record<string, number>>((acc, c) => {
      acc[c.year] = (acc[c.year] || 0) + 1
      return acc
    }, {}),
  })
}
