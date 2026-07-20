'use client'

/**
 * Day-of Gate Lookup. The single screen Samreen lives on at the gate.
 *
 * Three input modes (QR paste, ticket number, name/phone/email search), one
 * results panel, one big check-in button, and a collapsible FooEvents Express
 * Check-In embed for fallback.
 *
 * All UI strings here follow Law 7 (no em-dashes).
 */

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  Loader2, CheckCircle2, XCircle, Search, Hash, QrCode,
  ChevronDown, ChevronUp, RefreshCw, ShieldCheck,
} from 'lucide-react'
import { QrCameraScanner } from '@/components/admin/verifier/QrCameraScanner'

type Mode = 'qr' | 'number' | 'search'

interface Ticket {
  holder_name: string | null
  type: string
  order_number: string
  purchase_date: string | null
  attendance_date: string | null
  checked_in_at: string | null
  is_staff: boolean
}

interface Vendor {
  id: string
  business_name: string
  stall_code: string | null
}

interface SearchHit {
  kind: 'buyer' | 'staff' | 'vendor'
  label: string
  sub: string
  order_id?: number
  application_id?: string
  phone?: string | null
  email?: string | null
}

interface LookupResult {
  valid: boolean
  ticket: Ticket | null
  vendor: Vendor | null
  hits?: SearchHit[]
  error?: string
}

const SCANNER_URL = 'https://tickets.youngatheart.co.za/wp-admin/admin.php?page=fooevents-express-check-in'

function formatDate(iso: string | null): string {
  if (!iso) return ','
  try {
    return new Date(iso).toLocaleString('en-ZA', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

export default function VerifierPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-neutral-500">Loading,</div>}>
      <VerifierPageInner />
    </Suspense>
  )
}

function VerifierPageInner() {
  const search = useSearchParams()
  const initialMode = (search.get('mode') as Mode) || 'number'
  const initialValue = search.get('value') || ''
  const [mode, setMode] = useState<Mode>(['qr', 'number', 'search'].includes(initialMode) ? initialMode : 'number')
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LookupResult | null>(null)
  const [checkingIn, setCheckingIn] = useState(false)
  const [reissuing, setReissuing] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [autoRanFor, setAutoRanFor] = useState<string | null>(null)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2500)
  }, [])

  // runLookup reads from state by default, but accepts explicit overrides so
  // the camera scanner can drive a lookup with a freshly decoded payload
  // without waiting for a setState round-trip.
  const runLookup = useCallback(async (override?: { mode: Mode; value: string }) => {
    const useMode = override?.mode ?? mode
    const useValue = (override?.value ?? value).trim()
    if (!useValue) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/verifier/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: useMode, value: useValue }),
      })
      const j = await res.json() as LookupResult
      setResult(j)
    } catch (e) {
      console.error(e)
      setResult({ valid: false, ticket: null, vendor: null, error: 'Network error. Try again.' })
    } finally {
      setBusy(false)
    }
  }, [mode, value])

  // Camera scan handler: a decoded QR payload flows straight into the existing
  // `qr` lookup mode. We also reflect it into the QR input so the operator sees
  // what was scanned and can re-run or edit if needed. Check-in stays on-platform.
  const onCameraScan = useCallback((raw: string) => {
    setMode('qr')
    setValue(raw)
    runLookup({ mode: 'qr', value: raw })
  }, [runLookup])

  // Auto-run a lookup when arriving with ?mode=&value= deep-links from
  // /admin/people. Guarded so we only fire once per inbound URL change.
  useEffect(() => {
    const sig = `${mode}:${value}`
    if (initialValue && autoRanFor !== sig && value === initialValue) {
      setAutoRanFor(sig)
      runLookup()
    }
  }, [initialValue, mode, value, autoRanFor, runLookup])

  const onCheckIn = useCallback(async () => {
    if (!result || !result.ticket) return
    const orderId = Number(result.ticket.order_number)
    if (!Number.isFinite(orderId)) return
    setCheckingIn(true)
    try {
      const res = await fetch('/api/admin/verifier/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId }),
      })
      const j = await res.json() as { ok: boolean; checked_in_at?: string; error?: string }
      if (j.ok && result.ticket) {
        setResult({
          ...result,
          ticket: { ...result.ticket, checked_in_at: j.checked_in_at || new Date().toISOString() },
        })
        flash('Checked in. Wave them through.')
      } else {
        flash(j.error || 'Check-in failed.')
      }
    } catch (e) {
      console.error(e)
      flash('Network error on check-in.')
    } finally {
      setCheckingIn(false)
    }
  }, [result, flash])

  const onReissue = useCallback(async () => {
    if (!result || !result.ticket) return
    setReissuing(true)
    try {
      // Reissue goes through the existing FooEvents -> WhatsApp pipeline on
      // the WP side. We open the admin order edit page in a new tab so the
      // operator can hit "Resend ticket" if the auto-reissue hook is not
      // wired yet. This is intentional: the WhatsApp resend route requires
      // a base64 PDF body that only the WP hook can build.
      const url = `https://tickets.youngatheart.co.za/wp-admin/post.php?post=${result.ticket.order_number}&action=edit`
      window.open(url, '_blank', 'noopener,noreferrer')
      flash('Opened order in tickets store. Resend PDF from there.')
    } finally {
      setReissuing(false)
    }
  }, [result, flash])

  const loadHit = useCallback((hit: SearchHit) => {
    if (hit.order_id) {
      setMode('number')
      setValue(String(hit.order_id))
      window.setTimeout(() => { runLookup() }, 0)
    }
  }, [runLookup])

  return (
    <div className="p-6 sm:p-8 max-w-5xl mx-auto">
      <header className="mb-6">
        <p className="text-xs font-semibold text-[#cd2653] uppercase tracking-[0.2em]">Operations</p>
        <h1 className="text-3xl font-bold text-neutral-900 mt-1">Day-of Gate Lookup</h1>
        <p className="text-sm text-neutral-600 mt-2 max-w-2xl">
          Verify any ticket. Help anyone stuck at the gate in under 10 seconds. Paste a QR payload,
          type the ticket number, or search by name, phone, or email.
        </p>
      </header>

      {/* Mode tabs */}
      <div className="flex gap-2 mb-4">
        {([
          { id: 'number', label: 'Ticket number', Icon: Hash },
          { id: 'qr', label: 'Paste QR', Icon: QrCode },
          { id: 'search', label: 'Name / phone / email', Icon: Search },
        ] as Array<{ id: Mode; label: string; Icon: typeof Hash }>).map((t) => {
          const active = mode === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => { setMode(t.id); setResult(null); setValue('') }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                active
                  ? 'bg-[#cd2653] text-white border-[#cd2653]'
                  : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
              }`}
            >
              <t.Icon className="w-4 h-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Input */}
      <div className="bg-white border border-neutral-200 rounded-xl p-4 mb-6">
        {mode === 'qr' ? (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste the QR text after scanning. Example: 9477|123|abcd..."
            rows={3}
            className="w-full text-sm font-mono px-3 py-2 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653]/40"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runLookup() }}
            placeholder={mode === 'number' ? 'Order number from the ticket PDF (e.g. 9477)' : 'Search by name, phone, or email'}
            className="w-full text-sm px-3 py-2 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653]/40"
          />
        )}
        <div className="flex justify-between items-center mt-3">
          <p className="text-xs text-neutral-500">
            {mode === 'qr' ? 'Use any QR reader app, copy the payload, paste it here.' :
             mode === 'number' ? 'Look on the PDF footer. Yoco orders look like 9450.' :
             'Matches across buyers, staff badges, and vendors.'}
          </p>
          <button
            type="button"
            onClick={() => runLookup()}
            disabled={busy || !value.trim()}
            className="px-4 py-2 bg-[#cd2653] text-white text-sm font-semibold rounded-lg hover:bg-[#b01f45] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {busy ? 'Looking up' : 'Look up'}
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <ResultPanel
          result={result}
          checkingIn={checkingIn}
          reissuing={reissuing}
          onCheckIn={onCheckIn}
          onReissue={onReissue}
          onPickHit={loadHit}
        />
      )}

      {/* On-platform camera scanner. Replaces the old cross-origin WordPress
          iframe embed (which rendered blank): we read the QR off the device
          camera in-page and feed it into the existing verifier lookup, so
          check-in never leaves this page. */}
      <div className="mt-8 bg-white border border-neutral-200 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setScannerOpen((s) => !s)}
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-neutral-50"
        >
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4 text-neutral-500" />
            <span className="font-semibold text-neutral-900 text-sm">Scan with camera</span>
          </div>
          {scannerOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        {scannerOpen && (
          <div className="border-t border-neutral-200 p-4">
            <QrCameraScanner onScan={onCameraScan} fallbackUrl={SCANNER_URL} />
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 bg-neutral-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function ResultPanel({
  result, checkingIn, reissuing, onCheckIn, onReissue, onPickHit,
}: {
  result: LookupResult
  checkingIn: boolean
  reissuing: boolean
  onCheckIn: () => void
  onReissue: () => void
  onPickHit: (hit: SearchHit) => void
}) {
  // Search mode response (no single ticket): show hits list.
  if (result.hits && result.hits.length > 0 && !result.ticket) {
    return (
      <div className="bg-white border border-neutral-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-neutral-900 mb-3">Possible matches</h2>
        <ul className="divide-y divide-neutral-100">
          {result.hits.map((h, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => onPickHit(h)}
                disabled={!h.order_id}
                className="w-full py-3 flex items-center justify-between text-left hover:bg-neutral-50 -mx-2 px-2 rounded disabled:cursor-default"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <KindPill kind={h.kind} />
                    <span className="text-sm font-medium text-neutral-900 truncate">{h.label}</span>
                  </div>
                  <div className="text-xs text-neutral-500 mt-0.5 truncate">{h.sub}</div>
                </div>
                {h.order_id && (
                  <span className="text-xs text-neutral-500 ml-3 flex-shrink-0">#{h.order_id}</span>
                )}
                {!h.order_id && h.application_id && (
                  <Link
                    href={`/admin/vendors/${h.application_id}`}
                    className="text-xs text-[#cd2653] hover:underline ml-3 flex-shrink-0"
                  >
                    Vendor profile
                  </Link>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // No ticket and no hits: show error / not-found banner.
  if (!result.ticket) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6">
        <div className="flex items-center gap-3">
          <XCircle className="w-8 h-8 text-red-600" />
          <div>
            <div className="text-lg font-bold text-red-700">No match</div>
            <div className="text-sm text-neutral-600 mt-1">{result.error || 'Nothing found for that input.'}</div>
          </div>
        </div>
      </div>
    )
  }

  // Single ticket result.
  const t = result.ticket
  const v = result.vendor
  const checkedIn = Boolean(t.checked_in_at)
  return (
    <div className={`rounded-xl border-2 overflow-hidden ${
      result.valid ? 'bg-green-50 border-green-300' : 'bg-red-50 border-red-300'
    }`}>
      <div className="p-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {result.valid
            ? <CheckCircle2 className="w-10 h-10 text-green-600" />
            : <XCircle className="w-10 h-10 text-red-600" />}
          <div>
            <div className={`text-2xl font-bold ${result.valid ? 'text-green-700' : 'text-red-700'}`}>
              {result.valid ? 'VALID' : 'INVALID'}
            </div>
            <div className="text-sm text-neutral-700">{t.type}</div>
          </div>
        </div>
        {checkedIn && (
          <div className="px-3 py-1 bg-amber-100 text-amber-800 text-xs font-semibold rounded-full border border-amber-300">
            Already checked in {t.checked_in_at ? formatDate(t.checked_in_at) : ''}
          </div>
        )}
      </div>

      <div className="bg-white border-t border-neutral-200 p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Holder" value={t.holder_name || ','} />
        <Field label="Order number" value={`#${t.order_number}`} />
        <Field label="Purchase date" value={formatDate(t.purchase_date)} />
        <Field label="Attendance date" value={t.attendance_date || 'Any festival day'} />
        {v && (
          <>
            <Field
              label="Vendor"
              value={
                <Link href={`/admin/vendors/${v.id}`} className="text-[#cd2653] hover:underline font-medium">
                  {v.business_name}
                </Link>
              }
            />
            <Field label="Stall code" value={v.stall_code || 'Not allocated'} />
          </>
        )}
        {result.error && !result.valid && (
          <div className="sm:col-span-2 text-sm text-red-700 bg-red-100 border border-red-200 rounded-lg p-3">
            {result.error}
          </div>
        )}
      </div>

      <div className="bg-neutral-50 border-t border-neutral-200 p-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCheckIn}
          disabled={!result.valid || checkingIn || checkedIn}
          className="flex-1 min-w-[200px] px-4 py-3 bg-[#cd2653] text-white font-bold rounded-lg hover:bg-[#b01f45] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {checkingIn ? <Loader2 className="w-5 h-5 animate-spin" /> : <ShieldCheck className="w-5 h-5" />}
          {checkedIn ? 'Already checked in' : 'Mark as checked in'}
        </button>
        <button
          type="button"
          onClick={onReissue}
          disabled={reissuing}
          className="px-4 py-3 bg-white border border-neutral-200 text-neutral-700 font-semibold rounded-lg hover:bg-neutral-50 disabled:opacity-50 flex items-center gap-2"
        >
          {reissuing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Reissue PDF
        </button>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">{label}</div>
      <div className="text-sm text-neutral-900 mt-0.5">{value}</div>
    </div>
  )
}

function KindPill({ kind }: { kind: 'buyer' | 'staff' | 'vendor' }) {
  const map = {
    buyer: { label: 'Buyer', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
    staff: { label: 'Staff', cls: 'bg-purple-100 text-purple-700 border-purple-200' },
    vendor: { label: 'Vendor', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  }
  const m = map[kind]
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border ${m.cls}`}>
      {m.label}
    </span>
  )
}

