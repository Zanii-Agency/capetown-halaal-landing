'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, Loader2, Send, Wallet, TrendingUp, AlertTriangle, CheckCircle2, Clock, FileText } from 'lucide-react'
import { AdminPage } from '@/components/admin/AdminPage'
import { DenseTable } from '@/components/chrome/DenseTable'
import { KpiStrip } from '@/components/chrome/KpiStrip'
import { Kpi } from '@/components/chrome/Kpi'
import { StatusPill } from '@/components/chrome/StatusPill'
import { FilterPillRow } from '@/components/chrome/FilterPillRow'
import { FilterPill } from '@/components/chrome/FilterPill'

interface PaymentVendor extends Record<string, unknown> {
  id: string
  business_name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  status: string | null
  payment_status: string
  payment_amount: number | null
  payment_due_date: string | null
  paid_at: string | null
  preferred_booth_tier: string | null
  overdue: boolean
}

interface ReconciliationRow extends Record<string, unknown> {
  vendor_id: string
  business_name: string | null
  email: string | null
  payment_status: string
  vendor_amount: number | null
  wc_order_count: number
  wc_total: number
  reconciled: boolean
}

interface Stats {
  total_vendors: number
  total_paid: number
  total_pending: number
  total_none: number
  total_overdue: number
  total_revenue: number
  ticket_revenue?: number
  ticket_orders?: number
  total_money_in?: number
}

interface FinanceResponse {
  payments: PaymentVendor[]
  reconciliation: {
    matched: number
    unmatched: number
    matched_rows: ReconciliationRow[]
    unmatched_orders: Array<{
      order_id: number
      name: string
      email: string | null
      total: string
      date: string
    }>
  }
  stats: Stats
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—'
  return `R ${n.toLocaleString('en-ZA')}`
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

const CAPTURE_ZONES: Array<{ key: string; label: string }> = [
  { key: 'bedouin', label: 'Bedouin (20)' },
  { key: 'food_drink_truck', label: 'Food & Drink Trucks (30)' },
  { key: 'dessert_truck', label: 'Dessert Trucks (10)' },
  { key: 'snack_truck', label: 'Snack Trucks (5)' },
  { key: 'outside', label: 'Outside (other)' },
]

export default function FinancePage() {
  const [data, setData] = useState<FinanceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'payments' | 'reconciliation'>('payments')
  // Operator default: show ALL vendors on load. Paid/Pending/Overdue/Not invoiced stay available.
  const [paymentFilter, setPaymentFilter] = useState<string>('')
  // Outside-vendor payment capture (non-marquee zones — tracked, not allocated).
  const [captureOpen, setCaptureOpen] = useState(false)
  const [capVendor, setCapVendor] = useState('')
  const [capZone, setCapZone] = useState('bedouin')
  const [capAmount, setCapAmount] = useState('')
  const [capRef, setCapRef] = useState('')
  const [capNote, setCapNote] = useState('')
  const [capBusy, setCapBusy] = useState(false)
  const [capMsg, setCapMsg] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (paymentFilter) params.set('payment', paymentFilter)
      const res = await fetch(`/api/admin/finance?${params.toString()}`)
      if (!res.ok) return
      const json = await res.json()
      setData(json as FinanceResponse)
    } finally {
      setLoading(false)
    }
  }, [paymentFilter])

  useEffect(() => {
    reload()
  }, [reload])

  const submitCapture = useCallback(async () => {
    const amount = parseFloat(capAmount)
    if (!capVendor || !capZone || !amount || amount <= 0) {
      setCapMsg('Pick a vendor, zone and a valid amount.')
      return
    }
    setCapBusy(true)
    setCapMsg(null)
    try {
      const res = await fetch('/api/admin/finance/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: capVendor, zone: capZone, amount, reference: capRef || undefined, note: capNote || undefined }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setCapMsg(json?.error || 'Capture failed.'); return }
      setCapMsg(`Captured R${amount.toLocaleString('en-ZA')} for ${json.business_name} (${json.zoneLabel}).`)
      setCapAmount(''); setCapRef(''); setCapNote(''); setCapVendor('')
      await reload()
    } catch {
      setCapMsg('Capture failed.')
    } finally {
      setCapBusy(false)
    }
  }, [capVendor, capZone, capAmount, capRef, capNote, reload])

  const paymentStatusTone = (status: string): 'success' | 'warn' | 'danger' | 'neutral' | 'info' => {
    switch (status) {
      case 'paid': return 'success'
      case 'waived': return 'info'
      case 'pending': return 'warn'
      case 'deferred': return 'info'
      default: return 'neutral'
    }
  }

  const exportCsv = useCallback(() => {
    if (!data) return
    const headers = ['Business Name', 'Contact', 'Email', 'Phone', 'Payment Status', 'Amount', 'Due Date', 'Paid At']
    const rows = data.payments.map(p => [
      p.business_name,
      p.contact_name || '',
      p.email || '',
      p.phone || '',
      p.payment_status,
      p.payment_amount ? String(p.payment_amount) : '',
      p.payment_due_date || '',
      p.paid_at || '',
    ])
    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `vendor-payments-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [data])

  if (loading && !data) {
    return (
      <AdminPage title="Finance" caption="MONEY">
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
        </div>
      </AdminPage>
    )
  }

  const stats = data?.stats
  const payments = data?.payments ?? []
  const reconciliation = data?.reconciliation

  return (
    <AdminPage
      title="Finance"
      caption="MONEY"
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCaptureOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[#cd2653]/30 text-[#cd2653] hover:bg-[#cd2653]/5"
          >
            <Wallet className="w-3.5 h-3.5" />
            Capture payment
          </button>
          <button
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-neutral-200 text-neutral-700 hover:bg-neutral-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
        </div>
      }
    >
      {stats && (
        <>
        {captureOpen && (
          <div className="mb-4 rounded-lg border border-[#cd2653]/20 bg-[#cd2653]/[0.03] p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-[#cd2653] mb-3">
              Capture outside / non-marquee payment
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
              <select value={capVendor} onChange={(e) => setCapVendor(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-md border border-neutral-200 bg-white">
                <option value="">Select vendor…</option>
                {payments.map((p) => (
                  <option key={p.id} value={p.id}>{p.business_name}</option>
                ))}
              </select>
              <select value={capZone} onChange={(e) => setCapZone(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-md border border-neutral-200 bg-white">
                {CAPTURE_ZONES.map((z) => <option key={z.key} value={z.key}>{z.label}</option>)}
              </select>
              <input value={capAmount} onChange={(e) => setCapAmount(e.target.value)} type="number" placeholder="Amount (R)"
                className="px-2 py-1.5 text-sm rounded-md border border-neutral-200 bg-white" />
              <input value={capRef} onChange={(e) => setCapRef(e.target.value)} placeholder="Reference (optional)"
                className="px-2 py-1.5 text-sm rounded-md border border-neutral-200 bg-white" />
              <button onClick={submitCapture} disabled={capBusy}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-[#cd2653] text-white hover:bg-[#b31f47] disabled:opacity-50">
                {capBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Capture'}
              </button>
            </div>
            <input value={capNote} onChange={(e) => setCapNote(e.target.value)} placeholder="Note (optional)"
              className="mt-2 w-full px-2 py-1.5 text-sm rounded-md border border-neutral-200 bg-white" />
            {capMsg && <div className="mt-2 text-xs text-neutral-600">{capMsg}</div>}
          </div>
        )}

        <KpiStrip>
          <Kpi label="Money In (all)" value={fmtMoney(stats.total_money_in ?? stats.total_revenue)} hint="vendors + tickets" />
          <Kpi label="Vendor fees" value={fmtMoney(stats.total_revenue)} hint={`${stats.total_paid} paid`} />
          <Kpi label="Ticket sales" value={fmtMoney(stats.ticket_revenue ?? 0)} hint={`${stats.ticket_orders ?? 0} orders`} />
          <Kpi label="Pending" value={stats.total_pending} />
          <Kpi
            label="Overdue"
            value={stats.total_overdue}
            delta={stats.total_overdue > 0 ? { value: `${stats.total_overdue} overdue`, positive: false } : undefined}
          />
          <Kpi label="Not invoiced" value={stats.total_none} />
        </KpiStrip>
        </>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-neutral-200 mb-6">
        <button
          onClick={() => setTab('payments')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === 'payments'
              ? 'border-[#cd2653] text-[#cd2653]'
              : 'border-transparent text-neutral-500 hover:text-neutral-700'
          }`}
        >
          <Wallet className="w-4 h-4 inline -mt-0.5 mr-1.5" />
          Payments
        </button>
        <button
          onClick={() => setTab('reconciliation')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === 'reconciliation'
              ? 'border-[#cd2653] text-[#cd2653]'
              : 'border-transparent text-neutral-500 hover:text-neutral-700'
          }`}
        >
          <TrendingUp className="w-4 h-4 inline -mt-0.5 mr-1.5" />
          Reconciliation
        </button>
      </div>

      {tab === 'payments' && (
        <div>
          <FilterPillRow>
            <FilterPill label="Paid" active={paymentFilter === 'paid'} onClick={() => setPaymentFilter('paid')} />
            <FilterPill label="All" active={!paymentFilter} onClick={() => setPaymentFilter('')} />
            <FilterPill label="Pending" active={paymentFilter === 'pending'} onClick={() => setPaymentFilter('pending')} />
            <FilterPill label="Overdue" active={paymentFilter === 'overdue'} onClick={() => setPaymentFilter('overdue')} />
            <FilterPill label="Not invoiced" active={paymentFilter === 'none'} onClick={() => setPaymentFilter('none')} />
          </FilterPillRow>

          <div className="mt-4">
            <DenseTable<PaymentVendor>
              columns={[
                { key: 'business_name', header: 'Vendor', render: (r) => (
                  <Link href={`/admin/vendors/${r.id}`} className="text-[#cd2653] hover:underline font-medium">
                    {r.business_name}
                  </Link>
                )},
                { key: 'contact_name', header: 'Contact' },
                { key: 'email', header: 'Email' },
                { key: 'phone', header: 'Phone' },
                {
                  key: 'payment_status',
                  header: 'Status',
                  render: (r) => {
                    const tone = paymentStatusTone(r.payment_status)
                    const label = r.payment_status === 'none' ? 'Not invoiced' : r.payment_status
                    return (
                      <div className="flex items-center gap-2">
                        <StatusPill tone={tone} label={label} />
                        {r.overdue && (
                          <span className="text-[10px] text-red-600 font-medium flex items-center gap-0.5">
                            <AlertTriangle className="w-3 h-3" />
                            Overdue
                          </span>
                        )}
                      </div>
                    )
                  },
                },
                { key: 'payment_amount', header: 'Amount', render: (r) => (
                  <span className="font-mono text-xs tabular-nums">{fmtMoney(r.payment_amount)}</span>
                ), align: 'right' },
                { key: 'payment_due_date', header: 'Due Date', render: (r) => (
                  <span className="text-xs tabular-nums">{fmtDate(r.payment_due_date)}</span>
                )},
                { key: 'paid_at', header: 'Paid At', render: (r) => (
                  <span className="text-xs tabular-nums">{fmtDate(r.paid_at)}</span>
                )},
                {
                  key: 'actions',
                  header: '',
                  width: '100px',
                  render: (r) => (
                    <div className="flex items-center gap-1">
                      {r.phone && (
                        <a
                          href={`whatsapp://send?phone=${r.phone.replace(/[^\d]/g, '').replace(/^0/, '27')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded text-neutral-500 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                          title="Send WhatsApp reminder"
                        >
                          <Send className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <Link
                        href={`/admin/vendors/${r.id}#payments`}
                        className="p-1.5 rounded text-neutral-500 hover:text-[#cd2653] hover:bg-neutral-100 transition-colors"
                        title="View payment details"
                      >
                        <FileText className="w-3.5 h-3.5" />
                      </Link>
                    </div>
                  ),
                },
              ]}
              rows={payments}
              emptyState={{ label: 'No vendors match the current filter.' }}
            />
          </div>
        </div>
      )}

      {tab === 'reconciliation' && reconciliation && (
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-neutral-700">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>{reconciliation.matched} matched</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-neutral-700">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <span>{reconciliation.unmatched} unmatched</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-neutral-700">
              <Clock className="w-4 h-4 text-neutral-500" />
              <span>{reconciliation.unmatched_orders?.length ?? 0} WooCommerce orders without vendor match</span>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-neutral-900 mb-2">
              Vendor Payment vs WooCommerce Orders
            </h3>
            <DenseTable<ReconciliationRow>
              columns={[
                { key: 'business_name', header: 'Vendor' },
                { key: 'email', header: 'Email' },
                {
                  key: 'payment_status', header: 'Payment Status',
                  render: (r) => <StatusPill tone={paymentStatusTone(r.payment_status)} label={r.payment_status === 'none' ? 'Not invoiced' : r.payment_status} />,
                },
                { key: 'vendor_amount', header: 'Recorded', render: (r) => (
                  <span className="font-mono text-xs tabular-nums">{fmtMoney(r.vendor_amount)}</span>
                ), align: 'right' },
                {
                  key: 'wc_order_count', header: 'WC Orders', render: (r) => (
                    <span className="font-mono text-xs tabular-nums">{r.wc_order_count}</span>
                  ), align: 'right',
                },
                { key: 'wc_total', header: 'WC Total', render: (r) => (
                  <span className="font-mono text-xs tabular-nums">{fmtMoney(r.wc_total)}</span>
                ), align: 'right' },
                {
                  key: 'reconciled', header: 'Status',
                  render: (r) => r.reconciled
                    ? <StatusPill tone="success" label="Reconciled" />
                    : <StatusPill tone="warn" label="Mismatch" />,
                },
              ]}
              rows={reconciliation.matched_rows}
              emptyState={{ label: 'No vendors to reconcile.' }}
            />
          </div>

          {reconciliation.unmatched_orders && reconciliation.unmatched_orders.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 mb-2">
                Unmatched WooCommerce Orders (no vendor record)
              </h3>
              <DenseTable<{ order_id: number; name: string; email: string | null; total: string; date: string; [key: string]: unknown }>
                columns={[
                  { key: 'order_id', header: 'Order #', render: (r) => (
                    <a
                      href={`https://tickets.youngatheart.co.za/wp-admin/post.php?post=${r.order_id}&action=edit`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#cd2653] hover:underline font-mono text-xs"
                    >
                      #{r.order_id}
                    </a>
                  )},
                  { key: 'name', header: 'Customer' },
                  { key: 'email', header: 'Email' },
                  { key: 'total', header: 'Total', render: (r) => (
                    <span className="font-mono text-xs tabular-nums">R {r.total}</span>
                  ), align: 'right' },
                  { key: 'date', header: 'Date', render: (r) => (
                    <span className="text-xs tabular-nums">{fmtDate(r.date)}</span>
                  )},
                ]}
                rows={reconciliation.unmatched_orders}
                emptyState={{ label: 'All WooCommerce orders matched to vendors.' }}
              />
            </div>
          )}
        </div>
      )}
    </AdminPage>
  )
}
