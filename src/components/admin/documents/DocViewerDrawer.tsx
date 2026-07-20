'use client'

// Inline PDF previewer for /admin/documents. A right-side slide-in drawer
// that embeds the document in an iframe so the operator never leaves the
// admin shell to view a vendor doc or ticket.
//
// All `url`s handed to this drawer are SAME-ORIGIN proxy routes that stream
// the PDF bytes through our domain (the admin contract route, the vendor-doc
// route, and the tickets proxy). Streaming the bytes same-origin is what lets
// Chrome's built-in PDF viewer render the file inline instead of showing
// "This page has been blocked" (which happens when an iframe follows a 302 to
// a cross-origin Supabase/WordPress URL).
//
// We intentionally do NOT sandbox the iframe: the same-origin bytes are our
// own trusted output, and Chrome's PDF plugin will not render inside an
// over-restricted sandbox. The "Open in new tab" link stays as an escape
// hatch, and an onError still flips us to the fallback panel.

import { useEffect, useState } from 'react'
import { ExternalLink, X, AlertCircle } from 'lucide-react'

interface DocViewerDrawerProps {
  open: boolean
  url: string | null
  label: string
  holder?: string | null
  onClose: () => void
}

export function DocViewerDrawer({ open, url, label, holder, onClose }: DocViewerDrawerProps) {
  const [iframeError, setIframeError] = useState(false)

  // Reset the error state whenever we open a new doc, so a previously
  // failed PDF does not poison the next one.
  useEffect(() => {
    if (open) setIframeError(false)
  }, [open, url])

  // Close on Escape so the operator never feels trapped.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer */}
      <aside
        className="fixed top-0 right-0 z-50 h-full w-full sm:w-[800px] max-w-full bg-white shadow-xl border-l border-[#E5E5E5]/60 flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={`Viewing ${label}`}
      >
        <header className="flex items-start gap-3 p-4 border-b border-[#E5E5E5]/40 bg-[#FFFFFF]">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#1B1A17] truncate">{label}</p>
            {holder && (
              <p className="text-xs text-[#1B1A17]/55 truncate">{holder}</p>
            )}
          </div>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#cd2653] hover:text-[#bf3026] px-2 py-1 rounded-full border border-[#E5E5E5]/50"
              title="Open in new tab"
            >
              Open in new tab <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-[#F4F4F4] text-[#1B1A17]/70"
            aria-label="Close viewer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 bg-[#F4F4F4] relative">
          {!url && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-[#1B1A17]/45">
              No file to display.
            </div>
          )}
          {url && !iframeError && (
            <iframe
              src={url}
              title={label}
              loading="lazy"
              className="w-full h-full bg-white"
              onError={() => setIframeError(true)}
            />
          )}
          {url && iframeError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <AlertCircle className="w-8 h-8 text-[#1B1A17]/45" />
              <p className="text-sm text-[#1B1A17]/70">
                This PDF can only be viewed in a new tab.
              </p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-semibold text-[#cd2653] hover:text-[#bf3026] px-3 py-2 rounded-full border border-[#E5E5E5]/50"
              >
                Open in new tab <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
