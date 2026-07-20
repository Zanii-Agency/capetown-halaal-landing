'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

interface Props {
  alreadySigned: boolean
  signedAt: string | null
  signaturePath: string | null
  fullName: string
}

// Two modes: TYPE (default, fastest on a phone) or DRAW (canvas, mobile finger
// or stylus). Either way we produce a PNG data URL that the server embeds into
// the rendered PDF; the server does not care how the image was made.
//
// Mobile-first: stacks vertically, large tap targets, no horizontal scroll.
export function ContractSignPanel({ alreadySigned, signedAt, signaturePath, fullName }: Props) {
  const [mode, setMode] = useState<'type' | 'draw'>('type')

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [hasInk, setHasInk] = useState(false)
  const [printName, setPrintName] = useState(fullName)
  const [signedPlace, setSignedPlace] = useState('Cape Town')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Setup the draw canvas at retina res when entering draw mode.
  useEffect(() => {
    if (mode !== 'draw') return
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = c.clientWidth * dpr
    c.height = c.clientHeight * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#1B1A17'
  }, [mode])

  // Render the typed name as a script signature into the preview canvas
  // whenever it changes. This is what becomes the signature image in type mode.
  useEffect(() => {
    if (mode !== 'type') return
    const c = previewRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = c.clientHeight
    c.width = w * dpr
    c.height = h * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    // Pick a script-style stack; falls back gracefully if Google Font hasn't loaded.
    ctx.font = `italic 600 44px "Dancing Script", "Snell Roundhand", "Apple Chancery", cursive`
    ctx.fillStyle = '#1B1A17'
    ctx.textBaseline = 'middle'
    ctx.fillText(printName || ' ', 16, h / 2)
  }, [printName, mode])

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current
    if (!c) return { x: 0, y: 0 }
    const r = c.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = point(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
    setDrawing(true)
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return
    e.preventDefault()
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = point(e)
    ctx.lineTo(x, y)
    ctx.stroke()
    setHasInk(true)
  }
  function onUp() { setDrawing(false) }
  function clearDraw() {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    setHasInk(false)
  }

  async function submit() {
    setError(null)
    if (!printName.trim()) { setError('Please enter your full name.'); return }
    let signatureDataUrl = ''
    if (mode === 'type') {
      const p = previewRef.current
      if (!p) { setError('Signature preview missing.'); return }
      signatureDataUrl = p.toDataURL('image/png')
    } else {
      if (!hasInk) { setError('Please draw your signature in the box.'); return }
      const c = canvasRef.current
      if (!c) return
      signatureDataUrl = c.toDataURL('image/png')
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/exhibitor/contract/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signatureDataUrl,
          signatureMode: mode,
          printName: printName.trim(),
          signedAt: signedPlace.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Sign failed')
      window.location.href = '/exhibitor/portal'
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  // Download the signed contract copy. The route redirects (302) to a
  // short-lived Supabase signed URL on success; on failure it returns a JSON
  // error. A bare <a href> would navigate the browser to that JSON error page,
  // so we fetch first, check res.ok, and only then blob-download with an
  // explicit filename (the signed URL carries no useful Content-Disposition).
  async function downloadSignedCopy() {
    try {
      const res = await fetch('/api/exhibitor/contract/download')
      if (!res.ok) {
        let message = 'Could not download your signed contract.'
        try {
          const data = await res.json()
          if (data?.error) message = data.error
        } catch {
          /* non-JSON error body; keep the generic message */
        }
        toast.error(message)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const slug = (fullName || 'contract').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'contract'
      a.href = url
      a.download = `CTH-Contract-${slug}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      toast.error('Could not download your signed contract. Please try again.')
    }
  }

  if (alreadySigned) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="w-2 h-2 rounded-full bg-emerald-500 mt-2 flex-shrink-0" />
          <div>
            <h3 className="font-serif text-lg text-[#1B1A17]">Contract signed</h3>
            <p className="text-sm text-neutral-700 mt-1">
              Signed on {signedAt ? new Date(signedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : ''}.
            </p>
            {signaturePath && (
              <button
                type="button"
                onClick={downloadSignedCopy}
                className="inline-block mt-3 text-sm underline text-[#cd2653]"
              >
                Download your signed copy
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Load the script font for typed signatures (mobile-friendly, ~12KB). */}
      <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@600;700&display=swap" rel="stylesheet" />

      <div className="rounded-2xl bg-white border border-neutral-200 p-5 sm:p-6">
        <h3 className="font-serif text-lg text-[#1B1A17] mb-4">Sign to accept</h3>

        <div className="space-y-4">
          {/* Mode toggle — two big tap targets, mobile-first */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode('type')}
              className={`rounded-lg border px-4 py-3 text-sm font-medium transition ${
                mode === 'type'
                  ? 'bg-[#cd2653] border-[#cd2653] text-white'
                  : 'bg-white border-neutral-300 text-neutral-700'
              }`}
            >
              Type my name
            </button>
            <button
              type="button"
              onClick={() => setMode('draw')}
              className={`rounded-lg border px-4 py-3 text-sm font-medium transition ${
                mode === 'draw'
                  ? 'bg-[#cd2653] border-[#cd2653] text-white'
                  : 'bg-white border-neutral-300 text-neutral-700'
              }`}
            >
              Draw with finger
            </button>
          </div>

          {/* Full name input — always required (used in the printed line + audit row). */}
          <label className="block">
            <span className="text-sm text-neutral-700">Full name</span>
            <input
              type="text"
              autoComplete="name"
              autoCapitalize="words"
              value={printName}
              onChange={(e) => setPrintName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#cd2653]"
            />
          </label>

          {/* TYPE mode: live script-rendered preview */}
          {mode === 'type' && (
            <div>
              <span className="text-sm text-neutral-700">Your signature</span>
              <canvas
                ref={previewRef}
                className="mt-1 w-full h-24 rounded-lg border border-neutral-300 bg-neutral-50"
              />
              <p className="text-xs text-neutral-500 mt-1">
                A typed signature counts as your electronic signature under the ECT Act (RSA).
              </p>
            </div>
          )}

          {/* DRAW mode: canvas pad */}
          {mode === 'draw' && (
            <div>
              <span className="text-sm text-neutral-700">Sign in the box</span>
              <canvas
                ref={canvasRef}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerLeave={onUp}
                className="mt-1 w-full h-40 sm:h-44 rounded-lg border border-neutral-300 bg-neutral-50 touch-none cursor-crosshair"
              />
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs text-neutral-500">Use your finger, mouse or stylus.</span>
                <button type="button" onClick={clearDraw} className="text-xs text-neutral-700 underline px-2 py-1">
                  Clear
                </button>
              </div>
            </div>
          )}

          <label className="block">
            <span className="text-sm text-neutral-700">Signed at</span>
            <input
              type="text"
              value={signedPlace}
              onChange={(e) => setSignedPlace(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#cd2653]"
            />
          </label>

          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>}

          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="w-full rounded-lg bg-[#cd2653] text-white font-medium py-4 text-base disabled:opacity-50 active:scale-[0.99]"
          >
            {submitting ? 'Submitting...' : 'Sign and accept'}
          </button>
          <p className="text-xs text-neutral-500 text-center px-2">
            By signing you confirm you have read the contract above and agree to comply with it.
          </p>
        </div>
      </div>
    </>
  )
}
