'use client'

// TEMPORARY EFT lane management (dev@cthalaal.co.za only). Global on/off, per
// vendor add/remove, proof review, and reconcile-to-paid. All actions hit the
// EFT admin routes (each re-checks operator + EFT admin email server-side).

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Check, X, Search, ExternalLink, CheckCircle2, ChevronDown } from 'lucide-react'

interface Bank { accountName: string; bank: string; accountNumber: string; branchCode: string; accountType?: string }
interface Row {
  id: string
  business_name: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  amount: number | null
  outstanding: number | null
  submitted: boolean
  submitted_at: string | null
  marked: boolean
  collected: boolean       // EFT money marked collected (interim); awaiting Yoco settlement
  reconciled: boolean
  proofs: Array<{ url: string; uploaded_at: string; note?: string }>
  added_at?: string | null
  added_by?: string | null
}
interface Candidate { id: string; business_name: string | null; contact_name: string | null; email: string | null }


/** The date this row last MOVED: proof upload if there is one, else the recorded
 *  submission time. Drives both the Date column and the sort, so the lane reads
 *  newest-activity-first instead of in whatever order the query returned. */
function laneDate(r: { submitted_at?: string | null; proofs: Array<{ uploaded_at: string }> }): string | null {
  const newestProof = r.proofs.map((p) => p.uploaded_at).sort().at(-1) ?? null
  return newestProof || r.submitted_at || null
}
const rand = (n: number | null) =>
  n === null ? 'TBC' : `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false }) : '')
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '')

export default function EftAdminClient({ globalOn, bank, rows, candidates, excluded }: {
  globalOn: boolean
  bank: Bank
  rows: Row[]
  candidates: Candidate[]
  excluded: Candidate[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [exQuery, setExQuery] = useState('')
  const [excludedOpen, setExcludedOpen] = useState(false)

  // Newest activity first. The lane arrived in query order, so a proof uploaded
  // this morning could sit below one from three weeks ago.
  const sortedRows = [...rows].sort((a, b) => {
    // Rows that do not count toward the money sink to the bottom, so the top of
    // the table is only real vendors.
    if (isDemo(a) !== isDemo(b)) return isDemo(a) ? 1 : -1
    const da = laneDate(a), dbb = laneDate(b)
    if (!da && !dbb) return (a.business_name || '').localeCompare(b.business_name || '')
    if (!da) return 1          // nothing has happened on this one yet: bottom
    if (!dbb) return -1
    return new Date(dbb).getTime() - new Date(da).getTime()
  })

  // Owed per state. `outstanding ?? amount` is the same value the row renders,
  // so the totals can never disagree with the column above them.
  // Demo rows stay VISIBLE (Taona: "hide ... from this list tho keep it on the
  // list") but are excluded from every total. R7,500 of fake vendor was sitting
  // inside a R44,250 "Total owed" on a payments screen.
  const isDemo = (r: Row) =>
    /@cthalaal\.co\.za$/i.test(r.email || '') || /\bdemo\b/i.test(r.business_name || '')
  const owed = (r: Row) => r.outstanding ?? r.amount ?? 0
  const totals = rows.filter((r) => !isDemo(r)).reduce(
    (acc, r) => {
      const v = owed(r)
      acc.total += v
      if (r.reconciled) acc.reconciled += v
      else if (r.collected) acc.collected += v
      else if (r.submitted) acc.submitted += v
      else acc.awaiting += v
      return acc
    },
    { total: 0, collected: 0, submitted: 0, awaiting: 0, reconciled: 0 },
  )

  async function post(url: string, body: unknown, key: string) {
    setBusy(key); setErr(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Action failed')
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  // Settle a collected vendor through Yoco: create a checkout, then open it so the
  // operator can pay it with their card. Status flips to real paid via the webhook.
  async function settle(id: string) {
    setBusy(`set-${id}`); setErr(null)
    try {
      const res = await fetch('/api/admin/eft/settle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ applicationId: id }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.url) throw new Error(j.error || 'Could not start settlement')
      window.open(j.url as string, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start settlement')
    } finally {
      setBusy(null)
    }
  }

  const filterCandidates = (q: string) => {
    const term = q.trim().toLowerCase()
    if (!term) return [] as Candidate[]
    return candidates
      .filter((c) => `${c.business_name || ''} ${c.contact_name || ''} ${c.email || ''}`.toLowerCase().includes(term))
      .slice(0, 8)
  }
  const matches = useMemo(() => filterCandidates(query), [query, candidates]) // eslint-disable-line react-hooks/exhaustive-deps
  const exMatches = useMemo(() => filterCandidates(exQuery), [exQuery, candidates]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6">
      {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</div>}

      {/* Global switch + bank reference */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[#E5DCC4] bg-white p-5">
          <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold mb-3">Global EFT mode</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-[#1B1A17]">
                {globalOn ? 'ON. Every vendor sees EFT details, Yoco is hidden.' : 'OFF. Only vendors you add below are on EFT.'}
              </p>
              <p className="text-xs text-[#1B1A17]/50 mt-1">
                While on, all vendor emails and WhatsApp route to the Messages tab, off the main inbox.
              </p>
            </div>
            <button
              onClick={() => post('/api/admin/eft/mode', { on: !globalOn }, 'mode')}
              disabled={busy === 'mode'}
              className={`shrink-0 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${globalOn ? 'bg-[#cd2653] hover:bg-[#b01f45]' : 'bg-emerald-600 hover:bg-emerald-700'}`}
            >
              {busy === 'mode' ? <Loader2 className="w-4 h-4 animate-spin" /> : globalOn ? <X className="w-4 h-4" /> : <Check className="w-4 h-4" />}
              {globalOn ? 'Turn OFF' : 'Turn ON for all vendors'}
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-[#E5DCC4] bg-white p-5">
          <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold mb-3">Bank details shown to vendors</p>
          <div className="text-sm text-[#1B1A17] space-y-1">
            <div className="flex justify-between"><span className="text-[#1B1A17]/55">Account name</span><span className="font-semibold">{bank.accountName}</span></div>
            <div className="flex justify-between"><span className="text-[#1B1A17]/55">Bank</span><span className="font-semibold">{bank.bank}</span></div>
            <div className="flex justify-between"><span className="text-[#1B1A17]/55">Account number</span><span className="font-semibold">{bank.accountNumber}</span></div>
            <div className="flex justify-between"><span className="text-[#1B1A17]/55">Branch code</span><span className="font-semibold">{bank.branchCode}</span></div>
          </div>
        </div>
      </div>

      {/* Add a specific vendor */}
      <div className="rounded-2xl border border-[#E5DCC4] bg-white p-5">
        <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold mb-3">Add a vendor to the EFT lane</p>
        <div className="relative">
          <Search className="w-4 h-4 text-[#1B1A17]/40 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by business, contact, or email"
            className="w-full text-sm rounded-lg border border-neutral-200 pl-9 pr-3 py-2.5 focus:border-[#cd2653] focus:outline-none"
          />
          {matches.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-lg border border-neutral-200 bg-white shadow-lg overflow-hidden">
              {matches.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { setQuery(''); post('/api/admin/eft/lane', { applicationId: c.id, action: 'add' }, `add-${c.id}`) }}
                  disabled={busy === `add-${c.id}`}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-[#F2EBD8]/60 flex items-center justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-[#1B1A17]">{c.business_name || 'Unnamed'}</span>
                    <span className="text-[#1B1A17]/50"> · {c.email || c.contact_name || ''}</span>
                  </span>
                  {busy === `add-${c.id}` && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Exclude a vendor from EFT (handle manually) */}
      <div className="rounded-2xl border border-[#E5DCC4] bg-white p-5">
        <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold mb-1">Exclude a vendor from EFT</p>
        <p className="text-xs text-[#1B1A17]/50 mb-3">They never see EFT (even with global mode on) and stay on the main inbox for a person to handle. Use for NPOs and vendors you deal with directly.</p>
        <div className="relative">
          <Search className="w-4 h-4 text-[#1B1A17]/40 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={exQuery}
            onChange={(e) => setExQuery(e.target.value)}
            placeholder="Search by business, contact, or email"
            className="w-full text-sm rounded-lg border border-neutral-200 pl-9 pr-3 py-2.5 focus:border-[#cd2653] focus:outline-none"
          />
          {exMatches.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-lg border border-neutral-200 bg-white shadow-lg overflow-hidden">
              {exMatches.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { setExQuery(''); post('/api/admin/eft/lane', { applicationId: c.id, action: 'exclude' }, `ex-${c.id}`) }}
                  disabled={busy === `ex-${c.id}`}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-[#F2EBD8]/60 flex items-center justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-[#1B1A17]">{c.business_name || 'Unnamed'}</span>
                    <span className="text-[#1B1A17]/50"> · {c.email || c.contact_name || ''}</span>
                  </span>
                  {busy === `ex-${c.id}` && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Collapsed by default. Eleven permanently-excluded vendors is reference
            data you set once and rarely revisit, and stacked open it pushed the
            lane table itself off the screen. */}
        {excluded.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setExcludedOpen((o) => !o)}
              aria-expanded={excludedOpen}
              className="w-full flex items-center gap-2 rounded-lg border border-[#F2EBD8] bg-[#FBF8F0] px-3 py-2.5 text-left hover:bg-[#F7F1E3] transition-colors"
            >
              <ChevronDown className={`w-4 h-4 shrink-0 text-[#1B1A17]/40 transition-transform ${excludedOpen ? 'rotate-180' : ''}`} />
              <span className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold">
                Excluded from EFT ({excluded.length})
              </span>
              <span className="ml-auto text-xs text-[#1B1A17]/40">
                {excludedOpen ? 'Hide' : 'Show'}
              </span>
            </button>
          </div>
        )}
        {excluded.length > 0 && excludedOpen && (
          <div className="mt-2 space-y-2 max-h-72 overflow-y-auto pr-1">
            {excluded.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-[#F2EBD8] px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-[#1B1A17]">{c.business_name || 'Unnamed'}</span>
                  <span className="text-[#1B1A17]/50"> · {c.email || c.contact_name || ''}</span>
                </span>
                <button
                  onClick={() => post('/api/admin/eft/lane', { applicationId: c.id, action: 'unexclude' }, `unex-${c.id}`)}
                  disabled={busy === `unex-${c.id}`}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 hover:border-[#cd2653] hover:text-[#cd2653] px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                >
                  {busy === `unex-${c.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />} Un-exclude
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Lane table */}
      <div className="rounded-2xl border border-[#E5DCC4] bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-[#E5DCC4] flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold">In the EFT lane ({rows.length})</p>
          {/* Money at a glance. The table listed seven amounts and left the
              operator adding them up by eye, which is the one thing a payment
              screen must never ask (Taona 2026-07-27: "we should have total to
              easily keep track"). Split three ways, because the states mean very
              different things: collected is money we HAVE but have not settled
              through Yoco, awaiting is money still outside. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs tabular-nums">
            <span className="text-[#1B1A17]/55">Collected <span className="font-semibold text-amber-700">{rand(totals.collected)}</span></span>
            <span className="text-[#1B1A17]/55">Proof in <span className="font-semibold text-[#1B1A17]">{rand(totals.submitted)}</span></span>
            <span className="text-[#1B1A17]/55">Awaiting <span className="font-semibold text-[#1B1A17]/70">{rand(totals.awaiting)}</span></span>
            <span className="text-[#1B1A17]/70 border-l border-[#E5DCC4] pl-5">Total owed <span className="font-bold text-[#1B1A17]">{rand(totals.total)}</span></span>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="p-5 text-sm text-[#1B1A17]/55">No vendors in the lane yet. Turn on global mode, or add vendors above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[#1B1A17]/50 border-b border-[#E5DCC4]">
                  <th className="px-5 py-2 font-medium">Vendor</th>
                  <th className="px-3 py-2 font-medium text-right">Owed</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Added to lane</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Date</th>
                  <th className="px-3 py-2 font-medium">Proof</th>
                  <th className="px-5 py-2 font-medium text-right w-[240px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F2EBD8] last:border-0 align-top">
                    <td className="px-5 py-3">
                      <p className="font-medium text-[#1B1A17]">
                        {r.business_name || 'Unnamed'}
                        {isDemo(r) && <span className="ml-2 align-middle rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-neutral-100 text-[#1B1A17]/45">demo, not counted</span>}
                      </p>
                      <p className="text-xs text-[#1B1A17]/50">{r.contact_name || ''}{r.email ? ` · ${r.email}` : ''}{r.phone ? ` · ${r.phone}` : ''}</p>
                    </td>
                    <td className={`px-3 py-3 whitespace-nowrap text-right tabular-nums ${isDemo(r) ? 'text-[#1B1A17]/35 line-through' : 'font-medium'}`}>{rand(r.outstanding ?? r.amount)}</td>
                    <td className="px-3 py-3">
                      {r.reconciled ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> Reconciled</span>
                      ) : r.collected ? (
                        <span className="text-[#1B1A17]"><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1.5" />Collected (EFT), settle via Yoco</span>
                      ) : r.submitted ? (
                        <span className="text-[#1B1A17]"><span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1.5" />Proof uploaded {r.submitted_at ? fmtDate(r.submitted_at) : ''}</span>
                      ) : (
                        <span className="text-[#1B1A17]/50"><span className="inline-block w-2 h-2 rounded-full bg-neutral-300 mr-1.5" />Awaiting proof</span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {r.added_at ? (
                        <>
                          <span className="text-[#1B1A17]/70">{fmtDate(r.added_at)}</span>
                          <span className="block text-xs text-[#1B1A17]/45">
                            {fmtTime(r.added_at)}{r.added_by ? ` · ${r.added_by.split('@')[0]}` : ''}
                          </span>
                        </>
                      ) : (
                        // Honest gap: the audit that should have recorded this
                        // was writing to a non-existent column inside a silent
                        // catch, so nothing before 2026-07-27 exists to show.
                        <span className="text-[#1B1A17]/40" title="Added before lane changes were being recorded">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-[#1B1A17]/70">
                      {laneDate(r) ? fmtDate(laneDate(r) as string) : <span className="text-[#1B1A17]/40">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      {r.proofs.length === 0 ? (
                        <span className="text-[#1B1A17]/40">None</span>
                      ) : (
                        <div className="space-y-1">
                          {r.proofs.map((p, i) => (
                            <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#cd2653] hover:underline">
                              <ExternalLink className="w-3 h-3" /> View{r.proofs.length > 1 ? ` ${i + 1}` : ''}
                            </a>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 align-middle">
                      {/* Two fixed-width slots, never a flow row: Remove is absent on
                          most rows, and in a justify-end flow that pulled the primary
                          button right by Remove's width, so the primary buttons never
                          formed a straight column down the table. Both slots keep their
                          width whether or not they hold a button. */}
                      <div className="flex items-center justify-end gap-2 flex-nowrap whitespace-nowrap">
                        <div className="w-[152px] shrink-0">
                          {/* Not yet collected + not paid: mark the EFT money collected
                              (interim). Vendor sees paid + acknowledged; NOT counted in
                              finance until settled via Yoco. */}
                          {!r.reconciled && !r.collected && (
                            <button
                              onClick={() => { if (confirm(`Mark ${r.business_name || 'this vendor'} as EFT COLLECTED for ${rand(r.outstanding ?? r.amount)}? They will see PAID and be acknowledged, but this is NOT final until you settle it via Yoco. Do this only after the EFT money has landed.`)) post('/api/admin/eft/reconcile', { applicationId: r.id }, `rec-${r.id}`) }}
                              disabled={busy === `rec-${r.id}`}
                              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap disabled:opacity-60"
                            >
                              {busy === `rec-${r.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Mark collected
                            </button>
                          )}
                          {/* Collected but not yet settled: pay it through Yoco (opens a
                              checkout the operator pays; webhook flips it to real paid). */}
                          {!r.reconciled && r.collected && (
                            <button
                              onClick={() => { if (confirm(`Settle ${r.business_name || 'this vendor'} through Yoco for ${rand(r.outstanding ?? r.amount)}? This opens a Yoco checkout you pay on your card (Yoco fee applies), funded by the EFT cash. It records the real payment and notifies Samreen.`)) settle(r.id) }}
                              disabled={busy === `set-${r.id}`}
                              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap disabled:opacity-60"
                            >
                              {busy === `set-${r.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />} Settle via Yoco
                            </button>
                          )}
                        </div>
                        <div className="w-8 shrink-0">
                          {r.marked && (
                            <button
                              onClick={() => post('/api/admin/eft/lane', { applicationId: r.id, action: 'remove' }, `rm-${r.id}`)}
                              disabled={busy === `rm-${r.id}`}
                              aria-label={`Remove ${r.business_name || 'this vendor'} from the EFT lane`}
                              title="Remove from the EFT lane"
                              className="w-8 h-8 inline-flex items-center justify-center rounded-lg border border-neutral-200 text-[#1B1A17]/60 hover:border-[#cd2653] hover:text-[#cd2653] disabled:opacity-60"
                            >
                              {busy === `rm-${r.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#E5DCC4] bg-[#FBF8F0]">
                  <td className="px-5 py-3 font-semibold text-[#1B1A17]">
                    {sortedRows.filter((r) => !isDemo(r)).length} vendor{sortedRows.filter((r) => !isDemo(r)).length === 1 ? '' : 's'}
                    {sortedRows.some(isDemo) && <span className="ml-1 font-normal text-[#1B1A17]/40">+ demo</span>}
                  </td>
                  <td className="px-3 py-3 font-bold text-[#1B1A17] whitespace-nowrap text-right tabular-nums">{rand(totals.total)}</td>
                  <td className="px-3 py-3" colSpan={5} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
