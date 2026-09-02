'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import {
  Activity, CheckCircle2, XCircle, MessageSquare, FileText,
  CreditCard, Send, Loader2, RefreshCw, LogIn
} from 'lucide-react'

type FilterKey = 'all' | 'approvals' | 'messages' | 'documents' | 'payments' | 'mass_send' | 'logins'

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
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'messages', label: 'Messages' },
  { key: 'documents', label: 'Documents' },
  { key: 'payments', label: 'Payments' },
  { key: 'mass_send', label: 'Mass send' },
  { key: 'logins', label: 'Logins' },
]

const EVENT_VISUALS: Record<string, { icon: typeof Activity; color: string; bg: string; verb: string }> = {
  application_approved:        { icon: CheckCircle2,   color: 'text-green-600',   bg: 'bg-green-50',   verb: 'approved application' },
  application_rejected:        { icon: XCircle,        color: 'text-red-600',     bg: 'bg-red-50',     verb: 'rejected application' },
  application_info_requested:  { icon: MessageSquare,  color: 'text-blue-600',    bg: 'bg-blue-50',    verb: 'requested info from' },
  apply_submit:                { icon: FileText,       color: 'text-amber-600',   bg: 'bg-amber-50',   verb: 'submitted application' },
  chat_open:                   { icon: MessageSquare,  color: 'text-neutral-500', bg: 'bg-neutral-100',verb: 'opened chat' },
  chat_message:                { icon: MessageSquare,  color: 'text-blue-600',    bg: 'bg-blue-50',    verb: 'messaged' },
  inbox_reply:                 { icon: MessageSquare,  color: 'text-blue-600',    bg: 'bg-blue-50',    verb: 'replied to' },
  document_upload:             { icon: FileText,       color: 'text-purple-600',  bg: 'bg-purple-50',  verb: 'uploaded document for' },
  document_download:           { icon: FileText,       color: 'text-neutral-600', bg: 'bg-neutral-100',verb: 'downloaded document for' },
  contract_signed:             { icon: CheckCircle2,   color: 'text-green-600',   bg: 'bg-green-50',   verb: 'signed contract' },
  checkout_start:              { icon: CreditCard,     color: 'text-amber-600',   bg: 'bg-amber-50',   verb: 'started checkout' },
  checkout_complete:           { icon: CreditCard,     color: 'text-green-600',   bg: 'bg-green-50',   verb: 'paid' },
  payment_failed:              { icon: CreditCard,     color: 'text-red-600',     bg: 'bg-red-50',     verb: 'payment failed for' },
  payment_refunded:            { icon: CreditCard,     color: 'text-neutral-600', bg: 'bg-neutral-100',verb: 'refunded' },
  mass_email_sent:             { icon: Send,           color: 'text-[#cd2653]',   bg: 'bg-[#cd2653]/10', verb: 'sent mass email' },
  mass_whatsapp_sent:          { icon: Send,           color: 'text-green-600',   bg: 'bg-green-50',   verb: 'sent WhatsApp blast' },
  verification_blast:          { icon: Send,           color: 'text-[#cd2653]',   bg: 'bg-[#cd2653]/10', verb: 'sent verification blast' },
  admin_login:                 { icon: LogIn,          color: 'text-neutral-600', bg: 'bg-neutral-100',verb: 'signed in from' },
}

const FALLBACK_VISUAL = { icon: Activity, color: 'text-neutral-500', bg: 'bg-neutral-100', verb: '' }

function formatRelative(ts: string): string {
  const date = new Date(ts)
  const diffMs = Date.now() - date.getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })
}

function humanizeEventType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function ActivityFeed() {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [items, setItems] = useState<ActivityItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useMemo(() => async (cat: FilterKey, refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/activity?category=${cat}&limit=30`, { cache: 'no-store' })
      if (!res.ok) {
        setError('Could not load activity')
        return
      }
      const data = await res.json()
      setItems(data.items || [])
    } catch (err) {
      console.error('[ActivityFeed] load failed:', err)
      setError('Could not load activity')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load(filter)
  }, [filter, load])

  return (
    <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-neutral-400" />
          <h2 className="font-semibold text-neutral-900 text-sm">Activity Feed</h2>
        </div>
        <button
          type="button"
          onClick={() => load(filter, true)}
          disabled={refreshing}
          className="text-sm text-neutral-500 hover:text-neutral-900 flex items-center gap-1.5 disabled:opacity-50 min-h-[44px] min-w-[44px] px-2"
          aria-label="Refresh activity"
        >
          <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {/* Filter chips: ≥44px tap targets for mobile, stacks on small screens */}
      <div className="px-3 py-3 border-b border-neutral-100 flex flex-wrap gap-2 overflow-x-auto">
        {FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-4 py-2.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center',
              filter === f.key
                ? 'bg-neutral-900 text-white'
                : 'bg-neutral-50 text-neutral-600 hover:bg-neutral-100'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-neutral-300" />
        </div>
      ) : error ? (
        <div className="px-5 py-10 text-center text-sm text-red-500">{error}</div>
      ) : items.length === 0 ? (
        <div className="px-5 py-10 text-center text-neutral-300 text-sm">No activity in this view</div>
      ) : (
        <ul className="divide-y divide-neutral-50 max-h-[420px] overflow-y-auto">
          {items.map(ev => {
            const v = EVENT_VISUALS[ev.event_type] ?? FALLBACK_VISUAL
            const Icon = v.icon
            const verb = v.verb || humanizeEventType(ev.event_type)
            // A sign-in has no vendor, so its "where" rides the name slot:
            // "capetownhalaal@gmail.com signed in from Cape Town, ZA".
            const place = ev.event_type === 'admin_login'
              ? (ev.metadata?.place as string | undefined) || null
              : null
            const displayName = place || ev.vendor_name || ev.contact_name
            return (
              <li key={ev.id} className="px-4 sm:px-5 py-3 flex items-start gap-3 min-h-[56px]">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', v.bg)}>
                  <Icon className={cn('w-4 h-4', v.color)} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-neutral-900 leading-snug">
                    <span className="font-medium">{ev.actor}</span>{' '}
                    <span className="text-neutral-600">{verb}</span>
                    {displayName && ev.vendor_id ? (
                      <>
                        {' '}
                        <Link
                          href={`/admin/applications/${ev.vendor_id}`}
                          className="font-medium text-[#cd2653] hover:underline"
                        >
                          {displayName}
                        </Link>
                      </>
                    ) : displayName ? (
                      <> <span className="font-medium text-neutral-900">{displayName}</span></>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-neutral-400 mt-0.5">
                    {formatRelative(ev.created_at)}
                    {place && ev.metadata?.ip ? (
                      <> · <span className="font-mono">{String(ev.metadata.ip)}</span></>
                    ) : ev.path ? <> · <span className="font-mono">{ev.path}</span></> : null}
                    {place && ev.metadata?.expected === false ? (
                      <> · <span className="text-amber-600 font-medium">unusual location</span></>
                    ) : null}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
