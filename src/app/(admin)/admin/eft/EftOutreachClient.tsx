'use client'

// EFT Outreach composer. The EFT admin reaches the whole master-lane cohort over
// WhatsApp + email from one place. It reuses the existing /api/admin/chase route
// (which the EFT admin is not lane-blocked on) rather than adding a second sender,
// so em-dash scrubbing, mail/wa logging into the EFT Messages inbox, per-vendor
// event trail, rate limiting and the template allowlist are all inherited.
//
// The audience is computed server-side as onEftLane vendors, intersected with the
// Samreen wall (a subset of what
// the inbox wall already hides from Samreen), so nothing composed here can reach
// her. Sends are chunked to the route's 200-recipient cap.

import { useMemo, useState } from 'react'

export interface OutreachVendor {
  id: string
  business_name: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  stall: string | null
}

type Channel = 'both' | 'mail' | 'wa'

type ChaseResult = {
  audience_total: number
  mail: { attempted: number; sent: number; failed: number; skipped: number }
  wa: { attempted: number; sent: number; failed: number; skipped: number }
  dry_run: boolean
  errors: Array<{ kind: 'mail' | 'wa'; to: string; error: string }>
}

const CHUNK = 200 // matches CHASE_MAX_RECIPIENTS in the chase route

const card = 'rounded-2xl border border-[#E5DCC4] bg-white'
const input =
  'w-full rounded-lg border border-[#E5DCC4] bg-[#FBF7ED] px-3 py-2 text-sm text-[#1B1A17] ' +
  'placeholder:text-[#1B1A17]/35 focus:outline-none focus:border-[#cd2653]'

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export default function EftOutreachClient({ vendors }: { vendors: OutreachVendor[] }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(vendors.map((v) => v.id)))
  const [channel, setChannel] = useState<Channel>('both')
  const [subject, setSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [waBody, setWaBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<(ChaseResult & { dry: boolean }) | null>(null)
  const [error, setError] = useState<string | null>(null)

  const chosen = useMemo(() => vendors.filter((v) => selected.has(v.id)), [vendors, selected])
  const withEmail = useMemo(() => chosen.filter((v) => v.email).length, [chosen])
  const withPhone = useMemo(() => chosen.filter((v) => v.phone).length, [chosen])

  const wantMail = channel === 'both' || channel === 'mail'
  const wantWa = channel === 'both' || channel === 'wa'
  const needsEmailCopy = wantMail && (!subject.trim() || !emailBody.trim())
  const needsWaCopy = wantWa && !waBody.trim()
  const canSend = chosen.length > 0 && !busy && !needsEmailCopy && !needsWaCopy

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const allSelected = selected.size === vendors.length
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(vendors.map((v) => v.id)))
  }

  async function run(dry: boolean) {
    if (!canSend) return
    if (!dry) {
      const parts = [
        wantMail ? `email ${withEmail}` : '',
        wantWa ? `WhatsApp ${withPhone}` : '',
      ].filter(Boolean).join(' + ')
      if (!window.confirm(`Send to ${parts}? This messages real vendors and cannot be unsent.`)) return
    }
    setBusy(true)
    setError(null)
    setResult(null)

    const recipients = chosen.map((v) => ({
      id: v.id,
      email: v.email,
      phone: v.phone,
      name: v.contact_name,
      business_name: v.business_name,
      stall: v.stall,
    }))

    const agg: ChaseResult & { dry: boolean } = {
      audience_total: 0,
      mail: { attempted: 0, sent: 0, failed: 0, skipped: 0 },
      wa: { attempted: 0, sent: 0, failed: 0, skipped: 0 },
      dry_run: dry,
      dry,
      errors: [],
    }

    try {
      for (const group of chunk(recipients, CHUNK)) {
        const res = await fetch('/api/admin/chase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            recipients: group,
            channel,
            email_subject: subject,
            email_body: emailBody,
            wa_body: waBody,
            // Deliver WhatsApp via the UNPAID EFT-cohort UTILITY template, not the
            // marketing-capped general_announcement default. Until Meta approves
            // master_lane_update the WA send fails observably (logged), never the
            // silent 0/1000 cap.
            wa_template: 'master_lane_update',
            dry_run: dry,
          }),
        })
        const json = await res.json()
        if (!res.ok) {
          setError(json?.hint || json?.error || `chase failed (${res.status})`)
          setBusy(false)
          return
        }
        agg.audience_total += json.audience_total || 0
        for (const k of ['attempted', 'sent', 'failed', 'skipped'] as const) {
          agg.mail[k] += json.mail?.[k] || 0
          agg.wa[k] += json.wa?.[k] || 0
        }
        if (Array.isArray(json.errors)) agg.errors.push(...json.errors)
      }
      setResult(agg)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* Composer */}
      <div className="space-y-4">
        <div className={`${card} p-5`}>
          <h2 className="font-serif text-lg text-[#1B1A17] mb-1">Reach the master lane</h2>
          <p className="text-sm text-[#1B1A17]/55 mb-4">
            {vendors.length} vendors on the master lane. These show unpaid to Samreen and never receive the
            automated pay reminder, so this is where you chase them. Merge tags:{' '}
            <code className="text-[#cd2653]">{'{{first_name}}'}</code>{' '}
            <code className="text-[#cd2653]">{'{{business_name}}'}</code>{' '}
            <code className="text-[#cd2653]">{'{{stall_code}}'}</code>.
          </p>

          <div className="inline-flex rounded-lg border border-[#E5DCC4] overflow-hidden mb-4">
            {(['both', 'mail', 'wa'] as Channel[]).map((c) => (
              <button
                key={c}
                onClick={() => setChannel(c)}
                className={`px-4 py-1.5 text-sm font-semibold ${channel === c ? 'bg-[#cd2653] text-white' : 'bg-white text-[#1B1A17]/60 hover:text-[#1B1A17]'}`}
              >
                {c === 'both' ? 'Email + WhatsApp' : c === 'mail' ? 'Email only' : 'WhatsApp only'}
              </button>
            ))}
          </div>

          {wantMail && (
            <div className="space-y-2 mb-4">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#1B1A17]/55">Email</label>
              <input
                className={input}
                placeholder="Subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              <textarea
                className={`${input} min-h-[160px] resize-y`}
                placeholder={'Hi {{first_name}},\n\nWrite your message here. No em-dashes (they are scrubbed automatically).'}
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
              />
            </div>
          )}

          {wantWa && (
            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#1B1A17]/55">WhatsApp</label>
              <textarea
                className={`${input} min-h-[120px] resize-y`}
                placeholder={'Short WhatsApp message. Sent via the approved announcement template.'}
                value={waBody}
                onChange={(e) => setWaBody(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => run(true)}
            disabled={!canSend}
            className="px-4 py-2 rounded-lg text-sm font-semibold border border-[#cd2653] text-[#cd2653] disabled:opacity-40 hover:bg-[#cd2653]/5"
          >
            {busy ? 'Working...' : 'Preview (dry run)'}
          </button>
          <button
            onClick={() => run(false)}
            disabled={!canSend}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-[#cd2653] text-white disabled:opacity-40 hover:bg-[#b71f48]"
          >
            Send to {chosen.length}
          </button>
          {(needsEmailCopy || needsWaCopy) && (
            <span className="text-xs text-[#1B1A17]/45">
              {needsEmailCopy ? 'Add a subject and email body. ' : ''}
              {needsWaCopy ? 'Add a WhatsApp message.' : ''}
            </span>
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-[#cd2653]/30 bg-[#cd2653]/5 px-4 py-3 text-sm text-[#cd2653]">
            {error}
          </div>
        )}

        {result && (
          <div className={`${card} p-5`}>
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="font-serif text-base text-[#1B1A17]">
                {result.dry ? 'Dry run' : 'Sent'} · {result.audience_total} recipients
              </h3>
              {result.dry && <span className="text-[11px] text-[#1B1A17]/45">nothing was sent</span>}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl bg-[#FBF7ED] border border-[#E5DCC4] px-4 py-3">
                <div className="text-xs text-[#1B1A17]/55 mb-1">Email</div>
                <div className="text-[#1B1A17]">
                  {result.dry ? `${result.mail.attempted} would send` : `${result.mail.sent} sent`}
                  {result.mail.failed ? `, ${result.mail.failed} failed` : ''}
                  {result.mail.skipped ? `, ${result.mail.skipped} skipped` : ''}
                </div>
              </div>
              <div className="rounded-xl bg-[#FBF7ED] border border-[#E5DCC4] px-4 py-3">
                <div className="text-xs text-[#1B1A17]/55 mb-1">WhatsApp</div>
                <div className="text-[#1B1A17]">
                  {result.dry ? `${result.wa.attempted} would send` : `${result.wa.sent} sent`}
                  {result.wa.failed ? `, ${result.wa.failed} failed` : ''}
                  {result.wa.skipped ? `, ${result.wa.skipped} skipped` : ''}
                </div>
              </div>
            </div>
            {result.errors.length > 0 && (
              <details className="mt-3">
                <summary className="text-xs text-[#cd2653] cursor-pointer">{result.errors.length} errors</summary>
                <ul className="mt-2 space-y-1 text-xs text-[#1B1A17]/70 max-h-40 overflow-auto">
                  {result.errors.slice(0, 50).map((e, i) => (
                    <li key={i}>
                      <span className="font-mono">{e.kind}</span> {e.to}: {e.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Audience */}
      <div className={`${card} p-4 h-fit lg:sticky lg:top-4`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm font-semibold text-[#1B1A17]">{chosen.length} selected</div>
            <div className="text-[11px] text-[#1B1A17]/45">{withEmail} email · {withPhone} WhatsApp</div>
          </div>
          <button onClick={toggleAll} className="text-xs font-semibold text-[#cd2653] hover:underline">
            {allSelected ? 'Clear' : 'Select all'}
          </button>
        </div>
        <ul className="space-y-1 max-h-[520px] overflow-auto pr-1">
          {vendors.map((v) => (
            <li key={v.id}>
              <label className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[#FBF7ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(v.id)}
                  onChange={() => toggle(v.id)}
                  className="mt-0.5 accent-[#cd2653]"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-[#1B1A17] truncate">{v.business_name || v.contact_name || 'Vendor'}</span>
                  <span className="block text-[11px] text-[#1B1A17]/45 truncate">
                    {[v.stall, v.email, v.phone].filter(Boolean).join(' · ') || 'no contact'}
                  </span>
                </span>
              </label>
            </li>
          ))}
          {vendors.length === 0 && (
            <li className="text-sm text-[#1B1A17]/45 px-2 py-4">No vendors on the master lane right now.</li>
          )}
        </ul>
      </div>
    </div>
  )
}
