'use client'
import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'

interface Props { applicationId: string }

// Keys are read VERBATIM by lib/notifications.ts `notifyVendor` via
// prefs[`${event}_${channel}`] !== false, and persisted by
// /api/exhibitor/notification-prefs onto portal-state.notification_preferences.
// They MUST stay aligned with the NotifyEvent union, so flipping a toggle here
// actually suppresses/enables the matching outbound send.
const PREF_KEYS = [
  'stall_allocated_whatsapp',
  'stall_allocated_email',
  'document_approved_whatsapp',
  'document_approved_email',
  'document_rejected_whatsapp',
  'document_rejected_email',
] as const

type PrefKey = (typeof PREF_KEYS)[number]
type Prefs = Record<PrefKey, boolean>

const DEFAULT_PREFS: Prefs = {
  stall_allocated_whatsapp: true,
  stall_allocated_email: true,
  document_approved_whatsapp: true,
  document_approved_email: true,
  document_rejected_whatsapp: true,
  document_rejected_email: true,
}

const ROWS: { key: PrefKey; label: string }[] = [
  { key: 'stall_allocated_whatsapp', label: 'Stall allocation: WhatsApp' },
  { key: 'stall_allocated_email', label: 'Stall allocation: Email' },
  { key: 'document_approved_whatsapp', label: 'Document approved: WhatsApp' },
  { key: 'document_approved_email', label: 'Document approved: Email' },
  { key: 'document_rejected_whatsapp', label: 'Document needs attention: WhatsApp' },
  { key: 'document_rejected_email', label: 'Document needs attention: Email' },
]

function coercePrefs(raw: unknown): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    for (const k of PREF_KEYS) {
      if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
    }
  }
  return out
}

export default function NotificationPreferences({ applicationId }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<PrefKey | null>(null)
  const lsKey = `notif-prefs-${applicationId}`

  // Guard so a stale in-flight load never clobbers a fresh toggle.
  const loadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/exhibitor/notification-prefs', { cache: 'no-store' })
        if (!res.ok) throw new Error(`GET ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        const server = coercePrefs(json.prefs)

        // One-time migration: if the server has never been written but a legacy
        // localStorage blob exists, push it up so prior local-only choices are
        // not silently lost. After this, the server is the source of truth.
        const serverWasEmpty = !json.prefs || Object.keys(json.prefs).length === 0
        let legacy: unknown = null
        try {
          const stored = localStorage.getItem(lsKey)
          if (stored) legacy = JSON.parse(stored)
        } catch { /* ignore corrupt cache */ }

        if (serverWasEmpty && legacy) {
          const migrated = coercePrefs(legacy)
          setPrefs(migrated)
          try {
            await fetch('/api/exhibitor/notification-prefs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prefs: migrated }),
            })
          } catch { /* migration is best-effort; server stays default until a real toggle */ }
        } else {
          setPrefs(server)
        }
        // Keep a local cache for snappy first paint next visit (not authoritative).
        try { localStorage.setItem(lsKey, JSON.stringify(server)) } catch { /* quota */ }
      } catch {
        if (!cancelled) toast.error('Could not load your notification preferences.')
      } finally {
        if (!cancelled) {
          loadedRef.current = true
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [applicationId, lsKey])

  const toggle = async (key: PrefKey) => {
    if (pending) return
    const prev = prefs
    const nextVal = !prefs[key]
    const optimistic = { ...prefs, [key]: nextVal }

    // Optimistic update for a snappy switch; revert if the server rejects.
    setPrefs(optimistic)
    setPending(key)
    try {
      const res = await fetch('/api/exhibitor/notification-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: nextVal }),
      })
      if (!res.ok) throw new Error(`POST ${res.status}`)
      const json = await res.json()
      const saved = coercePrefs(json.prefs)
      setPrefs(saved)
      try { localStorage.setItem(lsKey, JSON.stringify(saved)) } catch { /* quota */ }
      toast.success('Saved')
    } catch {
      setPrefs(prev) // revert — never show "Saved" on failure
      toast.error('Could not save. Please try again.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-3" aria-busy={loading}>
      {ROWS.map(({ key, label }) => (
        <label key={key} className="flex items-center justify-between text-sm">
          <span>{label}</span>
          <button
            type="button"
            role="switch"
            aria-checked={prefs[key]}
            aria-label={label}
            disabled={loading || pending !== null}
            onClick={() => toggle(key)}
            className={`relative w-10 h-5 rounded-full transition-colors disabled:opacity-60 ${
              prefs[key] ? 'bg-[#cd2653]' : 'bg-neutral-300'
            }`}>
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              prefs[key] ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </label>
      ))}
      {loading && <p className="text-xs text-neutral-400">Loading your preferences…</p>}
    </div>
  )
}
