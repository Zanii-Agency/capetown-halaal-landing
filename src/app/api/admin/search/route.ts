/**
 * Cmd+K global search across the admin portal.
 *
 * GET /api/admin/search?q=<query>
 *   - Returns up to 6 hits per group (vendors, buyers, wa_threads, support_threads).
 *   - Min 2 chars; shorter returns empty.
 *   - Phone-shaped query (^\+?\d{6,}$) is normalised to last-9 and routed to
 *     phone-only matching against the functional index
 *     idx_vendor_apps_phone_last9 = regexp_replace(phone,'\D','','g'), which
 *     lets `LIKE '%<last9>'` ride the index without a sequential scan.
 *   - Auth: same shape as /api/admin/applications/route.ts — cookie session +
 *     admin_users membership check via the service-role admin client.
 *   - All four queries run in parallel via Promise.all. WooCommerce is hit
 *     directly with `?search=<q>` and a `after=` festival-cycle filter, then
 *     trimmed to 6 rows.
 *
 * Response shape:
 *   {
 *     vendors:         [{ id, business_name, contact_name, phone, status, sector, link }],
 *     buyers:          [{ id, name, email, phone, total, status, link }],
 *     wa_threads:      [{ id, thread_key, channel, last_inbound_at, link }],
 *     support_threads: [{ id, peer_email, peer_name, subject, last_inbound_at, link }],
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizePhone } from '@/lib/phone/normalize'
import { getOrders, type WCOrder } from '@/lib/woocommerce'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PER_GROUP = 6

interface VendorHit {
  id: string
  business_name: string | null
  contact_name: string | null
  phone: string | null
  status: string | null
  sector: string | null
  link: string
}

interface BuyerHit {
  id: string
  name: string
  email: string | null
  phone: string | null
  total: string | null
  status: string | null
  link: string
}

interface WaThreadHit {
  id: string
  thread_key: string
  channel: 'wa' | 'mail'
  last_inbound_at: string | null
  link: string
}

interface SupportThreadHit {
  id: string
  peer_email: string | null
  peer_name: string | null
  subject: string | null
  last_inbound_at: string | null
  link: string
}

// Escape user input before embedding in a Postgres ILIKE pattern.
function ilikeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

const UUID_FRAGMENT_RE = /^[0-9a-f]{8,}$/i

export async function GET(req: NextRequest) {
  try {
    // --- Auth: same pattern as /api/admin/applications/route.ts:24-36 ---
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = createAdminClient()
    const { data: adminUser } = await admin
      .from('admin_users')
      .select('id')
      .eq('id', user.id)
      .single()
    if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
    if (q.length < 2) {
      return NextResponse.json({
        vendors: [],
        buyers: [],
        wa_threads: [],
        support_threads: [],
      })
    }

    // Phone-shape detection. If the query is all digits (optionally prefixed
    // with +), search phone fields ONLY against the last-9 functional index.
    const phoneLike = /^\+?\d{6,}$/.test(q)
    const last9 = phoneLike ? (normalizePhone(q).ok ? normalizePhone(q) : null) : null
    const last9Str = last9 && last9.ok ? last9.last9 : null
    const safe = ilikeEscape(q)
    const pattern = `%${safe}%`

    // ------------------------------------------------------------------
    // Query 1: vendor_applications
    //   - Phone-shape: regexp_replace(phone,'\D','','g') LIKE '%<last9>'
    //     so the functional index idx_vendor_apps_phone_last9 fires.
    //   - UUID-fragment: match id as well for app-id lookups.
    //   - Otherwise ILIKE across business_name, contact_name, email, phone.
    //   - Also searches stall codes embedded in admin_notes (⟦STALL:code⟧).
    //   - Approved rows first (so live vendors beat stale pending dupes),
    //     then newest first.
    // ------------------------------------------------------------------
    const vendorsP = (async (): Promise<VendorHit[]> => {
      let qry = admin
        .from('vendor_applications')
        .select('id, business_name, contact_name, phone, status, sector, created_at, admin_notes')

      if (last9Str) {
        // Functional-index match: digits-only suffix.
        qry = qry.like('phone', `%${last9Str.slice(-9)}%`)
      } else {
        // Build dynamic OR clauses. Start with the main fields.
        const orParts = [
          `business_name.ilike.${pattern}`,
          `contact_name.ilike.${pattern}`,
          `email.ilike.${pattern}`,
          `phone.ilike.${pattern}`,
          // Multi-booth: a code can be first after the prefix OR mid-list after a
          // comma (⟦STALL:FS1,FS2⟧). Match both so any booth in a vendor's list
          // is findable by code.
          `admin_notes.ilike.%⟦STALL:${safe}%`,
          `admin_notes.ilike.%,${safe}%`,
        ]
        // If query is UUID-shaped, add id match
        if (UUID_FRAGMENT_RE.test(safe)) {
          orParts.push(`id.ilike.${pattern}`)
        }
        qry = qry.or(orParts.join(','))
      }

      const { data, error } = await qry
        .order('status', { ascending: true }) // 'approved' < 'pending' alphabetically; we re-sort below
        .order('created_at', { ascending: false })
        .limit(PER_GROUP * 3) // overfetch so we can re-prioritise approved

      if (error) {
        console.error('[admin/search] vendors error:', error)
        return []
      }

      const rows = (data ?? []) as Array<{
        id: string
        business_name: string | null
        contact_name: string | null
        phone: string | null
        status: string | null
        sector: string | null
        admin_notes: string | null
      }>

      // Approved-first sort.
      const approved = rows.filter((r) => r.status === 'approved')
      const others = rows.filter((r) => r.status !== 'approved')
      const sorted = [...approved, ...others].slice(0, PER_GROUP)

      return sorted.map((r) => ({
        id: r.id,
        business_name: r.business_name,
        contact_name: r.contact_name,
        phone: r.phone,
        status: r.status,
        sector: r.sector,
        link: `/admin/vendors/${r.id}`,
      }))
    })()

    // ------------------------------------------------------------------
    // Query 2: ticket buyers (WooCommerce orders are the source of truth,
    // see CTH-DOCTRINE law 4). Pass-through `q` to WC's ?search= which
    // matches across billing email, name, and order number. Festival
    // cycle filter is enforced by getOrders() (law 6).
    //
    // If the query is phone-shaped, WC's search doesn't reliably match
    // phone fields, so we fall back to a digit-suffix scan of completed
    // orders' billing.phone after the WC fetch.
    // ------------------------------------------------------------------
    const buyersP = (async (): Promise<BuyerHit[]> => {
      try {
        if (last9Str) {
          // Phone-shape: WC search is unreliable on phone, so fetch
          // recent completed/processing orders and filter client-side
          // by digits-only suffix. getOrders already paginates + caps.
          const orders = await getOrders({ status: 'completed,processing,on-hold' })
          const matched = orders
            .filter((o: WCOrder) => {
              const digits = (o.billing?.phone ?? '').replace(/\D/g, '')
              return digits.endsWith(last9Str.slice(-9))
            })
            .slice(0, PER_GROUP)
          return matched.map(orderToBuyer)
        }
        const orders = await getOrders({ search: q, per_page: String(PER_GROUP) })
        return orders.slice(0, PER_GROUP).map(orderToBuyer)
      } catch (err) {
        console.error('[admin/search] buyers WC error:', err)
        return []
      }
    })()

    // ------------------------------------------------------------------
    // Query 3: wa_threads
    //   - thread_key holds the phone for channel='wa' (E.164 incl. '+').
    //   - Phone-shape query: suffix-match against last-9.
    //   - Text query: ILIKE thread_key (catches partial emails on
    //     mail-channel threads too — see wa_threads schema notes,
    //     supabase-migration-v11-wa-threads.sql:7).
    //   - Ordered last_inbound_at DESC.
    // ------------------------------------------------------------------
    const waThreadsP = (async (): Promise<WaThreadHit[]> => {
      let qry = admin
        .from('wa_threads')
        .select('id, thread_key, channel, last_inbound_at')
        .order('last_inbound_at', { ascending: false, nullsFirst: false })
        .limit(PER_GROUP)

      if (last9Str) {
        qry = qry.eq('channel', 'wa').like('thread_key', `%${last9Str.slice(-9)}%`)
      } else {
        qry = qry.ilike('thread_key', pattern)
      }

      const { data, error } = await qry
      if (error) {
        console.error('[admin/search] wa_threads error:', error)
        return []
      }
      return (data ?? []).map((r) => ({
        id: r.id as string,
        thread_key: r.thread_key as string,
        channel: r.channel as 'wa' | 'mail',
        last_inbound_at: (r.last_inbound_at as string | null) ?? null,
        link: `/admin/customer-inbox`,
      }))
    })()

    // ------------------------------------------------------------------
    // Query 4: support_inbox_threads
    //   - ILIKE peer_email + subject (peer_name added for searchability).
    //   - Phone-shape queries don't apply here (mail only).
    //   - Ordered last_inbound_at DESC.
    // ------------------------------------------------------------------
    const supportThreadsP = (async (): Promise<SupportThreadHit[]> => {
      if (last9Str) return [] // no phone field on support_inbox_threads

      const { data, error } = await admin
        .from('support_inbox_threads')
        .select('id, peer_email, peer_name, subject, last_inbound_at')
        .or(
          `peer_email.ilike.${pattern},peer_name.ilike.${pattern},subject.ilike.${pattern}`
        )
        .order('last_inbound_at', { ascending: false, nullsFirst: false })
        .limit(PER_GROUP)

      if (error) {
        console.error('[admin/search] support_threads error:', error)
        return []
      }
      return (data ?? []).map((r) => ({
        id: r.id as string,
        peer_email: (r.peer_email as string | null) ?? null,
        peer_name: (r.peer_name as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        last_inbound_at: (r.last_inbound_at as string | null) ?? null,
        // Support inbox is a single SPA, no per-thread route. Land there
        // with ?thread=<id> so the client can deep-link to the row.
        link: `/admin/support-inbox?thread=${r.id}`,
      }))
    })()

    const [vendors, buyers, wa_threads, support_threads] = await Promise.all([
      vendorsP,
      buyersP,
      waThreadsP,
      supportThreadsP,
    ])

    return NextResponse.json({ vendors, buyers, wa_threads, support_threads })
  } catch (err) {
    console.error('[admin/search] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

function orderToBuyer(o: WCOrder): BuyerHit {
  const first = o.billing?.first_name ?? ''
  const last = o.billing?.last_name ?? ''
  const name = `${first} ${last}`.trim() || (o.billing?.email ?? 'Unknown')
  return {
    id: String(o.id),
    name,
    email: o.billing?.email ?? null,
    phone: o.billing?.phone ?? null,
    total: o.total ?? null,
    status: o.status ?? null,
    // No per-buyer detail route exists. Land on /admin/tickets with the
    // order id as a hash so the page can scroll/highlight.
    link: `/admin/tickets#order-${o.id}`,
  }
}
