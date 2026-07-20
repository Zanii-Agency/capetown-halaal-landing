'use client'

/**
 * On-platform QR camera scanner for the Day-of Gate verifier.
 *
 * Why this exists: the old "Open FooEvents scanner (camera)" embed pointed an
 * iframe at the WordPress wp-admin Express Check-In page. That is cross-origin
 * AND needs camera permissions, so the browser rendered it blank. The operator
 * wanted scanning to happen ON the platform without leaving for WordPress.
 *
 * How it works: we use the browser-native BarcodeDetector API to read QR codes
 * straight off the device camera, then hand the decoded payload to the existing
 * /api/admin/verifier/lookup route in `qr` mode (which already decodes the
 * FooEvents `<order>|<ticket>|<hash>` / URL / numeric shapes) and the existing
 * /check-in endpoint. Check-in stays fully on-platform, no new dependency.
 *
 * BarcodeDetector ships in Chrome/Edge and Android Chrome (the day-of gate
 * device). When it is unavailable (older Safari/Firefox) we degrade to a clear
 * message plus the external-scanner link, never a blank embed.
 *
 * Law 7: no em-dashes in any UI string here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, Loader2, ExternalLink } from 'lucide-react'

// Minimal typing for the experimental BarcodeDetector API. Not in lib.dom yet.
type DetectedBarcode = { rawValue: string }
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

function getDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
  return w.BarcodeDetector || null
}

interface QrCameraScannerProps {
  /** Called with the raw decoded QR text when a code is read. */
  onScan: (rawValue: string) => void
  /** External fallback URL, used only when the camera path is unavailable. */
  fallbackUrl: string
}

export function QrCameraScanner({ onScan, fallbackUrl }: QrCameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const detectorRef = useRef<BarcodeDetectorLike | null>(null)
  const lastScanRef = useRef<string>('')
  const lastScanAtRef = useRef<number>(0)

  const [active, setActive] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [supported, setSupported] = useState<boolean | null>(null)

  // Detect API support once mounted (client-only).
  useEffect(() => {
    setSupported(Boolean(getDetectorCtor()) && Boolean(navigator?.mediaDevices?.getUserMedia))
  }, [])

  const stop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setActive(false)
  }, [])

  // Tear down on unmount.
  useEffect(() => () => stop(), [stop])

  const tick = useCallback(async () => {
    const video = videoRef.current
    const detector = detectorRef.current
    if (!video || !detector || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(tick)
      return
    }
    try {
      const codes = await detector.detect(video)
      if (codes.length > 0) {
        const raw = (codes[0].rawValue || '').trim()
        const now = Date.now()
        // Debounce: ignore the same payload within 2.5s so one physical scan
        // does not fire a flood of lookups.
        if (raw && (raw !== lastScanRef.current || now - lastScanAtRef.current > 2500)) {
          lastScanRef.current = raw
          lastScanAtRef.current = now
          onScan(raw)
        }
      }
    } catch {
      // Per-frame detect errors are transient (e.g. video not ready). Keep looping.
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [onScan])

  const start = useCallback(async () => {
    setError(null)
    setStarting(true)
    try {
      const Ctor = getDetectorCtor()
      if (!Ctor) throw new Error('unsupported')
      detectorRef.current = new Ctor({ formats: ['qr_code'] })

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) {
        stream.getTracks().forEach((t) => t.stop())
        throw new Error('video element missing')
      }
      video.srcObject = stream
      await video.play()
      setActive(true)
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('Camera permission was blocked. Allow camera access for this site, then try again.')
      } else if ((e as Error)?.message === 'unsupported') {
        setError('This browser cannot scan in-page. Use Chrome on the gate device, or the external scanner link.')
      } else {
        setError('Could not start the camera. Check it is not in use by another app.')
      }
      stop()
    } finally {
      setStarting(false)
    }
  }, [tick, stop])

  // Unsupported browser: clean fallback, never a blank embed.
  if (supported === false) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-neutral-600">
          In-page scanning needs Chrome or Edge (the gate device). On this browser, use the
          external scanner instead.
        </p>
        <a
          href={fallbackUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-neutral-900 text-white text-sm font-semibold rounded-lg hover:bg-neutral-800"
        >
          <ExternalLink className="w-4 h-4" />
          Open external scanner
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-600">
        Point the device camera at the ticket QR code. It scans and looks up automatically, then you
        press check in. Everything stays on this page.
      </p>

      <div className="relative rounded-lg overflow-hidden border border-neutral-200 bg-neutral-900 aspect-video max-w-md">
        <video
          ref={videoRef}
          playsInline
          muted
          className={`w-full h-full object-cover ${active ? '' : 'opacity-0'}`}
        />
        {active && (
          // Reticle so the operator knows where to aim.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="w-44 h-44 border-2 border-white/80 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}
        {!active && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-400 text-sm">
            Camera off
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600">{error}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!active ? (
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#cd2653] text-white text-sm font-semibold rounded-lg hover:bg-[#b01f45] disabled:opacity-50"
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
            {starting ? 'Starting camera' : 'Start camera scan'}
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-neutral-200 text-neutral-700 text-sm font-semibold rounded-lg hover:bg-neutral-50"
          >
            <CameraOff className="w-4 h-4" />
            Stop camera
          </button>
        )}
        <a
          href={fallbackUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500 hover:text-neutral-700"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          External scanner
        </a>
      </div>
    </div>
  )
}
