'use client'

import { Suspense, useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { Logo } from '@/components/logo'
import { Mail, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-neutral-50" />}>
      <ForgotPassword />
    </Suspense>
  )
}

function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [sends, setSends] = useState(0)
  // Seconds until another request is allowed. The success screen had NO resend
  // control at all, so a vendor whose email had not arrived yet could only
  // reload the page and submit again: on 2026-07-27 one did exactly that 70
  // seconds later, and got two links. The server allows 3 per email per 10
  // minutes, so nothing was blocked, it was just invisible. Give them a real
  // button and a visible wait instead of leaving them to improvise.
  const [cooldown, setCooldown] = useState(0)
  const [errFromCallback, setErrFromCallback] = useState<string | null>(null)
  const sp = useSearchParams()

  useEffect(() => {
    if (cooldown <= 0) return
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(id)
  }, [cooldown])

  useEffect(() => {
    const err = sp?.get('err')
    if (err) setErrFromCallback(err)
  }, [sp])

  /** One send path, used by the form and by Resend, so the cooldown cannot be
   *  sidestepped by going back to the form. */
  async function send() {
    if (loading || cooldown > 0) return
    setLoading(true)
    try {
      await fetch('/api/exhibitor/send-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
    } catch {
      // swallow — always show success so we never leak which emails exist
    }
    setSent(true); setLoading(false); setErrFromCallback(null)
    setSends((n) => n + 1)
    setCooldown(60)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    send()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><Logo size="md" showText /></div>
        <div className="bg-white border border-neutral-200 rounded-2xl p-7">
          {sent ? (
            <div className="text-center">
              <div className="w-11 h-11 rounded-xl bg-green-100 text-green-600 flex items-center justify-center mx-auto mb-4"><CheckCircle2 className="w-5 h-5" /></div>
              <h2 className="text-xl font-bold text-neutral-900">Check your inbox</h2>
              <p className="text-neutral-500 text-sm mt-2">
                If an exhibitor account exists for <b>{email}</b>, a reset link is on its way. It can take a minute to arrive, and it expires in 1 hour.
              </p>
              <p className="text-neutral-500 text-sm mt-2">
                Not there? Check your spam or promotions folder before asking for another one.
              </p>

              {/* The trap this whole screen exists to close: each new link
                  supersedes the last, so a vendor who requests twice and then
                  opens the FIRST email gets "invalid or expired" and concludes
                  the portal is broken. */}
              {sends > 1 && (
                <p className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                  You have asked for {sends} links. Please use the <b>most recent</b> email, the earlier links may no longer work.
                </p>
              )}

              <button
                onClick={send}
                disabled={cooldown > 0 || loading}
                className="mt-5 w-full rounded-lg border border-neutral-200 py-2.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
              >
                {loading ? 'Sending…' : cooldown > 0 ? `You can request another in ${cooldown}s` : 'Send another link'}
              </button>

              <a href="/exhibitor/login" className="inline-block mt-4 text-sm font-semibold text-[#cd2653]">← Back to sign in</a>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-bold text-neutral-900">Reset password</h2>
              <p className="text-neutral-500 text-sm mt-1 mb-5">Enter your email and we will send a reset link.</p>

              {errFromCallback && (
                <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2 text-sm text-amber-800">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {errFromCallback}
                </div>
              )}

              <form onSubmit={onSubmit} className="space-y-3">
                <div className="relative">
                  <Mail className="w-4 h-4 text-neutral-400 absolute left-3 top-3.5" />
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.co.za"
                    className="w-full rounded-lg border border-neutral-200 pl-9 pr-3 py-3 text-sm outline-none focus:border-[#cd2653] focus:ring-2 focus:ring-[#cd2653]/20" />
                </div>
                <button disabled={loading || cooldown > 0}
                  className="w-full bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-lg py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-60 transition-colors">
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {loading ? 'Sending…' : cooldown > 0 ? `Wait ${cooldown}s` : 'Send reset link'}
                </button>
              </form>
              <a href="/exhibitor/login" className="inline-block mt-4 text-sm text-neutral-500 hover:text-[#cd2653]">← Back to sign in</a>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
