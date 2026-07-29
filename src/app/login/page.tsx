'use client'

// Force runtime SSR — page imports @supabase/ssr which throws at build time
// when NEXT_PUBLIC_SUPABASE_* env vars aren't in the preview environment.
// Same pattern as /exhibitor (deploy unblock 2026-06-13).
export const dynamic = 'force-dynamic'

import { useState } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@supabase/ssr'
import { Loader2, AlertCircle, LogIn } from 'lucide-react'
import { Logo } from '@/components/logo'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState('')

  // Defer client creation until the user actually submits — @supabase/ssr
  // throws on empty URL/key, so we cannot create it at component body
  // evaluation time during prerender when env vars aren't scoped to preview.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setState('loading')
    setError('')

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    )

    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (authError) {
      setError(authError.message)
      setState('error')
      return
    }

    // Announce the sign-in. This form signs in CLIENT-SIDE and never touches
    // /api/exhibitor/login, so it was the one vendor door that recorded nothing
    // at all. Sends no body: the route reads identity from the cookie just set
    // and the IP from the edge headers. Awaited so the request is not killed by
    // the navigation below, but never allowed to block the redirect.
    try {
      await fetch('/api/admin/login-log', { method: 'POST' })
    } catch { /* telemetry must never cost a vendor their login */ }

    // Redirect to exhibitor portal on success
    window.location.href = '/exhibitor'
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="bg-white border-b border-neutral-200">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/"><Logo size="md" showText={true} /></Link>
          <Link href="/register" className="text-sm text-[#cd2653] font-medium hover:underline">Create an account</Link>
        </div>
      </header>

      <main className="container mx-auto px-4 py-16">
        <div className="max-w-md mx-auto">
          <div className="text-center mb-8">
            <LogIn className="w-12 h-12 text-[#cd2653] mx-auto mb-3" />
            <h1 className="text-3xl font-bold text-neutral-900 mb-2">Exhibitor Login</h1>
            <p className="text-neutral-600">Access your exhibitor portal and manage your booth</p>
          </div>

          {state === 'error' && (
            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg mb-6">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-neutral-200 p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Email</label>
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
                className="w-full px-4 py-3 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent" placeholder="you@business.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Password</label>
              <input type="password" required value={password} onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-3 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent" placeholder="Your password" />
            </div>
            <button type="submit" disabled={state === 'loading'}
              className="w-full py-4 bg-[#cd2653] text-white font-semibold rounded-lg hover:bg-[#b82049] transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {state === 'loading' ? <><Loader2 className="w-5 h-5 animate-spin" /> Logging in...</> : 'Log In'}
            </button>
          </form>

          <p className="text-center text-sm text-neutral-500 mt-6">
            Don&apos;t have an account?{' '}
            <a href="/register" className="text-[#cd2653] font-medium hover:underline">Register as Exhibitor</a>
          </p>
        </div>
      </main>
    </div>
  )
}
