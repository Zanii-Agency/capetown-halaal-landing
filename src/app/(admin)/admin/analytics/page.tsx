import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { getOrders } from '@/lib/woocommerce'
import { PageShell, PageHeader, Card, Pill, StatCard } from '@/components/chrome/PageChrome'
import WebTrafficDashboard from './WebTrafficDashboard'

export const dynamic = 'force-dynamic'

// CTH-DOCTRINE alignment:
//  - Law 2 (vendor PII): admin auth gate at the layout + this server component
//    re-checks the admin_users membership. All reads use the service-role
//    admin client. The page never ships to anon.
//  - Law 4 (ticket source-of-truth): ticket counts + revenue come from
//    getOrders() at request time, no duplicated counter table.
//  - Law 6 (date-filter): getOrders() prepends FESTIVAL_CYCLE_AFTER to every
//    call internally, so all WC reads here are cycle-scoped.
//  - Law 7 (no em-dashes): copy uses commas and periods only.

interface RecentEvent {
  id: string
  event_type: string
  actor_email: string | null
  actor_role: string | null
  note: string | null
  created_at: string
  business_name: string | null
}

function fmtZAR(amount: number) {
  return 'R' + amount.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-ZA', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function eventTone(type: string): 'neutral' | 'success' | 'warn' | 'danger' | 'brand' {
  if (type === 'approved' || type === 'paid' || type === 'docs_complete' || type === 'contract_signed') return 'success'
  if (type === 'rejected' || type === 'superseded') return 'danger'
  if (type === 'info_requested' || type === 'tagged' || type === 'stall_allocated') return 'warn'
  if (type === 'merged') return 'brand'
  return 'neutral'
}

export default async function AnalyticsPage() {
  // -------- auth gate (server, redirects to /admin/login on miss) --------
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) redirect('/admin/login')

  // -------- all-time KPI + 30-day windows --------
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // Ticket Sales card = all-time / year-to-date revenue, not just the festival
  // cycle. Law 6 requires every orders.list to carry `after=`, so we scope to
  // the START OF THE CURRENT YEAR (YTD) rather than removing the filter.
  // Format matches getOrders' WC `after` param (local-naive ISO, no Z).
  const ytdAfter = `${now.getUTCFullYear()}-01-01T00:00:00`

  // 1) Vendor applications: count all-time + 30d + status breakdown.
  // 2) WhatsApp messages: in + out counts, all-time + 30d.
  // 3) Support threads: open / snoozed / resolved + 30d new.
  // 4) Ticket sales: getOrders() carries the `after=` filter (Law 6); we pass
  //    an explicit YTD `after` (start of current year) so the card reads
  //    all-time year-to-date revenue, not just the festival cycle.
  //    status=completed for revenue + count.
  // 5) Recent activity: last 20 rows from vendor_application_events joined to
  //    vendor_applications.business_name for display context.
  const [
    vaAllTime,
    vaRecent,
    vaPending,
    vaApproved,
    vaRejected,
    waInAll, waOutAll, waInRecent, waOutRecent,
    stAllTime, stOpen, stSnoozed, stResolved, stRecent,
    orders,
    eventsRes,
  ] = await Promise.all([
    db.from('vendor_applications').select('id', { count: 'exact', head: true }),
    db.from('vendor_applications').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo),
    db.from('vendor_applications').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    db.from('vendor_applications').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    db.from('vendor_applications').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
    db.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'in'),
    db.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'out'),
    db.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'in').gte('created_at', thirtyDaysAgo),
    db.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'out').gte('created_at', thirtyDaysAgo),
    db.from('support_inbox_threads').select('id', { count: 'exact', head: true }),
    db.from('support_inbox_threads').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    db.from('support_inbox_threads').select('id', { count: 'exact', head: true }).eq('status', 'snoozed'),
    db.from('support_inbox_threads').select('id', { count: 'exact', head: true }).eq('status', 'resolved'),
    db.from('support_inbox_threads').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo),
    getOrders({ status: 'completed', after: ytdAfter }).catch((e) => {
      console.warn('[analytics] WC fetch failed:', e instanceof Error ? e.message : e)
      return [] as Awaited<ReturnType<typeof getOrders>>
    }),
    db.from('vendor_application_events')
      .select('id, application_id, event_type, actor_email, actor_role, note, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  // Join activity rows to vendor business_name in a second pass. Two queries
  // beats a nested select that requires a Supabase FK relationship name.
  const eventRows = eventsRes.data || []
  const appIds = Array.from(new Set(eventRows.map((e) => e.application_id).filter(Boolean)))
  let nameById: Record<string, string> = {}
  if (appIds.length > 0) {
    const { data: apps } = await db
      .from('vendor_applications')
      .select('id, business_name')
      .in('id', appIds)
    nameById = (apps || []).reduce((acc: Record<string, string>, a: { id: string; business_name: string | null }) => {
      acc[a.id] = a.business_name || '(unknown vendor)'
      return acc
    }, {})
  }
  const recentActivity: RecentEvent[] = eventRows.map((e) => ({
    id: e.id,
    event_type: e.event_type,
    actor_email: e.actor_email,
    actor_role: e.actor_role,
    note: e.note,
    created_at: e.created_at,
    business_name: nameById[e.application_id] || null,
  }))

  // Aggregate ticket sales from the WC orders payload.
  const ticketRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total || '0'), 0)
  const ticketCount = orders.reduce(
    (sum, o) => sum + o.line_items.reduce((s, item) => s + item.quantity, 0),
    0,
  )
  const orderCount = orders.length

  return (
    <PageShell>
      <PageHeader
        kicker="Analytics"
        title="All time view"
        subtitle="Festival cycle counters across applications, messaging, support, and tickets. Live read at page load."
        actions={<Pill tone="success">live</Pill>}
      />

      <div className="space-y-6">
        {/* ---------- 4 business KPI cards ---------- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Vendor applications"
            value={vaAllTime.count ?? 0}
            trend={vaRecent.count != null ? `+${vaRecent.count} 30d` : undefined}
            hint={
              <span>
                {vaPending.count ?? 0} pending, {vaApproved.count ?? 0} approved, {vaRejected.count ?? 0} rejected
              </span>
            }
          />
          <StatCard
            label="WhatsApp messages"
            value={(waInAll.count ?? 0) + (waOutAll.count ?? 0)}
            trend={
              waInRecent.count != null || waOutRecent.count != null
                ? `+${(waInRecent.count ?? 0) + (waOutRecent.count ?? 0)} 30d`
                : undefined
            }
            hint={
              <span>
                {waInAll.count ?? 0} inbound, {waOutAll.count ?? 0} outbound
              </span>
            }
          />
          <StatCard
            label="Support threads"
            value={stAllTime.count ?? 0}
            trend={stRecent.count != null ? `+${stRecent.count} 30d` : undefined}
            hint={
              <span>
                {stOpen.count ?? 0} open, {stSnoozed.count ?? 0} snoozed, {stResolved.count ?? 0} resolved
              </span>
            }
          />
          <StatCard
            label="Ticket sales (YTD)"
            value={fmtZAR(ticketRevenue)}
            trend={`${ticketCount} tix`}
            hint={
              <span>
                {orderCount} completed orders, year to date (since {now.getUTCFullYear()}-01-01)
              </span>
            }
          />
        </div>

        {/* ---------- Recent activity ---------- */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-serif text-lg text-[#1B1A17]">Recent vendor activity</h2>
            <span className="text-[11px] uppercase tracking-[0.14em] text-[#1B1A17]/55">
              Last {recentActivity.length} events
            </span>
          </div>
          {recentActivity.length === 0 ? (
            <p className="text-sm text-[#1B1A17]/55">
              No vendor lifecycle events yet. Approvals, payments, and stall allocations will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-[#E5E5E5]/30">
              {recentActivity.map((ev) => (
                <li key={ev.id} className="flex items-start gap-3 py-2.5">
                  <div className="shrink-0 pt-0.5">
                    <Pill tone={eventTone(ev.event_type)}>{ev.event_type.replace(/_/g, ' ')}</Pill>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#1B1A17] truncate">
                      <span className="font-semibold">{ev.business_name || '(unknown vendor)'}</span>
                      {ev.note ? <span className="text-[#1B1A17]/70">, {ev.note}</span> : null}
                    </p>
                    <p className="text-[11px] text-[#1B1A17]/55 mt-0.5">
                      {ev.actor_email || 'system'}
                      {ev.actor_role ? `, ${ev.actor_role}` : ''} . {fmtDate(ev.created_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ---------- Existing web traffic dashboard preserved underneath ---------- */}
        <div>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="font-serif text-lg text-[#1B1A17]">Web traffic</h2>
            <Pill tone="neutral">last 30 days</Pill>
          </div>
          <WebTrafficDashboard />
        </div>
      </div>
    </PageShell>
  )
}
