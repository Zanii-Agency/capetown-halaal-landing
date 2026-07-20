'use client'

import { useCallback, useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { VendorApplication } from '@/lib/supabase/types'
import {
  Ticket, Users, DollarSign, TrendingUp, TrendingDown, ArrowRight,
  Loader2, Clock, Eye, ShoppingCart, AlertTriangle, BarChart3, Activity,
  ChevronRight
} from 'lucide-react'
import { AdminPage } from '@/components/admin/AdminPage'
import { TaskCenter } from '@/components/admin/TaskCenter'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts'

interface Stats {
  total: number
  pending: number
  approved: number
  rejected: number
  info_requested: number
}

interface TicketStats {
  totalRevenue: number
  totalTickets: number
  totalOrders: number
  ticketBreakdown: Record<string, { qty: number; revenue: number }>
  salesByDate: Record<string, { orders: number; revenue: number; tickets: number }>
  recentOrders: Array<{
    id: number
    status: string
    total: string
    date_created: string
    billing: { first_name: string; last_name: string; email: string }
    line_items: Array<{ name: string; quantity: number; total: string }>
  }>
  failedOrders: Array<{ id: number; status: string; total: string; date_created: string; billing: { first_name: string; last_name: string; email: string } }>
  pendingOrders: Array<{ id: number; status: string; total: string; date_created: string; billing: { first_name: string; last_name: string; email: string } }>
  failedCount: number
  pendingCount: number
}

function formatCurrency(amount: number) {
  return 'R' + amount.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-ZA', {
    day: 'numeric', month: 'short',
  })
}

function formatFullDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-ZA', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

async function fetchWithRetry(url: string, maxRetries = 2, delay = 800): Promise<Response | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { next: { revalidate: 0 } })
      return res
    } catch (err) {
      if (attempt === maxRetries) {
        console.warn(`[fetchWithRetry] ${url} failed after ${maxRetries} retries:`, err)
        return null
      }
      await new Promise(r => setTimeout(r, delay * (attempt + 1)))
    }
  }
  return null
}

const PIPELINE_COLORS = {
  approved: '#22c55e',
  pending: '#f59e0b',
  rejected: '#ef4444',
  info_requested: '#3b82f6',
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; name: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-neutral-900 text-white px-3 py-2 rounded-lg text-xs shadow-lg border border-neutral-800">
      <p className="text-neutral-400 mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="font-semibold">
          {entry.name === 'revenue' ? formatCurrency(entry.value) : `${entry.value} tickets`}
        </p>
      ))}
    </div>
  )
}

export default function AdminDashboard() {
  const router = useRouter()
  const [vendorStats, setVendorStats] = useState<Stats | null>(null)
  const [ticketStats, setTicketStats] = useState<TicketStats | null>(null)
  const [recentApps, setRecentApps] = useState<VendorApplication[]>([])
  const [recentCount, setRecentCount] = useState(0)
  const [estimatedRevenue, setEstimatedRevenue] = useState(0)
  const [moneyIn, setMoneyIn] = useState<{ total: number; tickets: number; stalls: number } | null>(null)
  const [categoryBreakdown, setCategoryBreakdown] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [chartTab, setChartTab] = useState('revenue')
  const [bottomTab, setBottomTab] = useState('pending')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(false)

    const [statsRes, ticketRes, appsRes, financeRes] = await Promise.all([
      fetchWithRetry('/api/admin/stats'),
      fetchWithRetry('/api/admin/tickets'),
      fetchWithRetry('/api/applications?status=pending'),
      fetchWithRetry('/api/admin/finance'),
    ])

    const isAuthError =
      statsRes?.status === 401 || ticketRes?.status === 401 || appsRes?.status === 401
    if (isAuthError) {
      router.push('/admin/login')
      return
    }

    let anyData = false

    if (statsRes?.ok) {
      try {
        const data = await statsRes.json()
        setVendorStats(data.stats)
        setRecentCount(data.recentCount || 0)
        setEstimatedRevenue(data.estimatedRevenue || 0)
        setCategoryBreakdown(data.categoryBreakdown || {})
        anyData = true
      } catch (e) {
        console.warn('Failed to parse stats response:', e)
      }
    }

    if (ticketRes?.ok) {
      try {
        const data = await ticketRes.json()
        setTicketStats(data)
        anyData = true
      } catch (e) {
        console.warn('Failed to parse tickets response:', e)
      }
    }

    if (appsRes?.ok) {
      try {
        const data = await appsRes.json()
        setRecentApps(data.applications?.slice(0, 5) || [])
        anyData = true
      } catch (e) {
        console.warn('Failed to parse applications response:', e)
      }
    }

    if (financeRes?.ok) {
      try {
        const data = await financeRes.json()
        const s = data.stats || {}
        // Total money in = vendor stall fees + ticket sales (one figure, matches
        // the Finance page so the home card and Finance never disagree).
        setMoneyIn({ total: s.total_money_in || 0, tickets: s.ticket_revenue || 0, stalls: s.total_revenue || 0 })
        anyData = true
      } catch (e) {
        console.warn('Failed to parse finance response:', e)
      }
    }

    if (!anyData) {
      setError(true)
    }

    setLoading(false)
  }, [router])

  useEffect(() => {
    loadData()
  }, [loadData])

  const chartData = useMemo(() => {
    if (!ticketStats?.salesByDate) return []
    let runningRevenue = 0
    let runningTickets = 0
    return Object.entries(ticketStats.salesByDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-21)
      .map(([date, d]) => {
        runningRevenue += d.revenue
        runningTickets += d.tickets
        return {
          date: formatDate(date),
          revenue: runningRevenue,
          tickets: runningTickets,
          orders: d.orders,
        }
      })
  }, [ticketStats])

  const pipelineData = useMemo(() => {
    if (!vendorStats) return []
    return [
      { name: 'Approved', value: vendorStats.approved, color: PIPELINE_COLORS.approved },
      { name: 'Pending', value: vendorStats.pending, color: PIPELINE_COLORS.pending },
      { name: 'Rejected', value: vendorStats.rejected, color: PIPELINE_COLORS.rejected },
      { name: 'Info Requested', value: vendorStats.info_requested, color: PIPELINE_COLORS.info_requested },
    ].filter(d => d.value > 0)
  }, [vendorStats])

  const ticketTypeData = useMemo(() => {
    if (!ticketStats?.ticketBreakdown) return []
    return Object.entries(ticketStats.ticketBreakdown).map(([name, d]) => ({
      name: name.includes('Friday') ? 'Fri' :
        name.includes('Saturday') ? 'Sat' :
        name.includes('Sunday') ? 'Sun' :
        name.includes('Weekend') ? 'Wknd' : name.slice(0, 8),
      fullName: name.includes('Friday') ? 'Friday Pass' :
        name.includes('Saturday') ? 'Saturday Pass' :
        name.includes('Sunday') ? 'Sunday Pass' :
        name.includes('Weekend') ? 'Weekend Pass' : name,
      qty: d.qty,
      revenue: d.revenue,
    }))
  }, [ticketStats])

  const avgOrderValue = ticketStats && ticketStats.totalOrders > 0
    ? ticketStats.totalRevenue / ticketStats.totalOrders
    : 0

  const conversionRate = ticketStats
    ? ((ticketStats.totalOrders) / (ticketStats.totalOrders + (ticketStats.failedCount || 0) + (ticketStats.pendingCount || 0)) * 100) || 0
    : 0

  const needsAttention = useMemo(() => {
    const alerts: { label: string; count: number; href: string }[] = []
    if (vendorStats?.pending && vendorStats.pending > 0) {
      alerts.push({ label: 'applications pending review', count: vendorStats.pending, href: '/admin/applications?status=pending' })
    }
    return alerts
  }, [vendorStats])

  const pendingApps = vendorStats?.pending || 0

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-neutral-300" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <AlertTriangle className="w-10 h-10 text-red-400" />
        <p className="text-neutral-600 text-sm">Failed to load dashboard data</p>
        <button
          type="button"
          onClick={loadData}
          className="px-4 py-2 bg-[#cd2653] text-white text-sm font-medium rounded-lg hover:bg-[#b81e47] transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  const liveBadge = (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 border border-green-200 rounded-full">
      <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
      <span className="text-xs font-medium text-green-700">Live</span>
    </div>
  )

  return (
    <AdminPage title="Dashboard" subtitle="Young at Heart Festival 2026" actions={liveBadge}>
      {/* Task Center */}
      <TaskCenter />

      {/* Alert Bar */}
      {needsAttention.length > 0 && (
        <div className="space-y-2 mb-6">
          {needsAttention.map(alert => (
            <Link key={alert.label} href={alert.href}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 text-sm hover:bg-amber-100 transition-colors">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <span>{alert.count} {alert.label}</span>
              <ChevronRight className="w-3 h-3 ml-auto text-amber-400" />
            </Link>
          ))}
        </div>
      )}

      {/* Hero Metric */}
      <Link href="/admin/finance" className="block bg-white rounded-xl border border-neutral-200 p-6 hover:border-neutral-300 hover:shadow-sm transition-all group">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Total Money In</span>
          <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
            <DollarSign className="w-5 h-5 text-green-600" />
          </div>
        </div>
        <p className="text-4xl font-bold text-neutral-900 tracking-tight">{formatCurrency(moneyIn?.total ?? ticketStats?.totalRevenue ?? 0)}</p>
        {chartData.length > 0 && (
          <div className="mt-3 h-12">
            <ResponsiveContainer width="100%" height={48}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="sparklineGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="revenue" stroke="#22c55e" strokeWidth={1.5} fill="url(#sparklineGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="text-xs text-neutral-400 mt-2">
          {moneyIn
            ? `Tickets ${formatCurrency(moneyIn.tickets)} · Stalls ${formatCurrency(moneyIn.stalls)}`
            : `${ticketStats?.totalOrders || 0} orders`}
        </p>
      </Link>

      {/* Supporting Strip */}
      <div className="grid grid-cols-3 divide-x divide-neutral-100 rounded-xl border border-neutral-200 bg-white">
        <Link href="/admin/tickets" className="px-4 py-3 hover:bg-neutral-50 transition-colors group">
          <div className="flex items-center gap-1.5 mb-1">
            <Ticket className="w-3.5 h-3.5 text-blue-600" />
            <span className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Tickets Sold</span>
          </div>
          <p className="text-lg font-bold text-neutral-900">{ticketStats?.totalTickets || 0}</p>
          <p className="text-[11px] text-neutral-400 mt-0.5">Avg {formatCurrency(avgOrderValue)}/order</p>
        </Link>

        <Link href="/admin/applications?status=approved" className="px-4 py-3 hover:bg-neutral-50 transition-colors group">
          <div className="flex items-center gap-1.5 mb-1">
            <Users className="w-3.5 h-3.5 text-green-600" />
            <span className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Approved</span>
          </div>
          <p className="text-lg font-bold text-neutral-900">{vendorStats?.approved || 0}</p>
          <p className="text-[11px] text-neutral-400 mt-0.5">Confirmed vendors</p>
        </Link>

        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Activity className="w-3.5 h-3.5 text-neutral-600" />
            <span className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Conversion</span>
          </div>
          <p className="text-lg font-bold text-neutral-900">{conversionRate.toFixed(0)}%</p>
          <p className="text-[11px] text-neutral-400 mt-0.5">{ticketStats?.failedCount || 0} failed</p>
        </div>
      </div>

      {/* Tabbed Charts */}
      <div className="bg-white rounded-xl border border-neutral-200 p-6">
        <div className="flex items-center gap-2 mb-6">
          {['revenue', 'tickets', 'pipeline'].map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setChartTab(tab)}
              className={[
                'px-4 py-1.5 rounded-full text-xs font-medium transition-colors',
                chartTab === tab
                  ? 'bg-[#cd2653] text-white'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200',
              ].join(' ')}
            >
              {tab === 'revenue' ? 'Revenue' : tab === 'tickets' ? 'Tickets' : 'Pipeline'}
            </button>
          ))}
        </div>

        {chartTab === 'revenue' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs text-neutral-400">Last 21 days</p>
              <div className="flex items-center gap-4 text-xs text-neutral-500">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[#cd2653]" /> Revenue</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-blue-400" /> Tickets</span>
              </div>
            </div>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#cd2653" stopOpacity={0.15} />
                      <stop offset="100%" stopColor="#cd2653" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f5" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#a3a3a3' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#a3a3a3' }} axisLine={false} tickLine={false} tickFormatter={(v) => `R${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="revenue" name="revenue" stroke="#cd2653" strokeWidth={2} fill="url(#revenueGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[240px] flex items-center justify-center text-neutral-300 text-sm">No sales data yet</div>
            )}
          </>
        )}

        {chartTab === 'tickets' && (
          <>
            <div className="flex items-center justify-between mb-6">
              <p className="text-xs text-neutral-400">{ticketStats?.totalTickets || 0} total sold</p>
              <BarChart3 className="w-4 h-4 text-neutral-300" />
            </div>
            {ticketTypeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={ticketTypeData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f5" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#737373' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#a3a3a3' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e5e5' }}
                    labelFormatter={(label) => ticketTypeData.find(d => d.name === label)?.fullName || label}
                  />
                  <Bar dataKey="qty" name="qty" fill="#cd2653" radius={[4, 4, 0, 0]} maxBarSize={48} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-neutral-300 text-sm">No ticket data</div>
            )}
            {ticketTypeData.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-neutral-100">
                {ticketTypeData.map((t) => (
                  <div key={t.name} className="text-center">
                    <p className="text-lg font-bold text-neutral-900">{t.qty}</p>
                    <p className="text-xs text-neutral-500">{t.fullName}</p>
                    <p className="text-xs text-neutral-400">{formatCurrency(t.revenue)}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {chartTab === 'pipeline' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs text-neutral-400">Application status breakdown</p>
              <Link href="/admin/applications" className="text-xs text-[#cd2653] hover:underline">View all</Link>
            </div>
            {pipelineData.length > 0 ? (
              <div className="flex items-center gap-8">
                <div className="flex-shrink-0">
                  <ResponsiveContainer width={180} height={180}>
                    <PieChart>
                      <Pie
                        data={pipelineData}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={80}
                        paddingAngle={3}
                        dataKey="value"
                        strokeWidth={0}
                      >
                        {pipelineData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value) => [`${value}`, '']}
                        contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e5e5' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-3 flex-1">
                  {pipelineData.map((item) => (
                    <div key={item.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                        <span className="text-sm text-neutral-600">{item.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-neutral-900">{item.value}</span>
                        <span className="text-xs text-neutral-400">
                          {vendorStats && vendorStats.total > 0 ? `${((item.value / vendorStats.total) * 100).toFixed(0)}%` : ''}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="h-[240px] flex items-center justify-center text-neutral-300 text-sm">No applications yet</div>
            )}
          </>
        )}
      </div>

      {/* Tabbed Bottom Lists */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
          <div className="flex items-center gap-2">
            {['pending', 'recent-orders'].map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setBottomTab(tab)}
                className={[
                  'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                  bottomTab === tab
                    ? 'bg-[#cd2653] text-white'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200',
                ].join(' ')}
              >
                {tab === 'pending' ? 'Pending' : tab === 'recent-orders' ? 'Recent Orders' : 'Recent Activity'}
              </button>
            ))}
          </div>
          {bottomTab === 'pending' && (
            <Link href="/admin/applications?status=pending" className="text-xs text-[#cd2653] hover:underline flex items-center gap-1">
              Review all <ArrowRight className="w-3 h-3" />
            </Link>
          )}
          {bottomTab === 'recent-orders' && (
            <Link href="/admin/tickets" className="text-xs text-[#cd2653] hover:underline flex items-center gap-1">
              All orders <ArrowRight className="w-3 h-3" />
            </Link>
          )}
        </div>

        {bottomTab === 'pending' && (
          recentApps.length > 0 ? (
            <div className="divide-y divide-neutral-50">
              {recentApps.map((app) => (
                <Link
                  key={app.id}
                  href={`/admin/applications/${app.id}`}
                  className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-900">{app.business_name}</p>
                    <p className="text-xs text-neutral-400">{app.contact_name}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                      Pending
                    </span>
                    <Eye className="w-3.5 h-3.5 text-neutral-300" />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-neutral-300 text-sm">All caught up</div>
          )
        )}

        {bottomTab === 'recent-orders' && (
          ticketStats?.recentOrders && ticketStats.recentOrders.length > 0 ? (
            <div className="divide-y divide-neutral-50">
              {ticketStats.recentOrders.slice(0, 6).map((order) => (
                <div key={order.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center flex-shrink-0 text-xs font-semibold text-neutral-500">
                      {order.billing.first_name[0]}{order.billing.last_name[0]}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-neutral-900 truncate">
                        {order.billing.first_name} {order.billing.last_name}
                      </p>
                      <p className="text-xs text-neutral-400 truncate">
                        {order.line_items.map(i => `${i.quantity}× ${i.name.includes('Friday') ? 'Fri' : i.name.includes('Saturday') ? 'Sat' : i.name.includes('Sunday') ? 'Sun' : i.name.includes('Weekend') ? 'Wknd' : i.name}`).join(', ')}
                      </p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <p className="text-sm font-semibold text-neutral-900">R{parseFloat(order.total).toFixed(0)}</p>
                    <p className="text-[11px] text-neutral-400">{formatFullDate(order.date_created)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-neutral-300 text-sm">No orders yet</div>
          )
        )}

      </div>
    </AdminPage>
  )
}
