'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { X, ImageUp, ArrowRight } from 'lucide-react'
import { Z_CLASS } from '@/lib/z'

// Announcement modal nudging a PAID vendor to upload their logo so they appear
// (with branding) in the public sector listings. The parent (Overview, a server
// component) decides WHO sees this — it only renders this modal for vendors who
// have paid AND have no logo on file. We re-show it each login until the logo is
// up, but suppress repeats within a single browser session (sessionStorage) so
// it nudges without nagging on every in-session navigation.
export function LogoUploadModal({ firstName }: { firstName: string }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    try {
      const flag = window.sessionStorage.getItem('cth_logo_prompt_seen')
      if (!flag) setOpen(true)
    } catch {
      // Private browsing / storage disabled: show it, no persistence.
      setOpen(true)
    }
  }, [])

  function dismiss() {
    try {
      window.sessionStorage.setItem('cth_logo_prompt_seen', new Date().toISOString())
    } catch {
      // ignore
    }
    setOpen(false)
  }

  if (!open) return null

  return (
    <div
      className={`fixed inset-0 ${Z_CLASS.modal} flex items-center justify-center p-4 bg-[#1B1A17]/60 backdrop-blur-sm`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cth-logo-title"
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-[#E5E5E5]">
        <div className="flex items-start justify-between p-5 border-b border-[#E5E5E5]/60">
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-[#cd2653]">
            Action needed
          </span>
          <button
            onClick={dismiss}
            aria-label="Close"
            className="text-[#1B1A17]/50 hover:text-[#1B1A17] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-3">
          <ImageUp className="w-7 h-7 text-[#cd2653]" />
          <h2 id="cth-logo-title" className="font-serif text-2xl text-[#1B1A17]">
            Upload your logo, {firstName}.
          </h2>
          <p className="text-sm text-[#1B1A17]/70 leading-relaxed">
            Your stall fee is paid, thank you. The last step to go live on the public
            festival site is your logo. Vendors with a logo show up with their branding
            in the sector listings shoppers browse before the show. It takes under a minute.
          </p>
        </div>

        <div className="flex items-center justify-between p-5 bg-[#FDFAF1] border-t border-[#E5E5E5]/60">
          <button
            onClick={dismiss}
            className="text-xs font-semibold text-[#1B1A17]/55 hover:text-[#1B1A17]"
          >
            Later
          </button>
          <Link
            href="/exhibitor/portal/profile"
            onClick={dismiss}
            className="inline-flex items-center gap-2 bg-[#cd2653] hover:bg-[#bf3026] text-white font-semibold rounded-full px-5 py-2.5 text-sm transition-colors"
          >
            Upload logo
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  )
}

export default LogoUploadModal
