'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { X, ArrowRight, ArrowLeft, CheckCircle2 } from 'lucide-react'

interface TourStep {
  title: string
  body: string
  navigateTo?: string
}

const STEPS: TourStep[] = [
  {
    title: 'Welcome to the Admin Portal',
    body: 'This tour will show you how to use each feature. Click Next to begin.',
  },
  {
    title: 'Review Vendor Applications',
    body: 'Click "Applications" in the left sidebar to see all vendor applications. Use keyboard shortcuts: j/k to navigate, a to approve, r to reject.',
    navigateTo: '/admin/applications',
  },
  {
    title: 'Applications Workbench',
    body: 'Each row is a vendor application. Click any row to preview their details. The keyboard shortcuts work here too.',
  },
  {
    title: 'Assign Stalls on the Map',
    body: 'Click "Allocation" in the sidebar to open the 2D floor plan. Click any stall to assign it to a vendor.',
    navigateTo: '/admin/allocation',
  },
  {
    title: 'Floor Plan Map',
    body: 'This is the festival floor plan. Click any colored stall to assign or release it. Use filters to narrow by sector or status.',
  },
  {
    title: 'Manage Approved Vendors',
    body: 'Click "Vendors" in the sidebar to see every approved vendor. Click any vendor for their full profile.',
    navigateTo: '/admin/vendors',
  },
  {
    title: 'Vendor Profile',
    body: 'This shows the vendor\'s complete information: contact details, payment status, documents, staff badges, and activity timeline.',
  },
  {
    title: 'Track Payments',
    body: 'Click "Finance" under MONEY to see payment status for every vendor. The Payments tab shows who has paid.',
    navigateTo: '/admin/finance',
  },
  {
    title: 'Handle Support Emails',
    body: 'Click "Support Inbox" under COMMUNICATIONS to read and reply to emails. Tag, assign, snooze, or resolve threads.',
    navigateTo: '/admin/inbox/support',
  },
  {
    title: 'Search Everything with Cmd+K',
    body: 'Press Cmd+K (or Ctrl+K) from any page to search vendors, buyers, and threads. Arrow keys to navigate, Enter to open.',
  },
  {
    title: 'You\'re All Set!',
    body: 'You now know the key features. Reopen this guide anytime from the "Guide" button at the bottom of the sidebar.',
  },
]

const STORAGE_KEY = 'admin.tour_state'

export function InteractiveTour({ email }: { email?: string | null }) {
  const pathname = usePathname()
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [open, setOpen] = useState(false)
  const [navigating, setNavigating] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const { step: savedStep, active } = JSON.parse(saved)
        if (active && typeof savedStep === 'number') {
          setStep(savedStep)
          setOpen(true)
          return
        }
      }
      setStep(0)
      setOpen(true)
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ step: 0, active: true }))
    } catch {
      // ignore
    }
  }, [])

  // A step with navigateTo is meant to be shown ON that page. When we enter such
  // a step and aren't there yet, NAVIGATE to it (this used to call setOpen(false),
  // which killed the tour the instant you advanced from Welcome to a page-bound
  // step). Once the route matches, clear the navigating spinner.
  useEffect(() => {
    if (!open) return
    const currentStep = STEPS[step]
    if (currentStep.navigateTo && !pathname.startsWith(currentStep.navigateTo)) {
      setNavigating(true)
      router.push(currentStep.navigateTo)
    } else {
      setNavigating(false)
    }
  }, [pathname, open, step, router])

  function next() {
    const nextStep = Math.min(step + 1, STEPS.length - 1)
    setStep(nextStep)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ step: nextStep, active: true }))
  }

  function prev() {
    const prevStep = Math.max(step - 1, 0)
    setStep(prevStep)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ step: prevStep, active: true }))
  }

  function close() {
    localStorage.removeItem(STORAGE_KEY)
    setOpen(false)
  }

  if (!open) return null

  const s = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-neutral-200">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-neutral-100">
          <div className="flex items-center gap-3">
            {isLast ? (
              <CheckCircle2 className="w-6 h-6 text-emerald-500" />
            ) : (
              <div className="w-6 h-6 rounded-full bg-[#cd2653] text-white text-xs font-bold flex items-center justify-center">
                {step + 1}
              </div>
            )}
            <h3 className="font-serif text-xl text-neutral-900">{s.title}</h3>
          </div>
          <button onClick={close} className="text-neutral-400 hover:text-neutral-900">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          <p className="text-sm text-neutral-600 leading-relaxed">{s.body}</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 bg-neutral-50 border-t border-neutral-100">
          <div>
            {!isFirst && (
              <button onClick={prev} className="text-xs font-medium text-neutral-500 hover:text-neutral-900 inline-flex items-center gap-1">
                <ArrowLeft className="w-3 h-3" /> Back
              </button>
            )}
            {isFirst && (
              <button onClick={close} className="text-xs font-medium text-neutral-500 hover:text-neutral-900">
                Skip tour
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {STEPS.map((_, i) => (
                <div key={i} className={`w-1.5 h-1.5 rounded-full ${i === step ? 'bg-[#cd2653]' : 'bg-neutral-200'}`} />
              ))}
            </div>
            <button
              onClick={isLast ? close : next}
              disabled={navigating}
              className="inline-flex items-center gap-1.5 bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-full px-4 py-2 text-sm transition-colors disabled:opacity-50"
            >
              {isLast ? 'Done' : navigating ? 'Loading...' : 'Next'}
              {!isLast && !navigating && <ArrowRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
