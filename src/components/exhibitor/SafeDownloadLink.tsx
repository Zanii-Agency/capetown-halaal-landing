'use client'

// Safe file download for auth-gated API routes that may return a JSON error
// (no Content-Disposition) on failure. A bare <a href download> would save that
// error body as a misnamed file (e.g. "pdf.json"). This fetches first, checks
// res.ok, and only saves a blob on success; on failure it surfaces a toast and
// saves nothing. Mirrors the proven pattern in admin/contacts and the vendors
// CSV export.

import { useState } from 'react'
import { toast } from 'sonner'

export default function SafeDownloadLink({
  href,
  filename,
  className,
  children,
}: {
  href: string
  filename: string
  className?: string
  children: React.ReactNode
}) {
  const [busy, setBusy] = useState(false)

  async function download() {
    if (busy) return
    setBusy(true)
    try {
      // Default redirect-follow transparently follows a 302 to a signed URL and
      // returns the file bytes, so both streamed-PDF and redirect routes work.
      const res = await fetch(href, { credentials: 'same-origin' })
      if (!res.ok) {
        let message = `Download failed (${res.status})`
        try {
          const body = await res.json()
          if (body?.error) message = String(body.error)
        } catch {
          // non-JSON error body; keep the status-code message
        }
        toast.error(message)
        return
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(objectUrl)
    } catch {
      toast.error('Download failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" onClick={download} disabled={busy} className={className}>
      {children}
    </button>
  )
}
