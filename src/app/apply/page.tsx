'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Loader2, CheckCircle, AlertCircle, ArrowRight, ArrowLeft, Upload, Building2, User, ShoppingBag, Zap, FileText } from 'lucide-react'
import { track } from '@/components/analytics-tracker'
import { Logo } from '@/components/logo'

// Single source of truth for the 8 public sectors. Mirrors the cards on
// the homepage SectorsSection + /sectors/[slug] map + /api/sectors/[slug].
// "Other" was dropped 2026-06-08 because it created a category-mismatch
// trap (vendor applies, never lands in any sector listing).
const ITEM_CATEGORIES = [
  'Food & Beverage',
  'Fashion & Modest Wear',
  'Beauty & Wellness',
  'Health & Pharmacy',
  'Travel & Tourism',
  'Home & Living',
  'Finance & Services',
  'Business & Trade',
]

const STALL_OPTIONS = [
  { value: 'marquee-table-2x2', label: 'MARQUEE Table Space, 2m x 2m', price: 3700, bands: 2 },
  { value: 'marquee-full-3x3', label: 'MARQUEE Full Space, 3m x 3m', price: 6500, bands: 3 },
  { value: 'marquee-table-double-4x2', label: 'MARQUEE Table Space Double, 4m x 2m', price: 6500, bands: 4 },
  { value: 'marquee-full-double-6x3', label: 'MARQUEE Full Space Double, 6m x 3m', price: 12000, bands: 6 },
  { value: 'outdoor-bedouin-2x3', label: 'OUTDOOR Bedouin Tent Space, 2m x 3m', price: 3750, bands: 2 },
  { value: 'food-gazebo-3x3', label: 'Food Stall (GAZEBO ONLY), 3m x 3m', price: 4800, bands: 3 },
  { value: 'mini-dessert-truck-3.5m', label: 'Mini Dessert Truck (MAX 3.5m)', price: 5000, bands: 3 },
  { value: 'food-truck-4.5m', label: 'Food Truck/Space (MAX 4.5m)', price: 6500, bands: 4 },
  { value: 'food-truck-6m', label: 'Food Truck/Space (MAX 6m)', price: 7500, bands: 5 },
  { value: 'food-truck-8m', label: 'Food Truck/Space (MAX 8m)', price: 8500, bands: 6 },
  { value: 'advertising', label: 'Advertising (Price depends on proposal)', price: 0, bands: 0 },
]

const ELECTRICAL_OPTIONS = [
  { value: 'none', label: 'None', price: 0 },
  { value: 'charger-lighting', label: 'Charger/Lighting', price: 400 },
  { value: 'microwave', label: 'Microwave', price: 400 },
  { value: 'urn', label: 'Urn', price: 500 },
  { value: 'single-fryer', label: 'Single Fryer', price: 500 },
  { value: 'double-fryer', label: 'Double Fryer', price: 800 },
  { value: 'waffle-pancake-maker', label: 'Waffle/Pancake Maker', price: 500 },
  { value: 'blender', label: 'Blender', price: 400 },
  { value: 'coffee-machine', label: 'Coffee Machine', price: 750 },
  { value: 'electric-stove', label: 'Electric Stove', price: 750 },
  { value: 'small-display-fridge', label: 'Small Display Fridge', price: 400 },
  { value: 'large-display-fridge-freezer', label: 'Large Display Fridge/Freezer', price: 600 },
]

const STEPS = [
  { id: 1, title: 'Business Info', icon: Building2 },
  { id: 2, title: 'Stall Selection', icon: ShoppingBag },
  { id: 3, title: 'Requirements', icon: Zap },
  { id: 4, title: 'Documents & Terms', icon: FileText },
]

type FormState = 'idle' | 'submitting' | 'success' | 'error'

// Save-draft: form contents are persisted to localStorage on every change so
// vendors who bail mid-flow can resume within 14 days. Cleared on submit.
const DRAFT_KEY = 'cth_apply_draft'
const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000

// Forgiving phone: accepts spaces, dashes, parens, +. Server strips non-digits
// and runs the SA mobile regex. UI just gives feedback after blur.
const SA_MOBILE_RE = /^(\+?27|0)[1-9]\d{8}$/
const stripPhone = (raw: string) => raw.replace(/[^\d+]/g, '')
const isValidPhone = (v: string) => SA_MOBILE_RE.test(stripPhone(v))

// Tolerant email pattern. RFC-perfect validation lives server-side.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const isValidEmail = (v: string) => EMAIL_RE.test(v.trim())

const INITIAL_FORM = {
  // Step 1: Business Info
  email: '',
  item_category: '',
  stall_brand_name: '',
  business_description: '',
  traded_before: '',
  contact_person: '',
  whatsapp_number: '',
  social_media_links: '',
  // Step 2: Stall Selection
  stall_type: '',
  // Step 3: Requirements
  hired_chairs: '0',
  hired_tables: '0',
  electrical_appliances: {} as Record<string, number>,
  appliance_details: '',
  uses_gas: '',
  // Step 4: Documents & Terms
  accepts_cancellation: false,
  accepts_terms: false,
  accepts_comms: false,
}

export default function ApplyPage() {
  const [step, setStep] = useState(1)
  const [formState, setFormState] = useState<FormState>('idle')
  const [error, setError] = useState('')
  // Honeypot: hidden field bots auto-fill, humans never see. Submission silently dropped if non-empty.
  const [companyWebsiteUrl, setCompanyWebsiteUrl] = useState('')
  // Draft banner: shown once on mount if a recent draft exists.
  const [draftBanner, setDraftBanner] = useState<{ ts: number } | null>(null)
  // Inline-validation tracking. A field only shows red after it has been
  // blurred once so the form does not yell at someone still typing.
  const [touched, setTouched] = useState<Record<string, boolean>>({})

  const [form, setForm] = useState(INITIAL_FORM)

  // Hydrate draft on mount. Surfaces a banner; user opts in to restore so we
  // never silently clobber a fresh attempt.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { ts: number; form: typeof INITIAL_FORM }
      if (!parsed || typeof parsed.ts !== 'number' || !parsed.form) return
      if (Date.now() - parsed.ts > DRAFT_TTL_MS) {
        window.localStorage.removeItem(DRAFT_KEY)
        return
      }
      setDraftBanner({ ts: parsed.ts })
    } catch {
      // ignore corrupt draft
    }
  }, [])

  // Save draft on every field change. Debounced via microtask: cheap enough
  // (one JSON.stringify of a small object) that no real debounce is needed.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (formState === 'success') return
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), form }))
    } catch {
      // localStorage can throw in private mode; the form still works without it.
    }
  }, [form, formState])

  const restoreDraft = () => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { ts: number; form: typeof INITIAL_FORM }
      if (parsed?.form) setForm({ ...INITIAL_FORM, ...parsed.form })
    } catch {}
    setDraftBanner(null)
  }

  const discardDraft = () => {
    if (typeof window !== 'undefined') {
      try { window.localStorage.removeItem(DRAFT_KEY) } catch {}
    }
    setDraftBanner(null)
  }

  // Track step changes
  useEffect(() => {
    track('apply_step', { metadata: { step, step_name: STEPS[step - 1]?.title } })
  }, [step])

  const set = (field: string, value: string | boolean | string[] | Record<string, number>) => {
    setForm(f => ({ ...f, [field]: value }))
  }
  const markTouched = (field: string) => setTouched(t => ({ ...t, [field]: true }))

  const setApplianceQty = (val: string, qty: number) => {
    if (val === 'none') {
      set('electrical_appliances', qty > 0 ? { none: 1 } : {})
      return
    }
    const current = { ...form.electrical_appliances }
    delete current['none']
    if (qty <= 0) {
      delete current[val]
    } else {
      current[val] = qty
    }
    set('electrical_appliances', current)
  }

  const selectedStall = STALL_OPTIONS.find(s => s.value === form.stall_type)
  const electricalCost = Object.entries(form.electrical_appliances).reduce((sum, [key, qty]) => {
    const opt = ELECTRICAL_OPTIONS.find(e => e.value === key)
    return sum + (opt?.price || 0) * qty
  }, 0)
  const totalEstimate = (selectedStall?.price || 0) + electricalCost

  // 2026-06-14: required-field surface cut to the 5 the festival actually needs
  // to start a conversation. Everything else (description, traded_before, socials,
  // stall_type, electrical, gas) is optional now and required to approve. Samreen
  // chases low-completeness applications via the queue.
  const canProceed = () => {
    if (step === 1) {
      return (
        form.stall_brand_name.trim() !== '' &&
        form.contact_person.trim() !== '' &&
        isValidPhone(form.whatsapp_number) &&
        isValidEmail(form.email) &&
        form.item_category !== ''
      )
    }
    if (step === 2) return true // stall_type optional
    if (step === 3) return true // appliances + gas optional
    if (step === 4) return form.accepts_cancellation && form.accepts_terms && form.accepts_comms
    return false
  }

  // 5 hard requirements + however many optional the vendor has filled so far.
  // Drives the inline "X of 5 required complete" strip under the step header.
  const requiredFilled = [
    form.stall_brand_name.trim() !== '',
    form.contact_person.trim() !== '',
    isValidPhone(form.whatsapp_number),
    isValidEmail(form.email),
    form.item_category !== '',
  ].filter(Boolean).length

  const handleSubmit = async () => {
    setFormState('submitting')
    setError('')
    track('apply_submit', { metadata: { stall_type: form.stall_type, category: form.item_category } })

    try {
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_website_url: companyWebsiteUrl, // honeypot
          business_name: form.stall_brand_name,
          business_description: form.business_description,
          product_categories: [form.item_category],
          contact_name: form.contact_person,
          email: form.email,
          phone: form.whatsapp_number,
          preferred_booth_tier: form.stall_type,
          special_requirements: JSON.stringify({
            traded_before: form.traded_before,
            social_media: form.social_media_links,
            stall_type: selectedStall?.label,
            stall_price: selectedStall?.price,
            electrical_appliances: Object.entries(form.electrical_appliances).map(([k, v]) => {
              const opt = ELECTRICAL_OPTIONS.find(e => e.value === k)
              return `${v}x ${opt?.label || k} (R${(opt?.price || 0) * v})`
            }).join(', '),
            appliance_details: form.appliance_details,
            uses_gas: form.uses_gas,
            total_estimate: totalEstimate,
          }),
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Submission failed')
      // Submit succeeded: clear the saved draft so a future visit lands clean.
      if (typeof window !== 'undefined') {
        try { window.localStorage.removeItem(DRAFT_KEY) } catch {}
      }
      setFormState('success')
      track('apply_success', { metadata: { business: form.stall_brand_name } })
    } catch (err) {
      // Submit failure recovery: never clear field values, never collapse the
      // form to a blank state. Keep the user where they were, show the reason,
      // let them retry.
      setFormState('error')
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  if (formState === 'success') {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-neutral-900 mb-2">Application received</h1>
          <p className="text-neutral-600 mb-4">Thank you for applying to trade at Young at Heart Festival 2026.</p>

          <div className="bg-white border border-neutral-200 rounded-lg p-4 mb-4 text-left">
            <p className="text-sm font-semibold text-neutral-900 mb-2">What happens next</p>
            <ol className="text-sm text-neutral-600 space-y-1.5 list-decimal list-inside">
              <li>The selection committee reviews your application within 7 to 10 days.</li>
              <li>If anything is missing, our team will reach out on WhatsApp or email.</li>
              <li>If accepted, you receive exhibitor portal login details to choose your booth, pay, and sign the terms.</li>
            </ol>
          </div>

          {totalEstimate > 0 && (
            <p className="text-sm font-medium text-neutral-700 mb-4">Estimated total: R{totalEstimate.toLocaleString()}</p>
          )}

          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6">
            <p className="text-xs text-amber-800">Check your inbox for a confirmation email. If you don&apos;t see it, check your spam or junk folder and mark it as &quot;not spam&quot;.</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            <Link href="/" className="inline-block px-6 py-3 bg-[#cd2653] text-white font-medium rounded-lg hover:bg-[#b82049] transition-colors">
              Back to festival home
            </Link>
            <a href="https://youngatheart.co.za" className="inline-block px-6 py-3 bg-white text-neutral-700 border border-neutral-200 font-medium rounded-lg hover:bg-neutral-50 transition-colors">
              Young at Heart 2026
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/"><Logo size="md" showText={true} /></Link>
          <span className="text-sm text-neutral-500">Step {step} of 4</span>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          {/* Header */}
          <div className="text-center mb-6">
            <h1 className="text-2xl md:text-3xl font-bold text-neutral-900 mb-2">Vendor Application</h1>
            <p className="text-neutral-500 text-sm">Young at Heart Festival 2026 · Dec 11-13 · Youngsfield Military Base</p>
          </div>

          {/* Progress */}
          <div className="flex items-center justify-between mb-8 px-2">
            {STEPS.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2 flex-1">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 transition-colors ${
                  step > s.id ? 'bg-green-500 text-white' : step === s.id ? 'bg-[#cd2653] text-white' : 'bg-neutral-200 text-neutral-500'
                }`}>
                  {step > s.id ? <CheckCircle className="w-4 h-4" /> : s.id}
                </div>
                <span className={`text-xs font-medium hidden sm:block ${step === s.id ? 'text-neutral-900' : 'text-neutral-400'}`}>{s.title}</span>
                {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-2 ${step > s.id ? 'bg-green-500' : 'bg-neutral-200'}`} />}
              </div>
            ))}
          </div>

          {/* Draft banner: surfaced once on mount if a recent draft exists. */}
          {draftBanner && (
            <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg mb-6">
              <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-blue-900 font-medium mb-1">We saved your progress.</p>
                <p className="text-xs text-blue-700 mb-3">Continue where you left off, or start over with a blank form.</p>
                <div className="flex gap-2">
                  <button type="button" onClick={restoreDraft} className="px-3 py-1.5 text-xs font-medium bg-[#cd2653] text-white rounded-md hover:bg-[#b82049] transition-colors">Continue</button>
                  <button type="button" onClick={discardDraft} className="px-3 py-1.5 text-xs font-medium bg-white text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 transition-colors">Start fresh</button>
                </div>
              </div>
            </div>
          )}

          {/* Required-completion strip. Halves perceived form length: people see
              there are only 5 things they actually need to enter to apply. */}
          <div className="mb-6 px-4 py-3 bg-white border border-neutral-200 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-neutral-700">{requiredFilled} of 5 required fields complete</span>
              <span className="text-xs text-neutral-400">Everything else is optional</span>
            </div>
            <div className="h-1.5 bg-neutral-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#cd2653] transition-all duration-300"
                style={{ width: `${(requiredFilled / 5) * 100}%` }}
              />
            </div>
          </div>

          {/* Sticky error banner: stays on screen on submit failure so the
              vendor sees why their submit failed. Field values are preserved. */}
          {formState === 'error' && (
            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg mb-6">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-red-700 mb-2">{error || 'Submission failed. Your details are still here.'}</p>
                <button type="button" onClick={handleSubmit} className="px-3 py-1.5 text-xs font-medium bg-[#cd2653] text-white rounded-md hover:bg-[#b82049] transition-colors">
                  Try again
                </button>
              </div>
            </div>
          )}

          {/* Honeypot: invisible to humans, bots auto-fill it and get silently dropped */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: '1px', height: '1px', overflow: 'hidden' }}>
            <label htmlFor="company_website_url">Company website (leave blank)</label>
            <input
              type="text"
              id="company_website_url"
              name="company_website_url"
              tabIndex={-1}
              autoComplete="off"
              value={companyWebsiteUrl}
              onChange={e => setCompanyWebsiteUrl(e.target.value)}
            />
          </div>

          {/* Step 1: Business Info */}
          {step === 1 && (
            <div className="space-y-6">
              <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-4">
                <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-[#cd2653]" /> Business Information
                </h2>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Email <span className="text-[#cd2653]">*</span></label>
                  <div className="relative">
                    <input type="email" required value={form.email} onChange={e => set('email', e.target.value)}
                      onBlur={e => {
                        markTouched('email')
                        const email = e.target.value.trim()
                        if (email && email.includes('@')) {
                          track('apply_email_captured', { metadata: { email, name: form.contact_person || '', business: form.stall_brand_name || '' } })
                          fetch('/api/analytics/capture-email', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email, name: form.contact_person, business: form.stall_brand_name, company_website_url: companyWebsiteUrl }),
                            keepalive: true,
                          }).catch(() => {})
                        }
                      }}
                      className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent ${
                        touched.email && !isValidEmail(form.email) ? 'border-red-300' : touched.email && isValidEmail(form.email) ? 'border-green-300' : 'border-neutral-200'
                      }`} placeholder="you@business.com" />
                    {touched.email && isValidEmail(form.email) && (
                      <CheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                    )}
                  </div>
                  {touched.email && !isValidEmail(form.email) && form.email !== '' && (
                    <p className="text-xs text-red-600 mt-1">Please enter a valid email address.</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Item Category <span className="text-[#cd2653]">*</span></label>
                  <select required value={form.item_category} onChange={e => set('item_category', e.target.value)}
                    onBlur={() => markTouched('item_category')}
                    className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent bg-white ${
                      touched.item_category && !form.item_category ? 'border-red-300' : touched.item_category && form.item_category ? 'border-green-300' : 'border-neutral-200'
                    }`}>
                    <option value="">Select category</option>
                    {ITEM_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {touched.item_category && !form.item_category && (
                    <p className="text-xs text-red-600 mt-1">Pick at least one category.</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Stall / Brand Name <span className="text-[#cd2653]">*</span></label>
                  <div className="relative">
                    <input type="text" required value={form.stall_brand_name} onChange={e => set('stall_brand_name', e.target.value)}
                      onBlur={() => markTouched('stall_brand_name')}
                      className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent ${
                        touched.stall_brand_name && !form.stall_brand_name.trim() ? 'border-red-300' : touched.stall_brand_name && form.stall_brand_name.trim() ? 'border-green-300' : 'border-neutral-200'
                      }`} placeholder="Your stall or brand name" />
                    {touched.stall_brand_name && form.stall_brand_name.trim() !== '' && (
                      <CheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                    )}
                  </div>
                  {touched.stall_brand_name && !form.stall_brand_name.trim() && (
                    <p className="text-xs text-red-600 mt-1">Tell us your stall or brand name.</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Business or menu description <span className="text-neutral-400 font-normal">(optional)</span></label>
                  <p className="text-xs text-neutral-500 mb-2">Helpful but not required. Add it now or share with the team if your application is shortlisted.</p>
                  <textarea value={form.business_description} onChange={e => set('business_description', e.target.value)} rows={3}
                    className="w-full px-4 py-3 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent resize-none" placeholder="List the products or menu items you plan to sell..." />
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-2">Have you traded with Cape Town Halaal before? <span className="text-neutral-400 font-normal">(optional)</span></label>
                  <div className="flex gap-3">
                    {['Yes', 'No'].map(opt => (
                      <button key={opt} type="button" onClick={() => set('traded_before', opt)}
                        className={`flex-1 py-3 rounded-lg border text-sm font-medium transition-all ${
                          form.traded_before === opt ? 'bg-[#cd2653] text-white border-[#cd2653]' : 'bg-white text-neutral-700 border-neutral-200 hover:border-neutral-300'
                        }`}>{opt}</button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-4">
                <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
                  <User className="w-5 h-5 text-[#cd2653]" /> Contact Details
                </h2>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Contact Person (owner) <span className="text-[#cd2653]">*</span></label>
                  <div className="relative">
                    <input type="text" required value={form.contact_person} onChange={e => set('contact_person', e.target.value)}
                      onBlur={() => markTouched('contact_person')}
                      className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent ${
                        touched.contact_person && !form.contact_person.trim() ? 'border-red-300' : touched.contact_person && form.contact_person.trim() ? 'border-green-300' : 'border-neutral-200'
                      }`} placeholder="Full name" />
                    {touched.contact_person && form.contact_person.trim() !== '' && (
                      <CheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                    )}
                  </div>
                  {touched.contact_person && !form.contact_person.trim() && (
                    <p className="text-xs text-red-600 mt-1">We need a name to contact you.</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">WhatsApp Number <span className="text-[#cd2653]">*</span></label>
                  <div className="relative">
                    <input type="tel" required value={form.whatsapp_number} onChange={e => set('whatsapp_number', e.target.value)}
                      onBlur={() => markTouched('whatsapp_number')}
                      className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent ${
                        touched.whatsapp_number && !isValidPhone(form.whatsapp_number) ? 'border-red-300' : touched.whatsapp_number && isValidPhone(form.whatsapp_number) ? 'border-green-300' : 'border-neutral-200'
                      }`} placeholder="0XX XXX XXXX" />
                    {touched.whatsapp_number && isValidPhone(form.whatsapp_number) && (
                      <CheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                    )}
                  </div>
                  {touched.whatsapp_number && !isValidPhone(form.whatsapp_number) && form.whatsapp_number !== '' && (
                    <p className="text-xs text-red-600 mt-1">Enter a valid SA mobile, like 0817534892 or +27817534892.</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Social Media Links <span className="text-neutral-400 font-normal">(optional)</span></label>
                  <p className="text-xs text-neutral-500 mb-2">Helps the selection committee. Share now or follow up later.</p>
                  <textarea value={form.social_media_links} onChange={e => set('social_media_links', e.target.value)} rows={2}
                    className="w-full px-4 py-3 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent resize-none" placeholder="Instagram, Facebook, TikTok links..." />
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Stall Selection */}
          {step === 2 && (
            <div className="bg-white rounded-xl border border-neutral-200 p-6">
              <h2 className="text-lg font-semibold text-neutral-900 mb-1 flex items-center gap-2">
                <ShoppingBag className="w-5 h-5 text-[#cd2653]" /> Stall Type & Pricing
              </h2>
              <p className="text-xs text-neutral-500 mb-4">Excludes power. Entry bands are included per stall type.</p>

              <div className="space-y-2">
                {STALL_OPTIONS.map(opt => (
                  <button key={opt.value} type="button" onClick={() => set('stall_type', opt.value)}
                    className={`w-full text-left p-4 rounded-lg border transition-all ${
                      form.stall_type === opt.value
                        ? 'border-[#cd2653] bg-[#cd2653]/5 ring-1 ring-[#cd2653]/20'
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}>
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <p className="font-medium text-neutral-900 text-sm">{opt.label}</p>
                        {opt.bands > 0 && <p className="text-xs text-neutral-500">{opt.bands} entry bands included</p>}
                      </div>
                      {opt.price > 0 ? (
                        <span className="text-lg font-bold text-[#cd2653] ml-4">R{opt.price.toLocaleString()}</span>
                      ) : (
                        <span className="text-sm text-neutral-500 ml-4">TBC</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Requirements */}
          {step === 3 && (
            <div className="space-y-6">
              <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-4">
                <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
                  <Zap className="w-5 h-5 text-[#cd2653]" /> Electrical Requirements
                </h2>
                <p className="text-xs text-neutral-500">1 table and 2 chairs are included with every stall. Select your electrical appliances and quantities below.</p>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-2">Electrical Appliances <span className="text-neutral-400 font-normal">(optional)</span></label>

                  {/* None option */}
                  <button type="button" onClick={() => setApplianceQty('none', form.electrical_appliances['none'] ? 0 : 1)}
                    className={`w-full text-left px-4 py-3 rounded-lg border text-sm font-medium mb-2 transition-all ${
                      form.electrical_appliances['none'] ? 'bg-[#cd2653] text-white border-[#cd2653]' : 'bg-white text-neutral-700 border-neutral-200 hover:border-neutral-300'
                    }`}>None</button>

                  <div className="space-y-2">
                    {ELECTRICAL_OPTIONS.filter(o => o.value !== 'none').map(opt => {
                      const qty = form.electrical_appliances[opt.value] || 0
                      return (
                        <div key={opt.value} className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
                          qty > 0 ? 'border-[#cd2653] bg-[#cd2653]/5' : 'border-neutral-200'
                        }`}>
                          <div className="flex-1">
                            <span className="text-sm font-medium text-neutral-900">{opt.label}</span>
                            <span className="text-xs text-neutral-500 ml-2">R{opt.price}/ea</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {qty > 0 && <span className="text-xs font-medium text-[#cd2653]">R{(opt.price * qty).toLocaleString()}</span>}
                            <button type="button" onClick={() => setApplianceQty(opt.value, Math.max(0, qty - 1))}
                              className="w-8 h-8 rounded-lg bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center text-neutral-700 font-bold transition-colors">−</button>
                            <span className="w-6 text-center text-sm font-bold">{qty}</span>
                            <button type="button" onClick={() => setApplianceQty(opt.value, qty + 1)}
                              className="w-8 h-8 rounded-lg bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center text-neutral-700 font-bold transition-colors">+</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Full detailed list of appliances</label>
                  <p className="text-xs text-neutral-500 mb-2">E.g. 2 Double Fryers, 3 fridges, 2 Microwaves. MUST BE ACCURATE, WILL BE AUDITED. State &quot;none&quot; if not applicable.</p>
                  <textarea value={form.appliance_details} onChange={e => set('appliance_details', e.target.value)} rows={3}
                    className="w-full px-4 py-3 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent resize-none" placeholder="List exact quantities of each appliance, or 'none' if not applicable..." />
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-2">Do you make use of Gas? (Gas certification required) <span className="text-neutral-400 font-normal">(optional)</span></label>
                  <div className="flex gap-3">
                    {['Yes', 'No'].map(opt => (
                      <button key={opt} type="button" onClick={() => set('uses_gas', opt)}
                        className={`flex-1 py-3 rounded-lg border text-sm font-medium transition-all ${
                          form.uses_gas === opt ? 'bg-[#cd2653] text-white border-[#cd2653]' : 'bg-white text-neutral-700 border-neutral-200 hover:border-neutral-300'
                        }`}>{opt}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Cost estimate */}
              {selectedStall && (
                <div className="bg-neutral-900 rounded-xl p-6 text-white">
                  <h3 className="font-semibold mb-3">Estimated Total</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-neutral-400">Stall</span><span>R{selectedStall.price.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-neutral-400">Included</span><span className="text-green-400">1 table + 2 chairs</span></div>
                    {electricalCost > 0 && <div className="flex justify-between"><span className="text-neutral-400">Electrical</span><span>R{electricalCost.toLocaleString()}</span></div>}
                    <div className="border-t border-white/20 pt-2 flex justify-between font-bold text-lg">
                      <span>Total</span><span className="text-[#f59e0b]">R{totalEstimate.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Documents & Terms */}
          {step === 4 && (
            <div className="space-y-6">
              <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-4">
                <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
                  <Upload className="w-5 h-5 text-[#cd2653]" /> Documents
                </h2>
                <p className="text-sm text-neutral-600">
                  You are required to submit a <strong>COA</strong> if you sell any food products. If you sell warm meals, you also need a <strong>Hawkers License</strong>. Gas certification is required if applicable.
                </p>
                <p className="text-sm text-neutral-500">
                  Documents can be emailed to <a href="mailto:support@youngatheart.co.za" className="text-[#cd2653] font-medium hover:underline">support@youngatheart.co.za</a> after submission.
                </p>
              </div>

              <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-4">
                <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-[#cd2653]" /> Terms & Conditions
                </h2>

                <div className="bg-neutral-50 rounded-lg p-4 max-h-60 overflow-y-auto text-xs text-neutral-600 leading-relaxed space-y-2">
                  <p><strong>Cancellation Policy:</strong> No refunds on cancellation within 8 weeks before the event date.</p>
                  <p><strong>Payment:</strong> Your space is only confirmed once paid. Failure to pay will rescind your acceptance.</p>
                  <p><strong>Setup:</strong> Thursday afternoon before the event. Mandatory for all vendors. Friday morning dry run is compulsory for vendors using electricity.</p>
                  <p><strong>Trading:</strong> You must be ready to trade by opening time. Be courteous to customers. Keep pricing affordable.</p>
                  <p><strong>Food Vendors:</strong> Valid COA and Hawkers License required. Non-compliance during inspection = removal without refund.</p>
                  <p><strong>Gas:</strong> Open flame vendors must have fire extinguisher and fire blanket.</p>
                  <p><strong>Parking:</strong> One space per stall. Additional spaces charged separately. Illegal parking = R200 fine.</p>
                  <p><strong>No exclusivity:</strong> No vendor is promised monopoly. Limit of 1-2 duplicates is the aim.</p>
                  <p><strong>Layout:</strong> Organisers reserve the right to reposition stalls. Layouts are not final.</p>
                  <p><strong>General:</strong> No personal generators. No flyers. No allowing unpaid entry. Violations = removal and blacklisting.</p>
                  <p><strong>Communications:</strong> By submitting this application you agree to receive Young at Heart Festival updates and communications (application status, vendor logistics, payment reminders and event news) via WhatsApp and email at the contact details you provide. You can opt out of WhatsApp messages at any time by replying STOP.</p>
                </div>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={form.accepts_cancellation} onChange={e => set('accepts_cancellation', e.target.checked)}
                    className="mt-1 w-4 h-4 rounded border-neutral-300 text-[#cd2653] focus:ring-[#cd2653]" />
                  <span className="text-sm text-neutral-700">I understand that cancellations within 8 weeks before the event are non-refundable *</span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={form.accepts_terms} onChange={e => set('accepts_terms', e.target.checked)}
                    className="mt-1 w-4 h-4 rounded border-neutral-300 text-[#cd2653] focus:ring-[#cd2653]" />
                  <span className="text-sm text-neutral-700">I understand and accept the <a href="/terms" target="_blank" className="text-[#cd2653] underline">terms and conditions</a> *</span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={form.accepts_comms} onChange={e => set('accepts_comms', e.target.checked)}
                    className="mt-1 w-4 h-4 rounded border-neutral-300 text-[#cd2653] focus:ring-[#cd2653]" />
                  <span className="text-sm text-neutral-700">If approved, I consent to event-related communications about YAH Festival 2026 from the organisers via <strong>WhatsApp and email</strong> (payment reminders, allocations, load-in details, support replies). Scope limited to this event. Reply STOP anytime. *</span>
                </label>
              </div>

              {/* Final cost summary */}
              {selectedStall && (
                <div className="bg-neutral-900 rounded-xl p-6 text-white">
                  <h3 className="font-semibold mb-3">Application Summary</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-neutral-400">Brand</span><span>{form.stall_brand_name}</span></div>
                    <div className="flex justify-between"><span className="text-neutral-400">Stall</span><span>{selectedStall.label.split(',')[0].trim()}</span></div>
                    <div className="flex justify-between"><span className="text-neutral-400">Category</span><span>{form.item_category}</span></div>
                    <div className="border-t border-white/20 pt-2 flex justify-between font-bold text-lg">
                      <span>Estimated Total</span><span className="text-[#f59e0b]">R{totalEstimate.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between mt-8 mb-12">
            {step > 1 ? (
              <button onClick={() => setStep(s => s - 1)} className="flex items-center gap-2 px-5 py-3 text-sm font-medium text-neutral-700 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
            ) : (
              <Link href="/" className="flex items-center gap-2 px-5 py-3 text-sm font-medium text-neutral-700 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors">
                <ArrowLeft className="w-4 h-4" /> Home
              </Link>
            )}

            {step < 4 ? (
              <button onClick={() => setStep(s => s + 1)} disabled={!canProceed()}
                className="flex items-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-[#cd2653] rounded-lg hover:bg-[#b82049] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                Next <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button onClick={handleSubmit} disabled={!canProceed() || formState === 'submitting'}
                className="flex items-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-[#cd2653] rounded-lg hover:bg-[#b82049] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {formState === 'submitting' ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</> : <>Submit Application <ArrowRight className="w-4 h-4" /></>}
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
