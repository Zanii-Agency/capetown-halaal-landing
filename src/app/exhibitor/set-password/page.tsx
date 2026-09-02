'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Logo } from '@/components/logo'
import { Lock, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'

export default function SetPassword() {
  const router = useRouter()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [accept, setAccept] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sessionReady, setSessionReady] = useState<null | boolean>(null)

  // Bootstrap: confirm a session exists before we let her try to set a password.
  // Three paths get her here with a session:
  //   1) PKCE flow: /auth/callback already exchanged ?code= and set sb-* cookies.
  //   2) Implicit/hash flow: Supabase put #access_token=...&refresh_token=... in the URL
  //      hash. We parse and call setSession.
  //   3) She was already logged in (rare for this flow but harmless).
  // Without ANY of those, we show an actionable error instead of a dead submit button.
  useEffect(() => {
    const supabase = createClient()
    let cancelled = false

    async function boot() {
      // Try hash flow first (legacy / implicit) — only if it's actually present.
      if (typeof window !== 'undefined' && window.location.hash.includes('access_token')) {
        const hash = new URLSearchParams(window.location.hash.slice(1))
        const access_token = hash.get('access_token')
        const refresh_token = hash.get('refresh_token')
        if (access_token && refresh_token) {
          const { error } = await supabase.auth.setSession({ access_token, refresh_token })
          if (!cancelled) {
            if (error) {
              setError('Reset link expired or invalid. Please request a fresh email below.')
              setSessionReady(false)
            } else {
              // Strip the hash so refresh doesn't re-process it
              window.history.replaceState(null, '', window.location.pathname)
              setSessionReady(true)
              // ANNOUNCE. setSession establishes a real session, so this page is
              // a login door in its own right, and it was silent. A source guard
              // in login-announce.test.ts found it after four others had already
              // been fixed by hand, which is the whole argument for the guard.
              fetch('/api/admin/login-log', { method: 'POST' }).catch(() => {})
            }
            return
          }
        }
      }

      // Otherwise check existing session (PKCE flow already handled it)
      const { data, error } = await supabase.auth.getSession()
      if (cancelled) return
      if (error || !data.session) {
        setError('Your reset link has expired or this page was opened without a valid link. Please request a fresh email below.')
        setSessionReady(false)
      } else {
        setSessionReady(true)
      }
    }
    boot()
    return () => { cancelled = true }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pw !== pw2) { setError('Passwords do not match.'); return }
    if (!accept) { setError('Please accept the exhibitor terms to continue.'); return }
    setLoading(true)
    const supabase = createClient()
    const { error: e1 } = await supabase.auth.updateUser({
      password: pw,
      data: { must_change_password: false, terms_accepted_at: new Date().toISOString() },
    })
    if (e1) { setError(e1.message); setLoading(false); return }
    router.push('/exhibitor/portal'); router.refresh()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><Logo size="md" showText /></div>
        <div className="bg-white border border-neutral-200 rounded-2xl p-7">
          <div className="w-11 h-11 rounded-xl bg-[#cd2653]/10 text-[#cd2653] flex items-center justify-center mb-4"><Lock className="w-5 h-5" /></div>
          <h2 className="text-xl font-bold text-neutral-900">Set your password</h2>
          <p className="text-neutral-500 text-sm mt-1 mb-5">Choose a password you will use to sign in from now on.</p>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />{error}
            </div>
          )}

          {sessionReady === null && (
            <div className="flex items-center justify-center py-6 text-neutral-500 text-sm gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Verifying your reset link...
            </div>
          )}

          {sessionReady === false && (
            <div className="space-y-3">
              <Link href="/exhibitor/forgot"
                className="block w-full bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-lg py-3 text-sm text-center transition-colors">
                Request a fresh reset email
              </Link>
              <Link href="/exhibitor/login" className="block text-xs text-center text-neutral-500 hover:text-neutral-700">
                Back to login
              </Link>
            </div>
          )}

          {sessionReady === true && (
            <form onSubmit={onSubmit} className="space-y-3">
              <input type="password" required value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password"
                className="w-full rounded-lg border border-neutral-200 px-3 py-3 text-sm outline-none focus:border-[#cd2653] focus:ring-2 focus:ring-[#cd2653]/20" />
              <input type="password" required value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Confirm password"
                className="w-full rounded-lg border border-neutral-200 px-3 py-3 text-sm outline-none focus:border-[#cd2653] focus:ring-2 focus:ring-[#cd2653]/20" />
              <label className="flex items-start gap-2 text-xs text-neutral-600 py-1">
                <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 accent-[#cd2653]" />
                I accept the exhibitor terms and the festival rules for Young at Heart 2026.
              </label>
              <button disabled={loading}
                className="w-full bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-lg py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-60 transition-colors">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}{loading ? 'Saving...' : 'Save & enter portal'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
