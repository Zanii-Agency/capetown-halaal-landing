import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hiddenFromOwner } from '@/lib/audit-scope'
import { isEftAdmin, vendorInOwnerScope } from '@/lib/eft'

export const dynamic = 'force-dynamic'

type AuditRow = {
  id: string
  created_at: string
  event_type: string
  actor_email: string | null
  actor_role: string | null
  note: string | null
  application_id: string | null
  before_value?: unknown
  after_value?: unknown
}

// Pull the last 50 application events for the audit log placeholder. Sprint 2
// will join this against vendor_applications for vendor names + before/after
// diffs. For now the bare event table is enough to prove the trail is alive.
async function getRecentEvents(viewerEmail: string | null): Promise<{ rows: AuditRow[]; error: string | null }> {
  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('vendor_application_events')
      .select('id, created_at, event_type, actor_email, actor_role, note, application_id, before_value, after_value')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) return { rows: [], error: error.message }
    const rows = (data as AuditRow[]) || []
    if (isEftAdmin(viewerEmail)) return { rows, error: null }

    // For non-EFT admins, resolve each row's vendor and drop anything outside
    // the festival owner's scope or that describes the EFT arrangement.
    const appIds = Array.from(new Set(rows.map((r) => r.application_id).filter(Boolean)))
    let scopeById: Record<string, boolean> = {}
    if (appIds.length) {
      const { data: vendors } = await admin
        .from('vendor_applications')
        .select('id, admin_notes, paid_at')
        .in('id', appIds)
      ;(vendors || []).forEach((v: { id: string; admin_notes: string | null; paid_at: string | null }) => {
        scopeById[v.id] = vendorInOwnerScope(v.admin_notes, v.paid_at)
      })
    }
    const filtered = rows.filter((r) =>
      !hiddenFromOwner(
        {
          event_type: r.event_type,
          note: r.note,
          before_value: r.before_value,
          after_value: r.after_value,
        },
        r.application_id ? scopeById[r.application_id] : undefined,
      ),
    )
    return { rows: filtered, error: null }
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : 'unknown error' }
  }
}

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-ZA', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export default async function SettingsAuditPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) redirect('/admin/login')

  const { rows, error } = await getRecentEvents(user.email ?? null)

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto">
      <Link
        href="/admin/settings"
        className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 mb-4"
      >
        <ArrowLeft className="w-3 h-3" /> Back to Settings
      </Link>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900">Audit Log</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Last 50 events from vendor_application_events. Richer view (vendor names, diffs) lands next sprint.
        </p>
      </header>

      <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
        {error ? (
          <div className="p-6 text-sm text-neutral-500">
            Could not load events: {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-neutral-500">
            No events recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr className="text-left text-[11px] uppercase tracking-wider text-neutral-500">
                <th className="px-4 py-2.5 font-semibold">When</th>
                <th className="px-4 py-2.5 font-semibold">Event</th>
                <th className="px-4 py-2.5 font-semibold">Actor</th>
                <th className="px-4 py-2.5 font-semibold">Role</th>
                <th className="px-4 py-2.5 font-semibold">Application</th>
                <th className="px-4 py-2.5 font-semibold">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                  <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{fmtWhen(r.created_at)}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700 text-[11px] font-medium">
                      {r.event_type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-neutral-700">{r.actor_email ?? '—'}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{r.actor_role ?? '—'}</td>
                  <td className="px-4 py-2.5 text-neutral-500 font-mono text-[11px]">
                    {r.application_id ? `${r.application_id.slice(0, 8)}…` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-neutral-600 max-w-md truncate" title={r.note ?? ''}>
                    {r.note ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}
