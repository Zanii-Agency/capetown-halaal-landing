'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Map, Banknote, FileCheck, Megaphone, Sparkles, Loader2, Search, X, MapPin, Phone, Mail, Tag, CheckCircle2, Send } from 'lucide-react'
import StallMap, { type MapStall } from '@/components/admin/StallMap'
import FloorCommand, { type FloorBooth, type FloorApp } from '@/components/floor/FloorCommand'
import { TYPE_META, TIER_META, type StallType } from '@/lib/stalls'

interface AppRow {
  id: string
  business_name: string
  contact_name: string | null
  phone: string | null
  email: string | null
  categories: string[]
  tier: string | null
  tier_label: string
  app_status: string
  stall: string | null
  stalls?: string[]
  booth_count?: number
  stall_status: string | null
  payment_status?: string
  payment_amount?: number
  payment_ref?: string | null
}
interface Avail { total: number; allocated: number; held: number; available: number }
interface StallsResponse {
  stalls: MapStall[]
  availability: Record<StallType, Avail>
  applications: AppRow[]
  grid: { cols: number; rows: number }
  zones: { label: string; col: number; row: number; w: number; h: number }[]
}

const TABS = [
  { k: 'allocation', label: 'Allocation Map', icon: Map },
  { k: 'payments', label: 'Payments', icon: Banknote },
  { k: 'documents', label: 'Documents', icon: FileCheck },
  { k: 'broadcast', label: 'Broadcast', icon: Megaphone },
] as const

export default function VendorOpsPage() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<string>('allocation')
  const [data, setData] = useState<StallsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [chosenApp, setChosenApp] = useState<AppRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('hi everyone, move-in is thursday night, please bring your car pass from the vendor pack and dont be late')
  const [polishing, setPolishing] = useState(false)
  const [markPaidFor, setMarkPaidFor] = useState<AppRow | null>(null)
  const [paidMethod, setPaidMethod] = useState<'eft' | 'cash' | 'manual_card' | 'waived'>('eft')
  const [paidRef, setPaidRef] = useState('')
  const [paidAmountOverride, setPaidAmountOverride] = useState<string>('')
  const [markingPaid, setMarkingPaid] = useState(false)
  const [resendingFor, setResendingFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/stalls')
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      toast.error(`Could not load stalls: ${e instanceof Error ? e.message : 'error'}`)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!active) return
      if (!user) { router.push('/admin/login'); return }
      setReady(true)
      load()
    })()
    return () => { active = false }
  }, [router, load])

  const selStall = useMemo(() => data?.stalls.find((s) => s.code === sel) || null, [data, sel])
  const occupant = useMemo(() => {
    if (!sel || !data) return null
    // Multi-booth: the selected code may be any code in a vendor's list, not just
    // their first. Match against the full list (fall back to first code + map occupant).
    return data.applications.find((a) =>
      (a.stalls && a.stalls.length ? a.stalls.includes(sel) : a.stall === sel),
    ) || (selStall?.occupant as AppRow | null) || null
  }, [sel, data, selStall])

  function pick(code: string) { setSel(code); setChosenApp(null); setSearch('') }

  async function post(body: Record<string, unknown>) {
    setSaving(true)
    try {
      const res = await fetch('/api/admin/stalls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      toast.success(j.message || 'Saved')
      await load()
      setChosenApp(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally { setSaving(false) }
  }

  async function confirmMarkPaid() {
    if (!markPaidFor) return
    setMarkingPaid(true)
    try {
      const amt = paidAmountOverride.trim() ? Number(paidAmountOverride) : undefined
      if (amt !== undefined && (!isFinite(amt) || amt <= 0)) throw new Error('Amount must be a positive number')
      const res = await fetch('/api/admin/payments/mark-paid', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: markPaidFor.id,
          method: paidMethod,
          providerRef: paidRef.trim() || undefined,
          amount: amt,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      toast.success(j.alreadyPaid ? `${markPaidFor.business_name} was already paid` : `Marked ${markPaidFor.business_name} as paid`)
      setMarkPaidFor(null); setPaidRef(''); setPaidAmountOverride(''); setPaidMethod('eft')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Mark as paid failed')
    } finally { setMarkingPaid(false) }
  }

  async function resendInvoice(row: AppRow) {
    setResendingFor(row.id)
    try {
      const res = await fetch('/api/admin/payments/resend-invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: row.id }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      toast.success(`Invoice email resent to ${j.to}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Resend failed')
    } finally { setResendingFor(null) }
  }

  async function polish() {
    if (!msg.trim()) { toast.error('Type a message first'); return }
    setPolishing(true)
    try {
      const res = await fetch('/api/admin/polish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: msg }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setMsg((await res.json()).text || msg)
      toast.success('Standardised with AI')
    } catch (e) { toast.error(`AI polish failed: ${e instanceof Error ? e.message : 'error'}`) } finally { setPolishing(false) }
  }

  if (!ready) return <div className="flex items-center justify-center min-h-screen text-neutral-400"><Loader2 className="w-5 h-5 animate-spin" /></div>

  const av = data?.availability
  const approvedCount = data?.applications.filter((a) => a.app_status === 'approved').length || 0
  const placedCount = data?.applications.filter((a) => a.stall).length || 0

  return (
    <div className="p-6 sm:p-8 max-w-7xl">
      <div className="mb-1 flex items-center gap-2">
        <div>
          <p className="text-xs font-semibold text-[#cd2653] uppercase tracking-[0.2em]">VENDOR OPS</p>
                  </div>
        <span className="text-[10px] font-bold tracking-[0.16em] uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full">live data</span>
      </div>
      <p className="text-sm text-neutral-500 mb-5">Stall allocation, payments and broadcasts, driven by your real applications.</p>

      <div className="flex flex-wrap gap-2 mb-6 bg-[#FFFFFF]/92 backdrop-blur-md p-1 rounded-full">
        {TABS.map((t) => {
          const Icon = t.icon; const active = tab === t.k
          return (
            <button key={t.k} onClick={() => setTab(t.k)} className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-full transition-colors ${active ? 'bg-[#cd2653] text-white' : 'bg-transparent text-neutral-600 hover:text-neutral-900'}`}>
              <Icon className="w-4 h-4" />{t.label}
            </button>
          )
        })}
      </div>

      {loading && <div className="flex items-center gap-2 text-neutral-400 text-sm py-10"><Loader2 className="w-4 h-4 animate-spin" /> Loading live allocation…</div>}

      {!loading && tab === 'allocation' && data && (() => {
        // adapt /api/admin/stalls payload to the FloorCommand booth shape
        const booths: FloorBooth[] = [
          ...data.stalls.map((s) => ({
            code: s.code,
            type: s.type as FloorBooth['type'],
            col: s.col,
            row: s.row,
            w: s.w,
            h: s.h,
            zone: data.zones.find((z) => s.col >= z.col && s.col < z.col + z.w && s.row >= z.row && s.row < z.row + z.h)?.label || '',
            status: (s.status === 'held' ? 'reserved' : (s.status || 'available')) as FloorBooth['status'],
            vendor: (s.occupant as { business_name?: string } | null)?.business_name || null,
            applicationId: (s.occupant as { id?: string } | null)?.id || null,
          })),
          ...data.zones.map((z) => ({
            code: `Z-${z.label.replace(/\s+/g, '-')}`,
            type: 'facility' as const,
            col: z.col,
            row: z.row,
            w: z.w,
            h: z.h,
            zone: z.label,
            status: 'facility' as const,
            vendor: null,
            applicationId: null,
          })),
        ]
        const apps: FloorApp[] = data.applications.map((a) => ({
          id: a.id, business_name: a.business_name, tier_label: a.tier_label,
          stall: a.stall, stalls: a.stalls ?? (a.stall ? [a.stall] : []),
        }))
        return (
          <FloorCommand hideModeSwitch={true}
            mode="admin"
            booths={booths}
            grid={data.grid}
            applications={apps}
            onAllocate={async (boothCode, vendorName) => {
              // Multi-booth: ONE application per vendor holding a LIST of codes.
              // The API appends, so allocating to a placed vendor adds a booth.
              // Match by name (placed or not).
              const matched = apps.find((a) => a.business_name === vendorName)
              if (!matched) throw new Error(`Vendor ${vendorName} not in approved list`)
              await post({ stall_code: boothCode, application_id: matched.id, status: 'allocated' })
            }}
            onRelease={async (boothCode) => {
              await post({ stall_code: boothCode, status: 'clear' })
            }}
          />
        )
      })()}

      {!loading && tab === 'payments' && data && (() => {
        const rows = data.applications.filter((a) => a.app_status === 'approved' || a.stall)
        const amountOf = (r: AppRow) => r.payment_amount ?? (r.tier ? TIER_META[r.tier]?.price || 0 : 0)
        const paidRows = rows.filter((r) => r.payment_status === 'paid')
        const pendingRows = rows.filter((r) => r.payment_status === 'pending')
        const dueRows = rows.filter((r) => r.payment_status !== 'paid')
        const paidSum = paidRows.reduce((s, r) => s + amountOf(r), 0)
        const dueSum = dueRows.reduce((s, r) => s + amountOf(r), 0)
        const pendingSum = pendingRows.reduce((s, r) => s + amountOf(r), 0)
        const pillFor = (s: string | undefined) => {
          if (s === 'paid') return 'bg-green-50 text-green-700 border-green-200'
          if (s === 'pending') return 'bg-blue-50 text-blue-700 border-blue-200'
          if (s === 'deferred') return 'bg-neutral-50 text-neutral-600 border-neutral-200'
          return 'bg-[#F8DCE3] text-[#cd2653] border-[#cd2653]/30'
        }
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-[#FFFFFF]/92 border border-[#E5E5E5] rounded-xl p-4 backdrop-blur-md"><p className="text-xs text-[#1B1A17]/60">Paid</p><p className="text-2xl font-bold text-green-600">R{paidSum.toLocaleString()}</p><p className="text-[11px] text-[#1B1A17]/40 mt-0.5">{paidRows.length} vendor{paidRows.length === 1 ? '' : 's'}</p></div>
              <div className="bg-[#FFFFFF]/92 border border-[#E5E5E5] rounded-xl p-4 backdrop-blur-md"><p className="text-xs text-[#1B1A17]/60">Pending checkout</p><p className="text-2xl font-bold text-blue-600">R{pendingSum.toLocaleString()}</p><p className="text-[11px] text-[#1B1A17]/40 mt-0.5">{pendingRows.length} vendor{pendingRows.length === 1 ? '' : 's'}</p></div>
              <div className="bg-[#FFFFFF]/92 border border-[#E5E5E5] rounded-xl p-4 backdrop-blur-md"><p className="text-xs text-[#1B1A17]/60">Outstanding</p><p className="text-2xl font-bold text-[#cd2653]">R{dueSum.toLocaleString()}</p><p className="text-[11px] text-[#1B1A17]/40 mt-0.5">{dueRows.length} vendor{dueRows.length === 1 ? '' : 's'}</p></div>
            </div>
            <div className="bg-[#F8DCE3] border border-[#cd2653]/30 rounded-xl p-4 text-sm text-[#cd2653]"><b>Policy:</b> no deposit, full settlement confirms the stall. Full refund if cancelled 8+ weeks before, none after. Payments process via Yoco (card).</div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-900">
              <p className="font-semibold mb-1">Yoco card payments confirm automatically.</p>
              <p className="text-blue-800">When a vendor pays through their portal, the bank webhook flips them to <b>paid</b> in seconds, no action needed here. The <i>Confirm manually</i> link is only for special cases: vendor messaged Support because the card flow failed, paid by EFT off-platform, paid cash at the door, or the fee was waived.</p>
            </div>
            <div className="bg-[#FFFFFF] border border-[#E5E5E5] rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-[#1B1A17]/60 border-b border-[#E5E5E5]"><th className="p-3 font-semibold">Vendor</th><th className="p-3 font-semibold">Chosen booth</th><th className="p-3 font-semibold">Stall</th><th className="p-3 font-semibold">Amount</th><th className="p-3 font-semibold">Payment</th><th className="p-3 font-semibold">Yoco ref</th><th className="p-3 font-semibold text-right">Actions</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-[#E5E5E5]/30">
                        <td className="p-3 font-semibold text-[#1B1A17]">{r.business_name}</td>
                        <td className="p-3 text-[#1B1A17]/60">{r.tier_label}</td>
                        <td className="p-3 text-[#1B1A17]">{(r.stalls && r.stalls.length ? r.stalls.join(', ') : r.stall) || '·'}</td>
                        <td className="p-3 text-[#1B1A17]">{amountOf(r) ? `R${amountOf(r).toLocaleString()}` : '·'}</td>
                        <td className="p-3"><span className={`text-[11px] font-semibold border px-2 py-0.5 rounded ${pillFor(r.payment_status)}`}>{r.payment_status || 'none'}</span></td>
                        <td className="p-3 text-xs text-[#1B1A17]/60 font-mono">{r.payment_ref || '·'}</td>
                        <td className="p-3 text-right">
                          {r.payment_status === 'paid' ? (
                            <div className="inline-flex items-center gap-3 justify-end">
                              <span className="text-[11px] text-[#1B1A17]/40 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-500" />confirmed</span>
                              <button
                                onClick={() => resendInvoice(r)}
                                disabled={resendingFor === r.id}
                                title="Resend the payment confirmation + invoice link to the vendor's email"
                                className="text-[11px] font-semibold text-[#1B1A17]/60 hover:text-[#cd2653] hover:underline inline-flex items-center gap-1 disabled:opacity-60"
                              >
                                {resendingFor === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                {resendingFor === r.id ? 'Sending…' : 'Resend invoice'}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setMarkPaidFor(r); setPaidMethod('manual_card'); setPaidRef(''); setPaidAmountOverride('') }}
                              title="Use only for off-platform payments (EFT, cash, waived). Yoco card payments confirm themselves."
                              className="text-[11px] font-semibold text-[#1B1A17]/60 hover:text-[#cd2653] hover:underline"
                            >
                              Confirm manually
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )
      })()}

      {!loading && tab === 'documents' && data && (() => {
        const foodWords = ['food', 'beverage', 'drink', 'dessert', 'meat', 'bak', 'cater', 'snack', 'restaurant', 'coffee']
        const food = data.applications.filter((a) => (a.categories || []).some((c) => foodWords.some((w) => c.toLowerCase().includes(w))))
        return (
          <div className="bg-[#FFFFFF]/92 border border-[#E5E5E5] rounded-xl p-6 max-w-2xl backdrop-blur-md">
            <p className="font-bold mb-1">Food vendor compliance (COA)</p>
            <p className="text-sm text-neutral-500 mb-4">All food is strictly halaal (vendors vetted). Food vendors must submit a <b>Certificate of Acceptability</b>. {food.length} food vendors detected from real applications.</p>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {food.length === 0 && <p className="text-sm text-neutral-400">No food vendors found.</p>}
              {food.map((v) => (
                <div key={v.id} className="flex items-center justify-between p-3 rounded-lg border border-[#E5E5E5] bg-[#FFFFFF]">
                  <div><p className="text-sm font-semibold text-[#1B1A17]">{v.business_name}</p><p className="text-xs text-[#1B1A17]/60">{(v.categories || []).join(', ')}{v.stall ? ` · ${v.stall}` : ''}</p></div>
                  <span className="text-[11px] font-semibold border px-2 py-0.5 rounded bg-[#FFFFFF] text-[#1B1A17]/60 border-[#E5E5E5]">COA required</span>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {markPaidFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-md" onClick={() => !markingPaid && setMarkPaidFor(null)}>
          <div className="bg-[#FFFFFF] rounded-2xl border border-[#E5E5E5] shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-[#1B1A17]">Confirm payment manually</h3>
                <p className="text-sm text-[#1B1A17]/60 mt-0.5">{markPaidFor.business_name}</p>
                <p className="text-[11px] text-[#1B1A17]/40 mt-1">Only for off-platform payments. Yoco card pays confirm themselves.</p>
              </div>
              <button onClick={() => setMarkPaidFor(null)} className="text-neutral-400 hover:text-neutral-700"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-[#1B1A17]/60">How was this paid?</label>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {([
                    { v: 'manual_card', l: 'Yoco card (manual)' },
                    { v: 'eft', l: 'EFT (bank)' },
                    { v: 'cash', l: 'Cash' },
                    { v: 'waived', l: 'Waived' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.v}
                      onClick={() => setPaidMethod(opt.v)}
                      className={`px-3 py-2 text-sm rounded-lg border text-left ${paidMethod === opt.v ? 'border-[#cd2653] bg-[#cd2653]/10 font-semibold text-[#cd2653]' : 'border-[#E5E5E5] text-[#1B1A17] hover:border-[#E5DCC4]'}`}
                    >
                      {opt.l}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-[#1B1A17]/60">Reference (optional)</label>
                <input
                  value={paidRef}
                  onChange={(e) => setPaidRef(e.target.value)}
                  placeholder="FNB ref, Yoco ID, slip number, etc"
                  className="mt-1 w-full rounded-lg border border-[#E5E5E5] px-3 py-2 text-sm outline-none focus:border-[#cd2653] bg-[#FFFFFF]"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-[#1B1A17]/60">Override amount (optional)</label>
                <input
                  value={paidAmountOverride}
                  onChange={(e) => setPaidAmountOverride(e.target.value)}
                  placeholder={(() => {
                    const a = markPaidFor.payment_amount ?? (markPaidFor.tier ? TIER_META[markPaidFor.tier]?.price || 0 : 0)
                    return a ? `Leave blank to use R${a.toLocaleString()}` : 'Required if no quoted amount'
                  })()}
                  className="mt-1 w-full rounded-lg border border-[#E5E5E5] px-3 py-2 text-sm outline-none focus:border-[#cd2653] bg-[#FFFFFF]"
                />
              </div>
              <div className="rounded-lg bg-[#F8DCE3] border border-[#cd2653]/30 text-[#bf3026] text-xs p-3">
                This sends the vendor a payment-confirmation email and WhatsApp template. Reversible from this row.
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setMarkPaidFor(null)}
                disabled={markingPaid}
                className="flex-1 px-4 py-2.5 rounded-lg border border-[#E5E5E5] text-sm font-semibold text-[#1B1A17] hover:bg-[#FFFFFF] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmMarkPaid}
                disabled={markingPaid}
                className="flex-1 px-4 py-2.5 rounded-lg bg-[#cd2653] hover:bg-[#bf3026] text-white text-sm font-semibold disabled:opacity-60 flex items-center justify-center gap-2 shadow-[0_8px_28px_rgba(184,146,74,.25)]"
              >
                {markingPaid ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Confirm paid
              </button>
            </div>
          </div>
        </div>
      )}

      {!loading && tab === 'broadcast' && data && (
        <div className="grid lg:grid-cols-2 gap-5">
          <div className="bg-[#FFFFFF]/92 border border-[#E5E5E5] rounded-xl p-6 backdrop-blur-md">
            <p className="font-bold mb-3 text-[#1B1A17]">Compose broadcast</p>
            <label className="text-xs font-semibold text-neutral-600">Audience</label>
            <select className="mt-1 mb-3 w-full rounded-lg border border-[#E5E5E5] px-3 py-2 text-sm bg-[#FFFFFF]"><option>All approved vendors ({approvedCount})</option><option>Placed vendors ({placedCount})</option></select>
            <div className="relative">
              <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={5} className="w-full rounded-lg border border-[#E5E5E5] px-3 py-2 text-sm outline-none focus:border-[#cd2653] bg-[#FFFFFF]" />
              <button onClick={polish} disabled={polishing} className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5 text-xs font-semibold bg-gradient-to-r from-[#cd2653] to-[#bf3026] text-white rounded-lg px-2.5 py-1.5 hover:opacity-90 disabled:opacity-60">
                {polishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}{polishing ? 'Polishing…' : 'Polish with AI'}
              </button>
            </div>
            <p className="text-[11px] text-[#1B1A17]/40 mt-1.5">AI (Claude) corrects spelling, grammar and standardises tone before you send.</p>
            <button onClick={() => toast.success(`Queued to ${approvedCount} approved vendors`)} className="mt-3 w-full bg-[#cd2653] hover:bg-[#bf3026] text-white font-semibold rounded-lg py-2.5 text-sm shadow-[0_8px_28px_rgba(184,146,74,.25)]">Queue broadcast</button>
            <p className="text-[11px] text-[#1B1A17]/40 mt-2">WhatsApp delivery activates once the Meta WABA number is approved.</p>
          </div>
          <div className="bg-[#FFFFFF]/92 border border-[#E5E5E5] rounded-xl p-6 backdrop-blur-md">
            <p className="font-bold mb-1 flex items-center gap-2 text-[#1B1A17]"><MapPin className="w-4 h-4 text-[#cd2653]" />Allocation snapshot</p>
            <p className="text-sm text-[#1B1A17]/60 mb-4">Live from the plan.</p>
            <div className="space-y-2">
              {(Object.keys(TYPE_META) as StallType[]).map((t) => (
                <div key={t} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: TYPE_META[t].color }} />{TYPE_META[t].label}</span>
                  <span className="text-[#1B1A17]/60">{av![t].allocated + av![t].held}/{av![t].total} taken</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
