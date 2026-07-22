'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Logo } from '@/components/logo'
import { Mail, Lock, AlertCircle, Loader2 } from 'lucide-react'

// Never surface a raw Supabase/browser error to the operator. Map the common
// cases to plain language. A backend/auth outage rejects with "Failed to fetch"
// (a browser TypeError) or an AuthRetryableFetchError; that must read as a
// try-again, not a cryptic bug (Samreen hit this when the auth service was down).
function friendlyAuthError(err: unknown): string {
  const raw = err && typeof err === 'object' && 'message' in err
    ? String((err as { message: unknown }).message)
    : String(err ?? '')
  const msg = raw.toLowerCase()
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout') || msg.includes('econn') || msg.includes('load failed')) {
    return "Can't reach the server right now. It may be briefly restarting, please wait a moment and try again."
  }
  if (msg.includes('invalid login') || msg.includes('invalid credentials') || msg.includes('email or password')) {
    return 'Incorrect email or password.'
  }
  if (msg.includes('email not confirmed')) return 'Please confirm your email address before signing in.'
  if (msg.includes('rate') && msg.includes('limit')) return 'Too many attempts. Please wait a minute and try again.'
  return 'Sign in did not work. Please try again, or contact the organizer if it keeps happening.'
}

export default function AdminLoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const notAdmin = searchParams.get('error') === 'not_admin'

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const supabase = createClient()
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (authError) {
        setError(friendlyAuthError(authError))
        setLoading(false)
        return
      }

      // Redirect to dashboard (layout will verify admin status)
      router.push('/admin')
      router.refresh()
    } catch (err) {
      // A network / auth-service outage rejects here (not via authError), e.g.
      // "Failed to fetch". Degrade gracefully instead of leaving the form stuck.
      setError(friendlyAuthError(err))
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-white">
      {/* editorial left rail, mirrors exhibitor login: festival photo behind crimson-tinted scrim */}
      <div className="hidden lg:flex flex-col justify-between p-12 text-white relative overflow-hidden">
        <Image src="/about/festival-crowd.jpg" alt="" fill priority sizes="50vw" className="object-cover object-center" />
        <div className="absolute inset-0 bg-[#140a0c]/78" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#140a0c]/95 via-[#140a0c]/45 to-[#140a0c]/85" />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(55% 45% at 12% 4%, rgba(205,38,83,0.38) 0%, transparent 60%)' }} />

        <Logo size="md" showText light className="relative z-10" />
        <div className="relative z-10">
          <p className="text-xs uppercase tracking-[0.25em] text-[#ff7a9c] font-semibold mb-4">Admin Portal</p>
          <h1 className="font-serif text-4xl leading-tight drop-shadow-sm">Festival operations command.</h1>
          <p className="text-white/75 mt-4 max-w-sm text-sm leading-relaxed">Vendor approvals, allocations, support, broadcast, all in one place. 11 to 13 December 2026.</p>
        </div>
        <p className="relative z-10 text-white/60 text-xs">Young at Heart Festival · Cape Town Halaal</p>
      </div>

      {/* form */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-8"><Logo size="md" showText /></div>
          <h2 className="text-2xl font-bold text-neutral-900">Admin sign in</h2>
          <p className="text-neutral-500 text-sm mt-1 mb-6">Sign in to manage applications, vendors, and festival operations.</p>

          {(error || notAdmin) && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                {notAdmin
                  ? 'Your account does not have admin access. Please contact the administrator.'
                  : error}
              </div>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="email" className="text-xs font-semibold text-neutral-600">Email</label>
              <div className="relative mt-1">
                <Mail className="w-4 h-4 text-neutral-400 absolute left-3 top-3.5" />
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-neutral-200 pl-9 pr-3 py-3 text-sm outline-none focus:border-[#cd2653] focus:ring-2 focus:ring-[#cd2653]/20"
                  placeholder="admin@example.com"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="text-xs font-semibold text-neutral-600">Password</label>
              <div className="relative mt-1">
                <Lock className="w-4 h-4 text-neutral-400 absolute left-3 top-3.5" />
                <input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-neutral-200 pl-9 pr-3 py-3 text-sm outline-none focus:border-[#cd2653] focus:ring-2 focus:ring-[#cd2653]/20"
                  placeholder="Your password"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-lg py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-60 transition-colors"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <p className="text-neutral-500 text-sm mt-6">
            Need access? Contact the event organizer.
          </p>
        </div>
      </div>
    </div>
  )
}
