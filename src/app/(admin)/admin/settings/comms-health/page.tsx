'use client'

// Live Comms Health board. Polls the admin-only probe routes every 30s and
// renders one pill per channel. Replaces the prior placeholder which hardcoded
// status:'unknown' on every row. Each probe is read-only by construction:
//   WhatsApp = Meta Graph fields read on the phone number
//   Email    = Resend domains.list (no mail sent — Law 5 compliant)
//
// The bot runs on Anthropic, not DGX, so the DGX probe is not surfaced here.
//
// Probes return {ok, status, latency_ms, error?, ...channel-specific fields}.
// We render only what we have, never invent a green.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ArrowLeft, MessageCircle, Mail, RefreshCw } from 'lucide-react'

type ProbeStatus = 'green' | 'amber' | 'red' | 'unknown'

interface ProbeBase {
  ok: boolean
  status: ProbeStatus
  latency_ms: number
  error?: string
}

interface WhatsappProbe extends ProbeBase {
  last_send_at?: string | null
}

interface EmailProbe extends ProbeBase {
  resend_ok: boolean
  smtp_ok: boolean | null
  smtp_note: string
  throttle_hits_24h: number | null
  throttle_hits_note: string
}

type AnyProbe = WhatsappProbe | EmailProbe

interface ChannelState<T extends AnyProbe> {
  loading: boolean
  data: T | null
  lastFetched: number | null
  fetchError: string | null
}

const POLL_MS = 30_000

const PILL_STYLE: Record<ProbeStatus, string> = {
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  red: 'bg-rose-50 text-rose-700 border-rose-200',
  unknown: 'bg-neutral-100 text-neutral-600 border-neutral-200',
}

const DOT_STYLE: Record<ProbeStatus, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  unknown: 'bg-neutral-400',
}

const PILL_LABEL: Record<ProbeStatus, string> = {
  green: 'Healthy',
  amber: 'Degraded',
  red: 'Down',
  unknown: 'Unknown',
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return 'No record'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'No record'
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`
  return `${Math.round(diffSec / 86_400)}d ago`
}

function useProbe<T extends AnyProbe>(path: string): ChannelState<T> {
  const [state, setState] = useState<ChannelState<T>>({
    loading: true,
    data: null,
    lastFetched: null,
    fetchError: null,
  })

  useEffect(() => {
    let cancelled = false

    async function tick() {
      try {
        const res = await fetch(path, { cache: 'no-store' })
        if (!res.ok) {
          if (!cancelled) {
            setState(s => ({
              ...s,
              loading: false,
              fetchError: `HTTP ${res.status}`,
              lastFetched: Date.now(),
            }))
          }
          return
        }
        const data = (await res.json()) as T
        if (!cancelled) {
          setState({ loading: false, data, lastFetched: Date.now(), fetchError: null })
        }
      } catch (e) {
        if (!cancelled) {
          setState(s => ({
            ...s,
            loading: false,
            fetchError: (e as Error).message,
            lastFetched: Date.now(),
          }))
        }
      }
    }

    tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [path])

  return state
}

function probeStatus<T extends AnyProbe>(s: ChannelState<T>): ProbeStatus {
  if (s.loading && !s.data) return 'unknown'
  if (s.fetchError) return 'red'
  return s.data?.status ?? 'unknown'
}

interface CardProps {
  label: string
  Icon: typeof MessageCircle
  description: string
  status: ProbeStatus
  latency_ms: number | null
  primary_label: string
  primary_value: string
  secondary_label?: string | null
  secondary_value?: string | null
  error?: string | null
}

function HealthCard({
  label,
  Icon,
  description,
  status,
  latency_ms,
  primary_label,
  primary_value,
  secondary_label,
  secondary_value,
  error,
}: CardProps) {
  return (
    <div className="bg-white border border-neutral-200 rounded-xl p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-[#cd2653]/10 text-[#cd2653]">
            <Icon className="w-4 h-4" />
          </div>
          <span className="text-sm font-semibold text-neutral-900">{label}</span>
        </div>
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${PILL_STYLE[status]}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${DOT_STYLE[status]}`} />
          {PILL_LABEL[status]}
        </span>
      </div>
      <p className="text-xs text-neutral-500 mt-3 leading-relaxed">{description}</p>
      <dl className="mt-3 space-y-1 text-[11px]">
        <div className="flex justify-between">
          <dt className="text-neutral-400">Latency</dt>
          <dd className="text-neutral-700 font-medium">
            {latency_ms == null ? '...' : `${latency_ms}ms`}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-400">{primary_label}</dt>
          <dd className="text-neutral-700 font-medium text-right">{primary_value || '-'}</dd>
        </div>
        {secondary_label && (
          <div className="flex justify-between">
            <dt className="text-neutral-400">{secondary_label}</dt>
            <dd className="text-neutral-500 text-right">{secondary_value || '-'}</dd>
          </div>
        )}
      </dl>
      {error && (
        <p className="mt-2 text-[10px] text-rose-600 leading-snug break-words">
          {error}
        </p>
      )}
    </div>
  )
}

export default function SettingsCommsHealthPage() {
  const wa = useProbe<WhatsappProbe>('/api/admin/comms-health/whatsapp')
  const em = useProbe<EmailProbe>('/api/admin/comms-health/email')

  const waStatus = probeStatus(wa)
  const emStatus = probeStatus(em)

  const newestFetch = Math.max(
    wa.lastFetched ?? 0,
    em.lastFetched ?? 0,
  )

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      <Link
        href="/admin/settings"
        className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 mb-4"
      >
        <ArrowLeft className="w-3 h-3" /> Back to Settings
      </Link>
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Comms Health</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Live probes against WhatsApp and Email. Polls every 30 seconds.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <RefreshCw className="w-3 h-3" />
          {newestFetch ? `Updated ${fmtRelative(new Date(newestFetch).toISOString())}` : 'Loading...'}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <HealthCard
          label="WhatsApp"
          Icon={MessageCircle}
          description="Meta Cloud API delivery channel."
          status={waStatus}
          latency_ms={wa.data?.latency_ms ?? null}
          primary_label="Last outbound"
          primary_value={fmtRelative(wa.data?.last_send_at)}
          error={wa.fetchError || wa.data?.error || null}
        />
        <HealthCard
          label="Email"
          Icon={Mail}
          description="Resend transactional and blast channel."
          status={emStatus}
          latency_ms={em.data?.latency_ms ?? null}
          primary_label="Resend API"
          primary_value={em.data?.resend_ok ? 'reachable' : em.data ? 'down' : '-'}
          secondary_label="SMTP"
          secondary_value={em.data?.smtp_note ?? null}
          error={em.fetchError || em.data?.error || null}
        />
      </div>
    </div>
  )
}
