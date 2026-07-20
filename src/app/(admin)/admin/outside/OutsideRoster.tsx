'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Loader2, ChevronDown, ChevronRight, Tent, Truck, IceCream, Cookie,
  Check, CircleCheck, ExternalLink,
} from 'lucide-react'
import { AdminPage } from '@/components/admin/AdminPage'
import { KpiStrip } from '@/components/chrome/KpiStrip'
import { Kpi } from '@/components/chrome/Kpi'
import { StatusPill } from '@/components/chrome/StatusPill'

const ACCENT = '#cd2653'

interface Vendor {
  id: string
  business_name: string
  contact_name: string | null
  phone: string | null
  email: string | null
  tier: string | null
  tier_label: string
  zone: string
  status: string
  committed: boolean
  slot: number | null
  paid: boolean
  payment_status: string
  checkedIn: boolean
  checked_in_at: string | null
}

interface Zone {
  key: string
  label: string
  capacity: number
  committed: number
  pending: number
  over: boolean
  used: number
  placed: number
  checkedIn: number
  vendors: Vendor[]
}

interface RosterResponse {
  zones: Zone[]
}

const ZONE_ICON: Record<string, typeof Tent> = {
  bedouin: Tent,
  food_drink_truck: Truck,
  dessert_truck: IceCream,
  snack_truck: Cookie,
}

export default function OutsideRoster() {
  const router = useRouter()
  const [data, setData] = useState<RosterResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [slotDraft, setSlotDraft] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/outside')
      if (res.status === 401) { router.push('/admin/login'); return }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      toast.error(`Could not load roster: ${e instanceof Error ? e.message : 'error'}`)
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { load() }, [load])

  const post = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch('/api/admin/outside', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    return j
  }, [])

  const assignSlot = useCallback(async (v: Vendor) => {
    const raw = (slotDraft[v.id] ?? '').trim()
    const slot = raw === '' ? null : parseInt(raw, 10)
    if (raw !== '' && (!Number.isFinite(slot) || (slot as number) <= 0)) {
      toast.error('Enter a position number, or clear it to unassign.')
      return
    }
    setBusyId(v.id)
    try {
      await post({ action: 'assign-slot', applicationId: v.id, zone: v.zone, slot })
      toast.success(slot == null ? `Cleared ${v.business_name}'s position` : `${v.business_name} → #${slot}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Assign failed')
    } finally {
      setBusyId(null)
    }
  }, [slotDraft, post, load])

  const toggleCheckIn = useCallback(async (v: Vendor) => {
    setBusyId(v.id)
    try {
      await post({ action: 'check-in', applicationId: v.id, checkedIn: !v.checkedIn })
      toast.success(v.checkedIn ? `Undid check-in for ${v.business_name}` : `Checked in ${v.business_name}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check-in failed')
    } finally {
      setBusyId(null)
    }
  }, [post, load])

  const totals = useMemo(() => {
    const zones = data?.zones ?? []
    return {
      committed: zones.reduce((s, z) => s + z.committed, 0),
      pending: zones.reduce((s, z) => s + z.pending, 0),
      capacity: zones.reduce((s, z) => s + z.capacity, 0),
      placed: zones.reduce((s, z) => s + z.placed, 0),
      checkedIn: zones.reduce((s, z) => s + z.checkedIn, 0),
    }
  }, [data])

  if (loading && !data) {
    return (
      <AdminPage title="Outside Vendors" caption="ROSTER">
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
        </div>
      </AdminPage>
    )
  }

  const zones = data?.zones ?? []

  return (
    <AdminPage
      title="Outside Vendors"
      caption="ROSTER"
      subtitle="Bedouin and food, dessert and snack trucks outside the marquee. No floor-plan stall, position number assigned on setup day."
    >
      <KpiStrip>
        <Kpi label="Committed" value={`${totals.committed}/${totals.capacity}`} hint="approved / capacity" />
        <Kpi label="Waiting" value={totals.pending} hint="pending pipeline" />
        <Kpi label="Positioned" value={totals.placed} hint="have a number" />
        <Kpi label="Checked in" value={totals.checkedIn} />
      </KpiStrip>

      <div className="mt-6 space-y-3">
        {zones.map((z) => {
          const Icon = ZONE_ICON[z.key] || Tent
          const isOpen = open[z.key] ?? false
          const pct = z.capacity > 0 ? Math.min(100, (z.committed / z.capacity) * 100) : 0
          return (
            <div key={z.key} className="rounded-lg border border-neutral-200 bg-white overflow-hidden">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [z.key]: !isOpen }))}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-neutral-50 transition-colors text-left"
              >
                {isOpen ? <ChevronDown className="w-4 h-4 text-neutral-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-neutral-400 shrink-0" />}
                <Icon className="w-4 h-4 shrink-0" style={{ color: ACCENT }} />
                <span className="text-sm font-semibold text-neutral-900 min-w-0 truncate">{z.label}</span>
                <span className="ml-auto flex items-center gap-3 shrink-0">
                  <span className="text-xs tabular-nums font-medium text-neutral-600">
                    {z.committed}/{z.capacity} <span className="text-neutral-400">committed</span>
                    {z.pending > 0 && (
                      <span className="text-amber-600"> · {z.pending} waiting</span>
                    )}
                  </span>
                  <span className="hidden sm:flex w-40 h-2 rounded-full bg-neutral-100 overflow-hidden">
                    <span
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: z.over ? '#dc2626' : z.committed === z.capacity ? '#d97706' : ACCENT }}
                    />
                  </span>
                  {z.over && <StatusPill tone="danger" label="Over" />}
                </span>
              </button>

              {isOpen && (() => {
                const committedVendors = z.vendors.filter((v) => v.committed)
                const waitingVendors = z.vendors.filter((v) => !v.committed)
                return (
                <div className="border-t border-neutral-100">
                  {z.vendors.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-neutral-400">No vendors in this zone yet.</div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wider text-neutral-400 border-b border-neutral-100">
                          <th className="text-left font-semibold px-4 py-2">Vendor</th>
                          <th className="text-left font-semibold px-3 py-2">Paid</th>
                          <th className="text-left font-semibold px-3 py-2 w-44">Position #</th>
                          <th className="text-left font-semibold px-3 py-2 w-36">Check-in</th>
                        </tr>
                      </thead>
                      {/* Committed (approved) vendors fill the spots: position + check-in live here. */}
                      {committedVendors.length > 0 && (
                      <tbody className="divide-y divide-neutral-50">
                        {committedVendors.map((v) => {
                          const draft = slotDraft[v.id] ?? (v.slot != null ? String(v.slot) : '')
                          const busy = busyId === v.id
                          return (
                            <tr key={v.id} className="hover:bg-neutral-50/60">
                              <td className="px-4 py-2.5">
                                <Link href={`/admin/vendors/${v.id}`} className="font-medium hover:underline" style={{ color: ACCENT }}>
                                  {v.business_name}
                                </Link>
                                <div className="text-[11px] text-neutral-400 truncate">
                                  {v.tier_label}{v.contact_name ? ` · ${v.contact_name}` : ''}
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <StatusPill
                                  tone={v.paid ? 'success' : v.payment_status === 'pending' ? 'warn' : 'neutral'}
                                  label={v.paid ? 'Paid' : v.payment_status === 'pending' ? 'Pending' : 'Not paid'}
                                />
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-neutral-300 text-sm">#</span>
                                  <input
                                    type="number"
                                    min={1}
                                    max={z.capacity}
                                    value={draft}
                                    onChange={(e) => setSlotDraft((d) => ({ ...d, [v.id]: e.target.value }))}
                                    onKeyDown={(e) => { if (e.key === 'Enter') assignSlot(v) }}
                                    placeholder="—"
                                    className="w-16 px-2 py-1 text-sm rounded-md border border-neutral-200 bg-white tabular-nums focus:outline-none focus:ring-2 focus:ring-[#cd2653]/40"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => assignSlot(v)}
                                    disabled={busy}
                                    className="inline-flex items-center justify-center px-2.5 py-1 text-xs font-medium rounded-md border border-[#cd2653]/30 text-[#cd2653] hover:bg-[#cd2653]/5 disabled:opacity-50"
                                  >
                                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Set'}
                                  </button>
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <button
                                  type="button"
                                  onClick={() => toggleCheckIn(v)}
                                  disabled={busy}
                                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
                                    v.checkedIn
                                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                      : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                                  }`}
                                >
                                  {v.checkedIn ? <CircleCheck className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                                  {v.checkedIn ? 'In' : 'Check in'}
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      )}
                      {/* Waiting list: pending / info_requested vendors with no spot yet.
                          No position number, no check-in until they're approved. */}
                      {waitingVendors.length > 0 && (
                      <tbody className="divide-y divide-neutral-50">
                        <tr className="bg-amber-50/40">
                          <td colSpan={4} className="px-4 py-1.5 text-[11px] uppercase tracking-wider font-semibold text-amber-700">
                            Waiting list · {waitingVendors.length} not yet approved
                          </td>
                        </tr>
                        {waitingVendors.map((v) => (
                          <tr key={v.id} className="hover:bg-neutral-50/60 text-neutral-500">
                            <td className="px-4 py-2.5">
                              <Link href={`/admin/vendors/${v.id}`} className="font-medium hover:underline text-neutral-600">
                                {v.business_name}
                              </Link>
                              <div className="text-[11px] text-neutral-400 truncate">
                                {v.tier_label}{v.contact_name ? ` · ${v.contact_name}` : ''}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <StatusPill
                                tone={v.paid ? 'success' : v.payment_status === 'pending' ? 'warn' : 'neutral'}
                                label={v.paid ? 'Paid' : v.payment_status === 'pending' ? 'Pending' : 'Not paid'}
                              />
                            </td>
                            <td className="px-3 py-2.5">
                              <StatusPill
                                tone="warn"
                                label={v.status === 'info_requested' ? 'Info requested' : 'Awaiting approval'}
                              />
                            </td>
                            <td className="px-3 py-2.5 text-[11px] text-neutral-400">
                              Approve to position
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      )}
                    </table>
                  )}
                </div>
                )
              })()}
            </div>
          )
        })}
      </div>

      <p className="mt-6 text-[11px] text-neutral-400 flex items-center gap-1.5">
        <ExternalLink className="w-3 h-3" />
        Payments are captured under Finance. This roster reads paid status, it does not take payment.
      </p>
    </AdminPage>
  )
}
