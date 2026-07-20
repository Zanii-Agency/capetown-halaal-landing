import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getRole } from '@/lib/admin-rbac'

// Activity feed for the operator dashboard.
// UNIONS two audit streams so operators see "everything that happened":
//   1. site_events            - analytics, WhatsApp, guards, crons,
//                               contract-sign, doc-upload (front-of-house).
//   2. vendor_application_events - admin vendor-lifecycle: approve / reject /
//                               info-requested, mark-paid, doc decisions,
//                               stall changes, amend, merge, etc.
// Both streams are normalized into the SAME item shape, merged, sorted by
// timestamp desc, and the existing limit/category filters are applied across
// the merged set. Display names are joined from vendor_applications.
// Filters are server-side via ?category=, defaulting to "all".

export const dynamic = 'force-dynamic'

type EventCategory = 'all' | 'approvals' | 'messages' | 'documents' | 'payments' | 'mass_send'

// Prefix-matched (Postgres ILIKE) categories for SITE_EVENTS. Each category
// lists one or more prefixes to match the event_type against. Covers both the
// documented prefix scheme (vendor_application_*, wa_*, mail_*, vendor_doc_*,
// payment_*, broadcast_*) AND the existing emitted event types (application_*,
// chat_*, inbox_*, mass_*, etc.) so the feed renders real data in production.
const CATEGORY_PREFIXES: Record<Exclude<EventCategory, 'all'>, string[]> = {
  approvals:  ['vendor_application_', 'application_', 'contract_signed', 'apply_'],
  messages:   ['wa_', 'mail_', 'chat_', 'inbox_', 'vendor_portal_reply', 'bot_reply'],
  documents:  ['vendor_doc_', 'document_'],
  payments:   ['payment_', 'checkout_'],
  mass_send:  ['broadcast_', 'mass_', 'verification_blast'],
}

// Exact-match categories for VENDOR_APPLICATION_EVENTS. These event_type values
// are discrete enums (not prefixed), so we map each to its category explicitly.
// Anything not listed here falls into the "approvals" bucket (lifecycle) by
// default, since this table is overwhelmingly admin lifecycle actions.
const VENDOR_EVENT_CATEGORY: Record<string, Exclude<EventCategory, 'all'>> = {
  // approvals / lifecycle
  approved: 'approvals',
  rejected: 'approvals',
  info_requested: 'approvals',
  tagged: 'approvals',
  snoozed: 'approvals',
  superseded: 'approvals',
  merged_into: 'approvals',
  vendor_amended: 'approvals',
  contract_resend: 'approvals',
  stall_change_requested: 'approvals',
  staff_badge_resent: 'approvals',
  staff_badge_revoked: 'approvals',
  csv_export: 'approvals',
  // messages
  chase_email: 'messages',
  chase_whatsapp: 'messages',
  vendor_portal_reply: 'messages',
  // documents
  vendor_doc_uploaded: 'documents',
  // payments
  payment_captured: 'payments',
  payment_manual: 'payments',
}

function vendorEventCategory(eventType: string): Exclude<EventCategory, 'all'> {
  return VENDOR_EVENT_CATEGORY[eventType] ?? 'approvals'
}

// Which vendor_application_events.event_type values belong to a given feed
// category. Used to filter that stream at query time so the merged result
// honors ?category= the same way site_events does.
function vendorEventTypesForCategory(category: Exclude<EventCategory, 'all'>): string[] {
  return Object.entries(VENDOR_EVENT_CATEGORY)
    .filter(([, cat]) => cat === category)
    .map(([type]) => type)
}

function isCategory(v: string | null): v is EventCategory {
  return v === 'all' || (!!v && Object.prototype.hasOwnProperty.call(CATEGORY_PREFIXES, v))
}

interface SiteEventRow {
  id: string
  created_at: string
  event_type: string
  path: string | null
  metadata: Record<string, unknown> | null
  session_id: string
}

interface VendorApplicationEventRow {
  id: string
  application_id: string | null
  event_type: string
  before_value: Record<string, unknown> | null
  after_value: Record<string, unknown> | null
  actor_email: string | null
  actor_role: string | null
  note: string | null
  created_at: string
}

interface VendorLite {
  id: string
  business_name: string
  contact_name: string
}

// The unified item shape the client already renders. Both streams normalize
// into this. `source` is additive metadata (not relied on by the existing
// client), letting the UI distinguish streams if it wants to.
interface ActivityItem {
  id: string
  created_at: string
  event_type: string
  actor: string
  path: string | null
  vendor_id: string | null
  vendor_name: string | null
  contact_name: string | null
  metadata: Record<string, unknown>
  source: 'site_events' | 'vendor_application_events'
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const role = await getRole(user.id)
    if (!role) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const rawCategory = searchParams.get('category')
    const category: EventCategory = isCategory(rawCategory) ? rawCategory : 'all'
    const limitParam = parseInt(searchParams.get('limit') || '30', 10)
    const limit = Math.max(1, Math.min(100, isNaN(limitParam) ? 30 : limitParam))

    const admin = createAdminClient()

    // --- Stream 1: site_events -------------------------------------------
    // Over-fetch `limit` rows so the cross-stream merge below doesn't starve
    // one stream when the other has more recent rows. We slice to `limit`
    // after merging.
    let siteQuery = admin
      .from('site_events')
      .select('id, created_at, event_type, path, metadata, session_id')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (category !== 'all') {
      const prefixes = CATEGORY_PREFIXES[category]
      // PostgREST `or` with comma-separated ilike filters: prefix matching.
      const orExpr = prefixes
        .map(p => `event_type.ilike.${p}%`)
        .join(',')
      siteQuery = siteQuery.or(orExpr)
    }

    // --- Stream 2: vendor_application_events -----------------------------
    // Admin vendor-lifecycle audit log. When filtering by category, restrict
    // to the event_type enums that map to that category. If a category has no
    // vendor-event types (none today, but future-proof), skip the query.
    let vendorEventsPromise: Promise<{ data: VendorApplicationEventRow[] | null }> =
      Promise.resolve({ data: [] })

    const runVendorEvents = category === 'all'
      ? true
      : vendorEventTypesForCategory(category).length > 0

    if (runVendorEvents) {
      let vendorQuery = admin
        .from('vendor_application_events')
        .select('id, application_id, event_type, before_value, after_value, actor_email, actor_role, note, created_at')
        .order('created_at', { ascending: false })
        .limit(limit)

      if (category !== 'all') {
        vendorQuery = vendorQuery.in('event_type', vendorEventTypesForCategory(category))
      }
      vendorEventsPromise = Promise.resolve(
        vendorQuery.then(({ data }) => ({
          data: (data ?? null) as VendorApplicationEventRow[] | null,
        })),
      )
    }

    const [siteResult, vendorResult] = await Promise.all([
      siteQuery,
      vendorEventsPromise,
    ])

    if (siteResult.error) {
      console.error('[activity] site_events query failed:', siteResult.error)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    const siteRows = (siteResult.data ?? []) as SiteEventRow[]
    const vendorRows = (vendorResult.data ?? []) as VendorApplicationEventRow[]

    // --- Resolve vendor display names across BOTH streams ----------------
    const vendorIds = new Set<string>()
    for (const ev of siteRows) {
      const meta = ev.metadata ?? {}
      const id = (meta as { vendor_id?: unknown; application_id?: unknown }).vendor_id
        ?? (meta as { application_id?: unknown }).application_id
      if (typeof id === 'string' && id.length > 0) vendorIds.add(id)
    }
    for (const ev of vendorRows) {
      if (ev.application_id && ev.application_id.length > 0) vendorIds.add(ev.application_id)
    }

    let vendorMap: Record<string, VendorLite> = {}
    if (vendorIds.size > 0) {
      const { data: vendors } = await admin
        .from('vendor_applications')
        .select('id, business_name, contact_name')
        .in('id', Array.from(vendorIds))
      vendorMap = Object.fromEntries(
        ((vendors ?? []) as VendorLite[]).map(v => [v.id, v])
      )
    }

    // --- Normalize site_events into the unified item shape ---------------
    const siteItems: ActivityItem[] = siteRows.map(ev => {
      const meta = (ev.metadata ?? {}) as Record<string, unknown>
      const vendorId = typeof meta.vendor_id === 'string'
        ? meta.vendor_id
        : (typeof meta.application_id === 'string' ? meta.application_id : null)
      const vendor = vendorId ? vendorMap[vendorId] ?? null : null
      const actor = typeof meta.actor === 'string' ? meta.actor
        : (typeof meta.actor_email === 'string' ? meta.actor_email
          : (typeof meta.email === 'string' ? meta.email : 'system'))

      return {
        id: `se:${ev.id}`,
        created_at: ev.created_at,
        event_type: ev.event_type,
        actor,
        path: ev.path,
        vendor_id: vendorId,
        vendor_name: vendor?.business_name ?? null,
        contact_name: vendor?.contact_name ?? null,
        metadata: meta,
        source: 'site_events',
      }
    })

    // --- Normalize vendor_application_events into the same shape ---------
    const vendorItems: ActivityItem[] = vendorRows.map(ev => {
      const vendor = ev.application_id ? vendorMap[ev.application_id] ?? null : null
      // Keep the rich diff + note in metadata so the renderer can surface it,
      // mirroring the site_events `metadata` contract.
      const metadata: Record<string, unknown> = {
        category: vendorEventCategory(ev.event_type),
        actor_email: ev.actor_email,
        actor_role: ev.actor_role,
        note: ev.note,
        before_value: ev.before_value,
        after_value: ev.after_value,
        application_id: ev.application_id,
      }

      return {
        id: `vae:${ev.id}`,
        created_at: ev.created_at,
        event_type: ev.event_type,
        actor: ev.actor_email ?? ev.actor_role ?? 'system',
        path: ev.application_id ? `/admin/applications?id=${ev.application_id}` : null,
        vendor_id: ev.application_id,
        vendor_name: vendor?.business_name ?? null,
        contact_name: vendor?.contact_name ?? null,
        metadata,
        source: 'vendor_application_events',
      }
    })

    // --- Merge, dedupe, sort desc, apply limit ---------------------------
    // IDs are prefixed per-table (se: / vae:) so they never collide. Lifecycle
    // actions write ONLY to vendor_application_events (verified: bulk/action/
    // decision-notify never touch site_events), so true cross-stream dupes
    // don't occur. The prefixed-id Map is a belt-and-braces guard regardless.
    const merged = new Map<string, ActivityItem>()
    for (const item of [...siteItems, ...vendorItems]) {
      if (!merged.has(item.id)) merged.set(item.id, item)
    }

    const items = Array.from(merged.values())
      .sort((a, b) => {
        const ta = Date.parse(a.created_at)
        const tb = Date.parse(b.created_at)
        if (tb !== ta) return tb - ta
        // Stable tiebreak on id for deterministic ordering on equal timestamps.
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })
      .slice(0, limit)

    return NextResponse.json({ items, category, limit })
  } catch (err) {
    console.error('[activity] unexpected:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
