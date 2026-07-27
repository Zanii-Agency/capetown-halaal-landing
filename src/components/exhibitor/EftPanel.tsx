'use client'

// TEMPORARY EFT lane (Yoco-outage side-channel). Shown INSTEAD of the Yoco card
// PaymentPanel to vendors an operator has put in the EFT lane (⟦EFT⟧ marker).
// The vendor sees CTH's bank details, pays by EFT, and uploads their proof (or
// emails support). On submit the portal flips to a PROVISIONAL "payment received,
// pending confirmation" state and unlocks. No em-dashes anywhere (Law 7).

import { useState } from 'react'
import {
  Building2, Upload, Loader2, CheckCircle2, Info, Mail, Copy, Check, Eye, AlertTriangle,
} from 'lucide-react'
import { EFT_TERMS, EFT_TERMS_HEADING } from '@/lib/eft-terms'

interface Bank {
  accountName: string
  bank: string
  accountNumber: string
  branchCode: string
  accountType?: string
}

function Row({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-white/10 last:border-0">
      <span className="text-sm text-white/60">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-sm font-semibold text-white">{value}</span>
        <button
          type="button"
          onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          className="text-white/50 hover:text-white transition-colors"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </span>
    </div>
  )
}

export default function EftPanel({
  submitted, bank, reference, amount, businessName,
}: {
  submitted: boolean
  bank: Bank | null
  reference: string
  amount: number | null
  businessName: string
}) {
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bank details start hidden behind a reveal button. Revealing them is a strong
  // "about to pay by EFT" signal, so the click pings the operator (and seals the
  // vendor off the festival owner's inbox server-side). A vendor who has already
  // submitted a proof has clearly seen the details, so show them unhidden.
  const [revealed, setRevealed] = useState(submitted)

  function reveal() {
    setRevealed(true)
    // Fire-and-forget: the heads-up to the operator must never block the reveal.
    fetch('/api/exhibitor/eft-intent', { method: 'POST' }).catch(() => {})
  }

  async function submit() {
    if (!file) { setError('Please choose your proof of payment first.'); return }
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (note.trim()) fd.append('note', note.trim())
      const res = await fetch('/api/exhibitor/eft-proof', { method: 'POST', body: fd })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Upload failed')
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Provisional confirmation once a proof is on file. */}
      {submitted && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 flex items-start gap-4 text-emerald-800">
          <CheckCircle2 className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Proof received, thank you</p>
            <p className="text-sm mt-1 opacity-90">
              Please allow up to 24 hours for our team to confirm your payment and contact you. Once we have confirmed it, we will mark you as paid and your full portal will unlock so you can continue. You do not need to do anything else in the meantime.
            </p>
          </div>
        </div>
      )}

      {/* Channel notice: which channels we actually receive. */}
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3 text-amber-800">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        {/* Vendors were WhatsApping organisers they happen to know personally and
            then waiting on a reply that was never coming, because only the
            official line is monitored and logged. Naming the number, and saying
            plainly that a personal chat will not be answered, is the whole point
            of this notice (Taona, 2026-07-27). */}
        <p className="text-sm">
          Please pay your stall fee by EFT using the details below and upload your proof of payment. To reach us, use your portal inbox, email{' '}
          <a href="mailto:support@youngatheart.co.za" className="font-semibold underline">support@youngatheart.co.za</a>, or WhatsApp our official number{' '}
          <a href="https://wa.me/27659435012" className="font-semibold underline whitespace-nowrap">065 943 5012</a>.{' '}
          <span className="font-semibold">Please WhatsApp that number only.</span> Messages sent to any other number, including someone from the team you know personally, will not be answered and will not reach us. We also cannot see or reply to messages on social media. Your payment status updates here on your portal.
        </p>
      </div>

      {/* EFT terms disclaimer. Full payment only, no part payments, fake POP reported. */}
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-rose-900">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <p className="font-bold text-sm">{EFT_TERMS_HEADING}</p>
        </div>
        <ul className="space-y-1.5 text-sm">
          {EFT_TERMS.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Bank details. */}
      <div className="rounded-2xl p-6 border bg-[#1a1416] border-[#1a1416] text-white">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-white/10 text-[#ff7a9c]">
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm text-white/60">Pay by EFT</p>
            <p className="text-2xl font-bold text-white">
              {amount ? `R${amount.toFixed(2)} due` : 'Amount pending'}
            </p>
          </div>
        </div>
        {bank ? (
          revealed ? (
            <div>
              <Row label="Account name" value={bank.accountName} />
              <Row label="Bank" value={bank.bank} />
              <Row label="Account number" value={bank.accountNumber} />
              <Row label="Branch code" value={bank.branchCode} />
              {bank.accountType && <Row label="Account type" value={bank.accountType} />}
              <Row label="Reference" value={reference} />
              <p className="text-xs text-white/50 mt-3">
                Use <span className="font-semibold text-white/80">{reference}</span> as your payment reference so we can match your payment to {businessName}.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={reveal}
              className="w-full rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 transition-colors px-5 py-4 text-left flex items-center gap-3"
            >
              <span className="w-9 h-9 rounded-lg flex items-center justify-center bg-white/10 text-[#ff7a9c] shrink-0">
                <Eye className="w-4 h-4" />
              </span>
              <span>
                <span className="block text-sm font-semibold text-white">Show bank details to pay</span>
                <span className="block text-xs text-white/55 mt-0.5">Tap to reveal the account number and your payment reference.</span>
              </span>
            </button>
          )
        ) : (
          <p className="text-sm text-white/70 flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            Please email support@youngatheart.co.za for our EFT banking details and quote reference {reference}.
          </p>
        )}
      </div>

      {/* Upload proof. */}
      <div className="bg-white border border-neutral-200 rounded-2xl p-6">
        <p className="font-semibold text-neutral-900 mb-1">{submitted ? 'Upload another proof' : 'Upload your proof of payment'}</p>
        <p className="text-sm text-neutral-500 mb-4">
          Attach your EFT confirmation or bank slip (PDF or image, up to 10MB). You can also email it to{' '}
          <a href="mailto:support@youngatheart.co.za" className="underline hover:text-neutral-700">support@youngatheart.co.za</a>.
        </p>
        {error && <div className="p-3 mb-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
          onChange={(e) => { setFile(e.target.files?.[0] || null); setError(null) }}
          className="block w-full text-sm text-neutral-600 mb-3 file:mr-3 file:rounded-lg file:border-0 file:bg-[#cd2653]/10 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-[#cd2653] hover:file:bg-[#cd2653]/15"
        />
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (date paid, amount, who paid)"
          rows={2}
          className="block w-full text-sm rounded-lg border border-neutral-200 p-3 mb-3 focus:border-[#cd2653] focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={busy || !file}
          className="bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-lg px-5 py-3 text-sm flex items-center gap-2 disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {submitted ? 'Upload another proof' : 'Submit proof of payment'}
        </button>
      </div>

      {/* Support fallback. */}
      <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-5">
        <p className="text-sm text-neutral-700 flex items-start gap-2">
          <Mail className="w-4 h-4 text-[#cd2653] mt-0.5 shrink-0" />
          Any trouble paying? Email <a href="mailto:support@youngatheart.co.za" className="font-semibold text-[#cd2653] underline">support@youngatheart.co.za</a> and we will help you.
        </p>
      </div>
    </div>
  )
}
