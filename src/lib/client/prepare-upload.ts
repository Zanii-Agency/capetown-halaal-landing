'use client'

// Vercel serverless functions cap the REQUEST BODY at ~4.5MB. Our upload routes
// (eft-proof, documents) advertise 10MB, but a body over ~4.5MB is rejected by
// the platform with a 413 BEFORE the route runs, so recordEftProof's own size
// check never sees it and the vendor only ever got a generic "Upload failed."
// 2026-09-03: "a lot of people" couldn't attach proof of payment. Phone photos
// of a bank transfer are routinely 3-8MB, straight over the cap.
//
// Fix: shrink oversized IMAGES on the client so a normal photo lands well under
// the cap before it is ever sent. PDFs and files the browser can't decode as an
// image can't be compressed here, so for those we throw a clear, actionable
// error instead of letting the platform 413 in silence.

/** Client hard cap. Safely under Vercel's ~4.5MB body limit once multipart
 *  framing overhead is added. */
export const UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024
// Aim images comfortably below the cap, not just under it.
const TARGET_BYTES = Math.floor(3.6 * 1024 * 1024)
// Longest edge for a re-encoded photo. 2000px is more than enough to read a
// bank-transfer screenshot or a permit, and keeps the JPEG small.
const MAX_EDGE = 2000

/** Human, actionable message for a file we cannot get under the cap. */
export function tooLargeMessage(bytes: number, limit = UPLOAD_LIMIT_BYTES): string {
  return (
    `This file is ${(bytes / 1024 / 1024).toFixed(1)}MB and the most we can upload here is ${Math.round(limit / 1024 / 1024)}MB. ` +
    `Please email it to support@youngatheart.co.za, or upload a smaller or clearer photo.`
  )
}

export class FileTooLargeError extends Error {
  constructor(public readonly bytes: number, limit = UPLOAD_LIMIT_BYTES) {
    super(tooLargeMessage(bytes, limit))
    this.name = 'FileTooLargeError'
  }
}

/** Return an upload-ready File. Small files pass through untouched. An oversized
 *  image is downscaled + re-encoded as JPEG until it fits. An oversized PDF (or
 *  any file the browser can't decode as an image) throws FileTooLargeError so the
 *  caller shows a real message. Never returns a file bigger than the input. */
export async function prepareUploadFile(file: File, limit = UPLOAD_LIMIT_BYTES): Promise<File> {
  if (file.size <= limit) return file
  if (file.type === 'application/pdf') throw new FileTooLargeError(file.size, limit)

  // `from-image` applies EXIF orientation so a portrait phone photo is not saved
  // sideways. Unknown types (heic on non-Safari, corrupt) reject -> honest error.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null)
  if (!bitmap) throw new FileTooLargeError(file.size, limit)

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const cctx = canvas.getContext('2d')
  if (!cctx) { bitmap.close?.(); throw new FileTooLargeError(file.size, limit) }
  // zanii-codef: transparent PNGs flatten onto white (fine for photos/scans of
  // documents; a rare transparent screenshot loses its alpha, acceptable).
  cctx.fillStyle = '#ffffff'
  cctx.fillRect(0, 0, w, h)
  cctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()

  const base = file.name.replace(/\.[^.]+$/, '') || 'proof'
  // Dimensions are already capped, so q=0.82 almost always fits on the first
  // pass; the ladder is a backstop for enormous sources.
  for (const q of [0.82, 0.7, 0.6, 0.5, 0.4]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q))
    if (blob && blob.size <= Math.min(TARGET_BYTES, limit)) return new File([blob], `${base}.jpg`, { type: 'image/jpeg' })
  }
  throw new FileTooLargeError(file.size, limit)
}

/** Direct-to-storage limit for compliance documents (body never hits Vercel). */
export const DOC_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024

/** Upload a compliance doc via sign -> PUT to Supabase Storage -> commit.
 *  `endpoint` is /api/exhibitor/documents or /api/admin/vendors/<id>/documents. */
export async function uploadDocDirect(endpoint: string, docType: string, file: File): Promise<void> {
  const toSend = await prepareUploadFile(file, DOC_UPLOAD_LIMIT_BYTES)
  const call = async (body: Record<string, unknown>) => {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || 'Upload failed')
    return j
  }
  const { path, token } = await call({ action: 'sign', doc_type: docType, name: toSend.name })
  const { createClient } = await import('@/lib/supabase/client')
  const { error } = await createClient().storage.from('vendor-docs')
    .uploadToSignedUrl(path, token, toSend, { contentType: toSend.type || 'application/octet-stream' })
  if (error) throw new Error('Upload failed, please try again.')
  await call({ action: 'commit', doc_type: docType, path, name: file.name })
}
