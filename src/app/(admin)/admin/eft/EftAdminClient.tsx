'use client'

// TEMPORARY EFT lane management (dev@cthalaal.co.za only). Global on/off, per
// vendor add/remove, proof review, and reconcile-to-paid. All actions hit the
// EFT admin routes (each re-checks operator + EFT admin email server-side).

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Check, X, Search, ExternalLink, CheckCircle2 } from 'lucide-react'

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
  reconciled: boolean
  proofs: Array<{ url: string; uploaded_at: string; note?: string }>
}
interface Candidate { id: string; business_name: string | null; contact_name: string | null; email: string | null }

const rand = (n: number | null) => (n === null ? 'TBC' : `R${n.toFixed(2)}`)
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '')

export default function EftAdminClient({ globalOn, bank, rows, candidates }: {
  globalOn: boolean
  bank: Bank
  rows: Row[]
  candidates: Candidate[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')

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

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return candidates
      .filter((c) => `${c.business_name || ''} ${c.contact_name || ''} ${c.email || ''}`.toLowerCase().includes(q))
      .slice(0, 8)
  }, [query, candidates])

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

      {/* Lane table */}
      <div className="rounded-2xl border border-[#E5DCC4] bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-[#E5DCC4] flex items-center justify-between">
          <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold">In the EFT lane ({rows.length})</p>
        </div>
        {rows.length === 0 ? (
          <p className="p-5 text-sm text-[#1B1A17]/55">No vendors in the lane yet. Turn on global mode, or add vendors above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[#1B1A17]/50 border-b border-[#E5DCC4]">
                  <th className="px-5 py-2 font-medium">Vendor</th>
                  <th className="px-3 py-2 font-medium">Owed</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Proof</th>
                  <th className="px-5 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F2EBD8] last:border-0 align-top">
                    <td className="px-5 py-3">
                      <p className="font-medium text-[#1B1A17]">{r.business_name || 'Unnamed'}</p>
                      <p className="text-xs text-[#1B1A17]/50">{r.contact_name || ''}{r.email ? ` · ${r.email}` : ''}{r.phone ? ` · ${r.phone}` : ''}</p>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">{rand(r.outstanding ?? r.amount)}</td>
                    <td className="px-3 py-3">
                      {r.reconciled ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> Reconciled</span>
                      ) : r.submitted ? (
                        <span className="text-[#1B1A17]"><span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1.5" />Proof uploaded {r.submitted_at ? fmtDate(r.submitted_at) : ''}</span>
                      ) : (
                        <span className="text-[#1B1A17]/50"><span className="inline-block w-2 h-2 rounded-full bg-neutral-300 mr-1.5" />Awaiting proof</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {r.proofs.length === 0 ? (
                        <span className="text-[#1B1A17]/40">None</span>
                      ) : (
                        <div className="space-y-1">
                          {r.proofs.map((p, i) => (
                            <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#cd2653] hover:underline">
                              <ExternalLink className="w-3 h-3" /> View {fmtDate(p.uploaded_at)}
                            </a>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {!r.reconciled && (
                          <button
                            onClick={() => { if (confirm(`Mark ${r.business_name || 'this vendor'} as PAID by EFT for ${rand(r.outstanding ?? r.amount)}? Do this only after the money has landed in the account.`)) post('/api/admin/eft/reconcile', { applicationId: r.id }, `rec-${r.id}`) }}
                            disabled={busy === `rec-${r.id}`}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                          >
                            {busy === `rec-${r.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Mark paid
                          </button>
                        )}
                        {r.marked && (
                          <button
                            onClick={() => post('/api/admin/eft/lane', { applicationId: r.id, action: 'remove' }, `rm-${r.id}`)}
                            disabled={busy === `rm-${r.id}`}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 hover:border-[#cd2653] hover:text-[#cd2653] px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                          >
                            {busy === `rm-${r.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />} Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
