'use client'

// TEMPORARY EFT lane (Yoco-outage side-channel). Shown INSTEAD of the Yoco card
// PaymentPanel to vendors an operator has put in the EFT lane (⟦EFT⟧ marker).
// The vendor sees CTH's bank details, pays by EFT, and uploads their proof (or
// emails support). On submit the portal flips to a PROVISIONAL "payment received,
// pending confirmation" state and unlocks. No em-dashes anywhere (Law 7).

import { useState, useRef, useEffect } from 'react'
import {
  Building2, Upload, Loader2, CheckCircle2, Info, Mail, Copy, Check, Eye, AlertTriangle, Clock,
} from 'lucide-react'
import { EFT_TERMS, EFT_TERMS_HEADING } from '@/lib/eft-terms'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

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
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-white/10 last:border-0">
      <span className="text-sm text-white/60">{label}</span>
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-semibold text-white break-all">{value}</span>
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
  submitted, bank, reference, amount, dueDate, businessName, purpose = 'stall',
}: {
  submitted: boolean
  bank: Bank | null
  reference: string
  amount: number | null
  dueDate: string
  businessName: string
  /** 'accessories' = the split-bill accessory-electricity balance of a vendor
   *  whose stall fee is already settled. Same rail, -ACC reference, copy that
   *  does not promise a portal unlock (theirs is already unlocked). */
  purpose?: 'stall' | 'accessories'
}) {
  const forAccessories = purpose === 'accessories'
  const feeNoun = forAccessories ? 'accessory electricity balance' : 'stall fee'
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  // Bank details start hidden behind a reveal button. Revealing them is a strong
  // "about to pay by EFT" signal, so the click pings the operator (and seals the
  // vendor off the festival owner's inbox server-side). A vendor who has already
  // submitted a proof has clearly seen the details, so show them unhidden.
  const [revealed, setRevealed] = useState(submitted)
  const [showProofPrompt, setShowProofPrompt] = useState(false)
  const uploadRef = useRef<HTMLDivElement>(null)

  // Show the proof-of-payment prompt 3 seconds after the vendor reveals the bank
  // details, every time they reveal them. This keeps the instruction tied to the
  // moment they actually have the details in front of them, and it comes back on
  // every fresh reveal so the message is not missed.
  useEffect(() => {
    if (!revealed || submitted) return
    const t = setTimeout(() => setShowProofPrompt(true), 3000)
    return () => clearTimeout(t)
  }, [revealed, submitted])

  function revealDetails() {
    setRevealed(true)
    // Fire-and-forget: the heads-up to the operator must never block the reveal.
    fetch('/api/exhibitor/eft-intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose }) }).catch(() => {})
  }

  function scrollToUpload() {
    setShowProofPrompt(false)
    uploadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function submit() {
    if (!file) { setError('Please choose your proof of payment first.'); return }
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('purpose', purpose)
      if (note.trim()) fd.append('note', note.trim())
      const res = await fetch('/api/exhibitor/eft-proof', { method: 'POST', body: fd })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Upload failed')
      setSuccess(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  function onSuccessClose() {
    // Reload so the server flips the page to the provisional "received" state.
    window.location.reload()
  }

  return (
    <div className="space-y-6">
      {/* Reminder popup shown 3 seconds after the vendor reveals the bank details.
          It repeats every time they re-open the details, so the instruction is
          never buried. Uploading proof on this page is the fastest path to the
          finance team; emailing or messaging individual team members slows it down. */}
      <Dialog open={showProofPrompt} onOpenChange={setShowProofPrompt}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload your proof of payment here</DialogTitle>
            <DialogDescription>
              Once you have paid, upload your proof on this page so our finance team can confirm it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-neutral-700">
            <p>
              <span className="font-semibold text-[#cd2653]">Upload your proof of payment here.</span>{' '}
              This is the only way your payment is tracked and sent to the finance team.
            </p>
            <p>
              If you cannot upload here, you can also email your proof to{' '}
              <a href="mailto:support@youngatheart.co.za" className="font-semibold underline">support@youngatheart.co.za</a>.{' '}
              Uploading on this page is confirmed fastest.
            </p>
            <p>
              If you cannot upload here at all, email{' '}
              <a href="mailto:support@youngatheart.co.za" className="font-semibold underline">support@youngatheart.co.za</a>.{' '}
              Uploads are confirmed faster.
            </p>
            <p>
              Use reference <span className="font-semibold">{reference}</span> when you pay, so we can match it to {businessName}.
            </p>
          </div>
          <DialogFooter className="flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button variant="outline" onClick={() => setShowProofPrompt(false)}>
              I will upload later
            </Button>
            <Button onClick={scrollToUpload} className="bg-[#cd2653] hover:bg-[#b01f45] text-white">
              Upload proof now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Success confirmation shown immediately after a successful upload. */}
      <Dialog open={success} onOpenChange={onSuccessClose}>
        <DialogContent className="sm:max-w-md text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-2">
            <CheckCircle2 className="w-7 h-7" />
          </div>
          <DialogHeader>
            <DialogTitle>Proof received, thank you</DialogTitle>
            <DialogDescription>
              {forAccessories
                ? 'Please allow up to 24 hours for our team to confirm your payment. Once confirmed, your accessories will show as paid here. You do not need to do anything else in the meantime.'
                : 'Please allow up to 24 hours for our team to confirm your payment and contact you. Once we have confirmed it, we will mark you as paid and your full portal will unlock so you can continue. You do not need to do anything else in the meantime.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-center">
            <Button onClick={onSuccessClose} className="bg-[#cd2653] hover:bg-[#b01f45] text-white">
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Provisional confirmation once a proof is on file. */}
      {submitted && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 flex items-start gap-4 text-emerald-800">
          <CheckCircle2 className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Proof received, thank you</p>
            <p className="text-sm mt-1 opacity-90">
              {forAccessories
                ? 'Please allow up to 24 hours for our team to confirm your payment. Once confirmed, your accessories will show as paid here. You do not need to do anything else in the meantime.'
                : 'Please allow up to 24 hours for our team to confirm your payment and contact you. Once we have confirmed it, we will mark you as paid and your full portal will unlock so you can continue. You do not need to do anything else in the meantime.'}
            </p>
          </div>
        </div>
      )}

      {/* Channel notice: which channels we actually receive. The "WhatsApp that
          number only / personal chats will not be answered" discouragement was
          removed 2026-08-26 on Taona's instruction for the full-EFT cutover. */}
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3 text-amber-800">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <p className="text-sm">
          Please pay your {feeNoun} by EFT using the details below and upload your proof of payment on this page. To reach us, use your portal inbox, email{' '}
          <a href="mailto:support@youngatheart.co.za" className="font-semibold underline">support@youngatheart.co.za</a>, or WhatsApp us on{' '}
          <a href="https://wa.me/27659435012" className="font-semibold underline whitespace-nowrap">065 943 5012</a>. Your payment status updates here on your portal.
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
      <div className="rounded-2xl p-4 sm:p-6 border bg-[#1a1416] border-[#1a1416] text-white">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center bg-white/10 text-[#ff7a9c] shrink-0">
            <Building2 className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm text-white/60">{forAccessories ? 'Pay accessories by EFT' : 'Pay by EFT'}</p>
            <p className="text-xl sm:text-2xl font-bold text-white truncate">
              {amount ? `R${amount.toFixed(2)} due` : 'Amount pending'}
            </p>
            <p className="text-sm text-white/60 mt-0.5 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              Payable by <span className="text-white/90 font-medium">{dueDate}</span>
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
              onClick={revealDetails}
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
      <div ref={uploadRef} className="relative bg-white border border-neutral-200 rounded-2xl p-4 sm:p-6 overflow-hidden">
        <p className="font-semibold text-neutral-900 mb-1">{submitted ? 'Upload another proof' : 'Upload your proof of payment'}</p>
        <p className="text-sm text-neutral-500 mb-4">
          Attach your EFT confirmation or bank slip (PDF or image, up to 10MB). Uploading here is the fastest way for us to confirm your payment.
        </p>
        {error && <div className="p-3 mb-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
          disabled={busy}
          onChange={(e) => { setFile(e.target.files?.[0] || null); setError(null) }}
          className="block w-full text-sm text-neutral-600 mb-3 file:mr-3 file:rounded-lg file:border-0 file:bg-[#cd2653]/10 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-[#cd2653] hover:file:bg-[#cd2653]/15 disabled:opacity-60"
        />
        <textarea
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (date paid, amount, who paid)"
          rows={2}
          className="block w-full text-sm rounded-lg border border-neutral-200 p-3 mb-3 focus:border-[#cd2653] focus:outline-none disabled:opacity-60"
        />
        <button
          onClick={submit}
          disabled={busy || !file}
          className="w-full sm:w-auto bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-lg px-5 py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {submitted ? 'Upload another proof' : 'Submit proof of payment'}
        </button>

        {/* Uploading overlay — keeps the vendor informed and prevents double submits. */}
        {busy && (
          <div className="absolute inset-0 z-10 bg-white/80 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center p-6 text-center">
            <Loader2 className="w-8 h-8 text-[#cd2653] animate-spin mb-3" />
            <p className="font-semibold text-neutral-900">Uploading your proof...</p>
            <p className="text-sm text-neutral-500 mt-1">Hold tight, this should only take a few seconds.</p>
          </div>
        )}
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
