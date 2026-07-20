'use client'

// =============================================================================
// /admin/broadcast — mass outreach console.
//
// Layout (top to bottom):
//   1. Filter chip rail — status, sector, booth tier, document, contract, paid.
//   2. Channel toggle — Email / WhatsApp / Both.
//   3. Mode radio — "Use template" or "Write your own".
//   4. Template picker (template mode) — dropdown from TEMPLATE_LABELS.
//   5. Free-text composer (write-your-own mode) — plain textarea.
//   6. Optional custom message — appended as {{custom_message}} (template mode).
//   7. Preview pane — live render for the FIRST audience member, with a
//      "preview as: <vendor> ▾" picker to switch sample. Plus a "Spin"
//      button that calls Claude for three rewrites that preserve merge tags.
//   8. Live count (fetched from GET ?counts=1 as filters change). Channel-honest:
//      mail/wa show that channel's eligible count; "both" shows mail+wa total
//      (a both-send is two real sends, not one). Skipped/over-cap surfaced here.
//   9. Send button → confirmation modal showing the exact per-channel split.
//
// Design language: white canvas, neutral grays, festival red accents
// (#cd2653 borrowed from the admin sidebar), tight typography. No glassmorphism.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'

type Channel = 'mail' | 'wa' | 'both'
type Mode = 'template' | 'free_text'
type TemplateKey =
  | 'doc_chase'
  | 'payment_reminder'
  | 'contract_sign_reminder'
  | 'stall_allocation_notice'
  | 'general_announcement'

const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  doc_chase: 'Documents outstanding',
  payment_reminder: 'Stall fee reminder',
  contract_sign_reminder: 'Sign contract reminder',
  stall_allocation_notice: 'Stall allocation notice',
  general_announcement: 'General announcement',
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'info_requested', label: 'Info requested' },
]

interface Filters {
  status: string
  sector: string
  booth_tier: string
  has_docs: '' | 'true' | 'false'
  contract_signed: '' | 'true' | 'false'
  paid: '' | 'true' | 'false'
}

const EMPTY_FILTERS: Filters = {
  status: '',
  sector: '',
  booth_tier: '',
  has_docs: '',
  contract_signed: '',
  paid: '',
}

interface CountsResponse {
  audience_total: number
  mail_count: number
  wa_count: number
  optout_count: number
}

// Mirror of BROADCAST_MAX_RECIPIENTS in the dispatch route. A send above this
// is refused server-side (413). We surface it in the UI so the operator learns
// before clicking Send, not after.
const AUDIENCE_CAP = 500

const ZAR = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 })

const SECTOR_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any sector' },
  { value: 'food', label: 'Food' },
  { value: 'fashion', label: 'Fashion' },
  { value: 'beauty', label: 'Beauty' },
  { value: 'crafts', label: 'Crafts' },
  { value: 'services', label: 'Services' },
  { value: 'other', label: 'Other' },
]

const TIER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any tier' },
  { value: 'food-truck-6m', label: 'Food truck 6m' },
  { value: 'food-truck-3m', label: 'Food truck 3m' },
  { value: 'gazebo-3x3', label: 'Gazebo 3x3' },
  { value: 'gazebo-6x3', label: 'Gazebo 6x3' },
  { value: 'gazebo-9x3', label: 'Gazebo 9x3' },
  { value: 'shell-scheme', label: 'Shell scheme' },
]

interface DispatchResponse {
  audience_total: number
  mail: { attempted: number; sent: number; failed: number; skipped: number }
  wa: { attempted: number; sent: number; failed: number; skipped: number }
  dry_run: boolean
  errors: Array<{ kind: 'mail' | 'wa'; to: string; error: string }>
}

interface AudienceSample {
  id: string
  business_name: string
  contact_name: string
}

interface PreviewResponse {
  mode: 'template' | 'free_text'
  template_key?: TemplateKey
  subject: string
  body_text: string
  sample: AudienceSample
  audience_total: number
}

function buildQuery(filters: Filters): string {
  const p = new URLSearchParams({ counts: '1' })
  if (filters.status) p.set('status', filters.status)
  if (filters.sector) p.set('sector', filters.sector)
  if (filters.booth_tier) p.set('booth_tier', filters.booth_tier)
  if (filters.has_docs) p.set('has_docs', filters.has_docs)
  if (filters.contract_signed) p.set('contract_signed', filters.contract_signed)
  if (filters.paid) p.set('paid', filters.paid)
  return p.toString()
}

function filtersToBody(filters: Filters) {
  return {
    status: filters.status || null,
    sector: filters.sector || null,
    booth_tier: filters.booth_tier || null,
    has_docs: filters.has_docs === '' ? null : filters.has_docs === 'true',
    contract_signed: filters.contract_signed === '' ? null : filters.contract_signed === 'true',
    paid: filters.paid === '' ? null : filters.paid === 'true',
  }
}

export default function BroadcastPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [channel, setChannel] = useState<Channel>('mail')
  const [mode, setMode] = useState<Mode>('template')
  const [templateKey, setTemplateKey] = useState<TemplateKey>('general_announcement')
  const [customMessage, setCustomMessage] = useState('')
  const [freeText, setFreeText] = useState('')
  const [freeTextSubject, setFreeTextSubject] = useState('')
  const [counts, setCounts] = useState<CountsResponse | null>(null)
  const [countsLoading, setCountsLoading] = useState(false)
  const [countsError, setCountsError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<DispatchResponse | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

  // Preview state.
  const [audienceSample, setAudienceSample] = useState<AudienceSample[]>([])
  const [previewVendorId, setPreviewVendorId] = useState<string>('')
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Spin state.
  const [spinning, setSpinning] = useState(false)
  const [spinError, setSpinError] = useState<string | null>(null)
  const [spinVariants, setSpinVariants] = useState<string[] | null>(null)

  // Refresh counts when filters change.
  useEffect(() => {
    let cancelled = false
    setCountsLoading(true)
    setCountsError(null)
    fetch(`/api/admin/whatsapp-broadcast?${buildQuery(filters)}`, {
      credentials: 'include',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`)
        return r.json() as Promise<CountsResponse>
      })
      .then((j) => { if (!cancelled) setCounts(j) })
      .catch((e: Error) => { if (!cancelled) setCountsError(e.message) })
      .finally(() => { if (!cancelled) setCountsLoading(false) })
    return () => { cancelled = true }
  }, [filters])

  // Refresh audience sample list when filters change.
  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams()
    if (filters.status) qs.set('status', filters.status)
    if (filters.sector) qs.set('sector', filters.sector)
    if (filters.booth_tier) qs.set('booth_tier', filters.booth_tier)
    if (filters.has_docs) qs.set('has_docs', filters.has_docs)
    if (filters.contract_signed) qs.set('contract_signed', filters.contract_signed)
    if (filters.paid) qs.set('paid', filters.paid)
    fetch(`/api/admin/broadcast/preview?${qs.toString()}`, { credentials: 'include' })
      .then(async (r) => r.ok ? r.json() : null)
      .then((j) => {
        if (cancelled || !j) return
        setAudienceSample(j.audience || [])
        // Default to the first sample when the current selection drops out.
        if (j.audience?.length && !j.audience.find((a: AudienceSample) => a.id === previewVendorId)) {
          setPreviewVendorId(j.audience[0].id)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
    // previewVendorId intentionally excluded so a user switching previews
    // does not re-fetch the audience list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  // Refresh preview when template / mode / vendor / customMessage / freeText changes.
  useEffect(() => {
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    fetch('/api/admin/broadcast/preview', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_key: mode === 'template' ? templateKey : undefined,
        custom_message: customMessage,
        vendor_id: previewVendorId || undefined,
        free_text: mode === 'free_text' ? freeText : undefined,
        filters: filtersToBody(filters),
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`)
        return r.json() as Promise<PreviewResponse>
      })
      .then((j) => { if (!cancelled) setPreview(j) })
      .catch((e: Error) => { if (!cancelled) setPreviewError(e.message) })
      .finally(() => { if (!cancelled) setPreviewLoading(false) })
    return () => { cancelled = true }
  }, [mode, templateKey, customMessage, freeText, previewVendorId, filters])

  // Channel-honest recipient numbers.
  //   mailWillSend / waWillSend = messages that actually go out per channel.
  //   expectedCount = the headline number. For a single channel it is that
  //     channel's eligible count. For "both" it is the TOTAL messages that fire
  //     (mail + wa), because a "both" send is two real sends, not one. Showing
  //     max() here understated a both-blast by hundreds of messages.
  const mailWillSend = channel === 'wa' ? 0 : (counts?.mail_count ?? 0)
  const waWillSend = channel === 'mail' ? 0 : (counts?.wa_count ?? 0)
  const expectedCount = useMemo(() => {
    if (!counts) return 0
    if (channel === 'mail') return counts.mail_count
    if (channel === 'wa') return counts.wa_count
    return counts.mail_count + counts.wa_count
  }, [channel, counts])

  // The dispatch route caps a single send at AUDIENCE_CAP *audience rows*
  // (not messages). buildAudience runs before the channel split, so the cap
  // is on audience_total. Surface it so the operator tightens filters first.
  const audienceTotal = counts?.audience_total ?? 0
  const overCap = audienceTotal > AUDIENCE_CAP

  // How many in the filtered audience are unreachable on the chosen channel,
  // so the operator understands why the channel number is lower than the
  // audience total (no email on file, opted out, or no usable phone).
  const unreachableOnChannel = useMemo(() => {
    if (!counts) return 0
    if (channel === 'mail') return Math.max(0, counts.audience_total - counts.mail_count)
    if (channel === 'wa') return Math.max(0, counts.audience_total - counts.wa_count)
    return 0
  }, [channel, counts])

  const spin = async () => {
    setSpinning(true)
    setSpinError(null)
    setSpinVariants(null)
    try {
      const baseText = mode === 'free_text' ? freeText : (preview?.body_text || '')
      if (!baseText.trim()) {
        throw new Error('Nothing to spin yet, pick a template or write some text first.')
      }
      const res = await fetch('/api/admin/broadcast/spin', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: baseText,
          template_key: mode === 'template' ? templateKey : undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setSpinVariants(json.variants || [])
    } catch (e) {
      setSpinError((e as Error).message)
    } finally {
      setSpinning(false)
    }
  }

  const acceptSpin = (variant: string) => {
    // Spin output lands in free-text mode so the operator sees exactly what
    // will go out and can still edit before sending.
    setMode('free_text')
    setFreeText(variant)
    setSpinVariants(null)
  }

  const send = async () => {
    setSending(true)
    setSendError(null)
    setResult(null)
    try {
      const res = await fetch('/api/admin/whatsapp-broadcast', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          filters: filtersToBody(filters),
          template_key: mode === 'template' ? templateKey : 'general_announcement',
          custom_message: customMessage,
          free_text: mode === 'free_text' ? freeText : undefined,
          free_text_subject: mode === 'free_text' ? freeTextSubject : undefined,
        }),
      })
      const json = await res.json() as DispatchResponse | { error?: string; max?: number; got?: number; retry_after_seconds?: number }
      if (!res.ok) {
        const err = json as { error?: string; max?: number; got?: number; retry_after_seconds?: number }
        // Map the dispatch route's machine errors to operator-readable text.
        let msg = err.error || `HTTP ${res.status}`
        if (err.error === 'audience_too_large') {
          msg = `Audience of ${err.got} is above the ${err.max} per-send limit. Tighten the filters or split the send.`
        } else if (err.error === 'rate_limited') {
          msg = `Too many broadcasts in a short window. Try again in ${err.retry_after_seconds ?? 60}s.`
        } else if (err.error === 'insufficient_role') {
          msg = 'Your account cannot send broadcasts. Ask an owner or operator to run this.'
        }
        throw new Error(msg)
      }
      setResult(json as DispatchResponse)
      setConfirmOpen(false)
    } catch (e) {
      setSendError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const sendDisabled =
    expectedCount === 0 ||
    overCap ||
    sending ||
    (mode === 'template' && !templateKey) ||
    (mode === 'free_text' && freeText.trim().length === 0)

  return (
    <div className="px-8 py-10 max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-neutral-900">Broadcast</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Reach a filtered slice of your vendor base on email, WhatsApp, or both.
        </p>
      </header>

      {/* Compact filter rail (mirrors ApplicationsFilters) */}
      <section className="mb-6">
        <BroadcastFilters
          filters={filters}
          channel={channel}
          setChannel={setChannel}
          onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
          onClearAll={() => { setFilters(EMPTY_FILTERS); setChannel('mail') }}
        />
      </section>

      {/* Mode radio */}
      <section className="mb-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Message source</h2>
        <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-1">
          {(['template', 'free_text'] as Mode[]).map((m) => (
            <button key={m} type="button"
              onClick={() => setMode(m)}
              className={
                'px-4 py-2 text-sm font-medium rounded-md transition-colors ' +
                (mode === m ? 'bg-[#cd2653] text-white' : 'text-neutral-600 hover:bg-neutral-100')
              }>
              {m === 'template' ? 'Use template' : 'Write your own'}
            </button>
          ))}
        </div>
      </section>

      {/* Template picker (template mode) */}
      {mode === 'template' && (
        <section className="mb-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
            Template
          </label>
          <select value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value as TemplateKey)}
            className="w-full md:w-96 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#cd2653]/40">
            {(Object.keys(TEMPLATE_LABELS) as TemplateKey[]).map((k) => (
              <option key={k} value={k}>{TEMPLATE_LABELS[k]}</option>
            ))}
          </select>
        </section>
      )}

      {/* Free-text composer (write-your-own mode) */}
      {mode === 'free_text' && (
        <section className="mb-5 space-y-3">
          <label className="block">
            <span className="block text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Subject (email only)</span>
            <input type="text" value={freeTextSubject}
              onChange={(e) => setFreeTextSubject(e.target.value)}
              placeholder="An update from Young at Heart Festival"
              className="w-full md:w-96 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#cd2653]/40" />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Your message</span>
            <div className="relative">
              <textarea value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                rows={8}
                placeholder="Write your message here. Use {{first_name}}, {{business_name}}, {{stall_code}} for merge tags."
                className="w-full pr-32 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#cd2653]/40" />
              <button type="button"
                onClick={spin}
                disabled={spinning}
                className="absolute top-2 right-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#cd2653] text-white text-xs font-medium hover:bg-[#b01f45] disabled:opacity-50 disabled:cursor-not-allowed">
                <Sparkles className="w-3.5 h-3.5" />
                {spinning ? 'Spinning...' : 'Spin with AI'}
              </button>
            </div>
          </label>
        </section>
      )}

      {/* Custom message (template mode only) */}
      {mode === 'template' && (
        <section className="mb-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
            Optional custom message
          </label>
          <div className="relative">
            <textarea value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              rows={4}
              placeholder="Anything extra to add. Injected as {{custom_message}} in the template."
              className="w-full pr-32 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#cd2653]/40" />
            <button type="button"
              onClick={spin}
              disabled={spinning}
              className="absolute top-2 right-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#cd2653] text-white text-xs font-medium hover:bg-[#b01f45] disabled:opacity-50 disabled:cursor-not-allowed">
              <Sparkles className="w-3.5 h-3.5" />
              {spinning ? 'Spinning...' : 'Spin with AI'}
            </button>
          </div>
        </section>
      )}

      {/* Preview pane */}
      <section className="mb-7 rounded-lg border border-neutral-200 bg-neutral-50">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200">
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Preview</h3>
            {audienceSample.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-neutral-500">
                preview as
                <select value={previewVendorId}
                  onChange={(e) => setPreviewVendorId(e.target.value)}
                  className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#cd2653]/40">
                  {audienceSample.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.contact_name || '(no name)'}{a.business_name ? ` - ${a.business_name}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <button type="button"
            onClick={spin}
            disabled={spinning}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed">
            {spinning ? 'Spinning...' : 'Spin'}
          </button>
        </div>
        <div className="px-4 py-4">
          {previewLoading && <p className="text-sm text-neutral-500">Rendering...</p>}
          {previewError && <p className="text-sm text-red-600">{previewError}</p>}
          {preview && !previewLoading && !previewError && (
            <>
              {preview.subject && preview.subject !== '(no subject)' && (
                <p className="text-xs text-neutral-500 mb-2">
                  Subject: <span className="text-neutral-800 font-medium">{preview.subject}</span>
                </p>
              )}
              <pre className="whitespace-pre-wrap font-sans text-sm text-neutral-800 leading-relaxed">{preview.body_text}</pre>
            </>
          )}
          {spinError && <p className="mt-3 text-xs text-red-600">{spinError}</p>}
        </div>
      </section>

      {/* Count + Send */}
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide font-semibold text-neutral-500">
              {channel === 'mail' ? 'Will email' : channel === 'wa' ? 'Will WhatsApp' : 'Will send'}
            </p>
            {countsLoading && <p className="text-sm text-neutral-500 mt-1">Counting...</p>}
            {countsError && <p className="text-sm text-red-600 mt-1">{countsError}</p>}
            {counts && !countsLoading && !countsError && (
              <>
                <p className="text-sm text-neutral-700 mt-1">
                  <span className="text-2xl font-semibold text-neutral-900 mr-2">{expectedCount}</span>
                  {channel === 'both'
                    ? `message${expectedCount === 1 ? '' : 's'}`
                    : `recipient${expectedCount === 1 ? '' : 's'}`}
                </p>
                {/* Per-channel breakdown — honest about who gets it where. */}
                <p className="text-xs text-neutral-500 mt-1.5">
                  {channel !== 'wa' && <span>{mailWillSend} email</span>}
                  {channel === 'both' && <span className="text-neutral-300"> · </span>}
                  {channel !== 'mail' && <span>{waWillSend} WhatsApp</span>}
                  {' · '}
                  <span>{audienceTotal} vendor{audienceTotal === 1 ? '' : 's'} matched</span>
                </p>
                {/* Why the channel number is below the audience total. */}
                {unreachableOnChannel > 0 && (
                  <p className="text-xs text-amber-600 mt-1">
                    {unreachableOnChannel} of {audienceTotal} have no usable{' '}
                    {channel === 'mail' ? 'email' : 'WhatsApp number'}
                    {channel === 'mail' && counts.optout_count > 0 ? ' or have opted out' : ''} and will be skipped.
                  </p>
                )}
                {channel === 'wa' && counts.optout_count > 0 && (
                  <p className="text-xs text-neutral-400 mt-1">{counts.optout_count} email opt-outs (does not affect WhatsApp).</p>
                )}
              </>
            )}
          </div>
          <button type="button"
            disabled={sendDisabled}
            onClick={() => setConfirmOpen(true)}
            className="shrink-0 rounded-md bg-[#cd2653] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#b22149] transition-colors">
            Send broadcast
          </button>
        </div>

        {/* Over-cap guard — explain the server-side 500 refusal up front. */}
        {overCap && !countsLoading && !countsError && (
          <p className="mt-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            {audienceTotal} vendors match these filters, above the {AUDIENCE_CAP} per-send limit.
            Tighten the filters (status, sector, tier) or split the send before this can go out.
          </p>
        )}

        {/* Empty-state — a filter combo that matches nobody. */}
        {counts && !countsLoading && !countsError && expectedCount === 0 && !overCap && (
          <p className="mt-3 rounded-md bg-neutral-50 border border-neutral-200 px-3 py-2 text-xs text-neutral-600">
            {audienceTotal === 0
              ? 'No vendors match these filters. Loosen a filter to build an audience.'
              : `${audienceTotal} vendors match, but none have a usable ${channel === 'wa' ? 'WhatsApp number' : 'email'}. Switch channel or adjust filters.`}
          </p>
        )}
      </section>

      {result && (
        <section className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-5">
          <p className="font-medium text-emerald-900">Dispatch complete.</p>
          <ul className="mt-2 text-sm text-emerald-900 list-disc list-inside space-y-1">
            <li>Mail: {result.mail.sent} sent, {result.mail.failed} failed, {result.mail.skipped} skipped (of {result.mail.attempted}).</li>
            <li>WhatsApp: {result.wa.sent} sent, {result.wa.failed} failed, {result.wa.skipped} skipped (of {result.wa.attempted}).</li>
          </ul>
          {result.errors.length > 0 && (
            <details className="mt-3 text-sm text-emerald-900">
              <summary className="cursor-pointer">First {Math.min(result.errors.length, 5)} errors</summary>
              <ul className="mt-2 list-disc list-inside">
                {result.errors.slice(0, 5).map((e, i) => (
                  <li key={i}>{e.kind} → {e.to}: {e.error}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {sendError && (
        <section className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {sendError}
        </section>
      )}

      {/* Spin variants modal */}
      {spinVariants && spinVariants.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[80vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-neutral-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-neutral-900">Pick a spin</h3>
              <button type="button" onClick={() => setSpinVariants(null)}
                className="text-sm text-neutral-500 hover:text-neutral-800">Close</button>
            </div>
            <div className="p-6 space-y-4">
              {spinVariants.map((v, i) => (
                <div key={i} className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Variant {i + 1}</p>
                  <pre className="whitespace-pre-wrap font-sans text-sm text-neutral-800 leading-relaxed">{v}</pre>
                  <div className="mt-3 flex justify-end">
                    <button type="button" onClick={() => acceptSpin(v)}
                      className="rounded-md bg-[#cd2653] px-4 py-2 text-sm font-semibold text-white hover:bg-[#b22149]">
                      Use this
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-neutral-900">Confirm broadcast</h3>
            <p className="mt-2 text-sm text-neutral-600">
              You are about to send {mode === 'template' ? (
                <><strong className="text-neutral-900">{TEMPLATE_LABELS[templateKey]}</strong></>
              ) : (
                <><strong className="text-neutral-900">your custom message</strong></>
              )} via
              {' '}<strong className="text-neutral-900">
                {channel === 'mail' ? 'Email' : channel === 'wa' ? 'WhatsApp' : 'Email and WhatsApp'}
              </strong>.
            </p>
            {/* Exact, channel-honest breakdown of what fires. */}
            <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm text-neutral-700 space-y-1">
              {channel !== 'wa' && (
                <p><strong className="text-neutral-900">{mailWillSend}</strong> email{mailWillSend === 1 ? '' : 's'}</p>
              )}
              {channel !== 'mail' && (
                <p><strong className="text-neutral-900">{waWillSend}</strong> WhatsApp message{waWillSend === 1 ? '' : 's'}</p>
              )}
              {channel === 'both' && (
                <p className="text-xs text-neutral-500 pt-0.5 border-t border-neutral-200 mt-1.5">
                  {mailWillSend + waWillSend} messages total, deduped per channel.
                </p>
              )}
            </div>
            <p className="mt-3 text-xs text-neutral-500">
              This cannot be undone. Sends go through the throttled, idempotent dispatch path.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm font-medium text-neutral-700 rounded-md hover:bg-neutral-100">
                Cancel
              </button>
              <button type="button" onClick={send} disabled={sending}
                className="px-4 py-2 text-sm font-semibold text-white bg-[#cd2653] rounded-md hover:bg-[#b22149] disabled:opacity-50">
                {sending ? 'Sending...' : `Send ${expectedCount} now`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------- subcomponents ----------------

function BroadcastFilters({ filters, channel, setChannel, onChange, onClearAll }: {
  filters: Filters
  channel: Channel
  setChannel: (c: Channel) => void
  onChange: (patch: Partial<Filters>) => void
  onClearAll: () => void
}) {
  const activeChips: { key: string; label: string; clear: () => void }[] = []
  if (filters.status) {
    const lbl = STATUS_OPTIONS.find((o) => o.value === filters.status)?.label || filters.status
    activeChips.push({ key: 'st', label: `Status: ${lbl}`, clear: () => onChange({ status: '' }) })
  }
  if (filters.sector) {
    const lbl = SECTOR_OPTIONS.find((o) => o.value === filters.sector)?.label || filters.sector
    activeChips.push({ key: 'sec', label: `Sector: ${lbl}`, clear: () => onChange({ sector: '' }) })
  }
  if (filters.booth_tier) {
    const lbl = TIER_OPTIONS.find((o) => o.value === filters.booth_tier)?.label || filters.booth_tier
    activeChips.push({ key: 'tier', label: `Tier: ${lbl}`, clear: () => onChange({ booth_tier: '' }) })
  }
  if (filters.has_docs) {
    activeChips.push({ key: 'docs', label: `Docs: ${filters.has_docs === 'true' ? 'Yes' : 'No'}`, clear: () => onChange({ has_docs: '' }) })
  }
  if (filters.contract_signed) {
    activeChips.push({ key: 'ct', label: `Contract: ${filters.contract_signed === 'true' ? 'Yes' : 'No'}`, clear: () => onChange({ contract_signed: '' }) })
  }
  if (filters.paid) {
    activeChips.push({ key: 'paid', label: `Paid: ${filters.paid === 'true' ? 'Yes' : 'No'}`, clear: () => onChange({ paid: '' }) })
  }
  if (channel !== 'mail') {
    activeChips.push({
      key: 'ch',
      label: `Channel: ${channel === 'wa' ? 'WhatsApp' : 'Both'}`,
      clear: () => setChannel('mail'),
    })
  }
  const anyActive = activeChips.length > 0

  return (
    <div className="bg-white border border-neutral-200 rounded-xl p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-neutral-400 pr-1">Filter</span>

        <CompactSelect value={filters.status} onChange={(v) => onChange({ status: v })} options={STATUS_OPTIONS} />
        <CompactSelect value={filters.sector} onChange={(v) => onChange({ sector: v })} options={SECTOR_OPTIONS} />
        <CompactSelect value={filters.booth_tier} onChange={(v) => onChange({ booth_tier: v })} options={TIER_OPTIONS} />
        <CompactSelect
          value={filters.has_docs}
          onChange={(v) => onChange({ has_docs: v as '' | 'true' | 'false' })}
          options={[
            { value: '', label: 'Any docs' },
            { value: 'true', label: 'Docs complete' },
            { value: 'false', label: 'Docs missing' },
          ]}
        />
        <CompactSelect
          value={filters.contract_signed}
          onChange={(v) => onChange({ contract_signed: v as '' | 'true' | 'false' })}
          options={[
            { value: '', label: 'Any contract' },
            { value: 'true', label: 'Contract signed' },
            { value: 'false', label: 'Contract unsigned' },
          ]}
        />
        <CompactSelect
          value={filters.paid}
          onChange={(v) => onChange({ paid: v as '' | 'true' | 'false' })}
          options={[
            { value: '', label: 'Any paid' },
            { value: 'true', label: 'Stall fee paid' },
            { value: 'false', label: 'Stall fee unpaid' },
          ]}
        />
        <CompactSelect
          value={channel}
          onChange={(v) => setChannel(v as Channel)}
          options={[
            { value: 'mail', label: 'Email' },
            { value: 'wa', label: 'WhatsApp' },
            { value: 'both', label: 'Both' },
          ]}
        />

        {anyActive && (
          <button type="button" onClick={onClearAll}
            className="ml-auto text-xs text-neutral-500 hover:text-[#cd2653] underline">
            Clear all
          </button>
        )}
      </div>

      {anyActive && (
        <div className="mt-2 pt-2 border-t border-neutral-100 flex flex-wrap items-center gap-1.5">
          {activeChips.map((c) => (
            <button key={c.key} type="button" onClick={c.clear}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#cd2653] text-white text-[11px] font-medium hover:bg-[#b51f48] transition-colors">
              {c.label}
              <span aria-hidden className="text-white/70">×</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CompactSelect({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-neutral-200 bg-white px-2 pr-7 text-xs font-medium text-neutral-700 focus:outline-none focus:ring-2 focus:ring-[#cd2653]/30 focus:border-[#cd2653] hover:border-neutral-400 transition-colors appearance-none bg-no-repeat bg-[right_0.4rem_center] bg-[length:0.7em_0.7em] [background-image:url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2020%2020%27%20fill=%27%23737373%27%3E%3Cpath%20d=%27M5.23%207.21a.75.75%200%20011.06.02L10%2011.06l3.71-3.83a.75.75%200%20111.08%201.04l-4.25%204.39a.75.75%200%2001-1.08%200L5.21%208.27a.75.75%200%2001.02-1.06z%27/%3E%3C/svg%3E')]">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
