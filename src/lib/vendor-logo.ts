// Save a vendor's logo to their public profile. ONE path for every channel
// (portal upload, WhatsApp, email), so a logo sent anywhere lands where the
// public listings read it.
//
// 2026-09-23: the WhatsApp tool wrote logos to the private `vendor-docs` bucket
// while the public listing reads `vendor-assets`, so 4 vendors were told "your
// logo is uploaded", stopped getting reminders, and showed a broken image.
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState } from '@/lib/portal-state'

export const LOGO_BUCKET = 'vendor-assets'

export function logoExt(contentType?: string | null, filename?: string | null): string {
  const fromName = (filename || '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (fromName && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName
  const m = (contentType || '').toLowerCase()
  return m.includes('png') ? 'png' : m.includes('webp') ? 'webp' : m.includes('gif') ? 'gif' : 'jpg'
}

/** Upload + set profile.logo_path. Returns the stored path, or null on failure. */
export async function saveVendorLogo(args: {
  vendorId: string
  bytes: Buffer
  contentType?: string | null
  filename?: string | null
  source: 'whatsapp' | 'email' | 'repair'
}): Promise<string | null> {
  const db = createAdminClient()
  const ext = logoExt(args.contentType, args.filename)
  const path = `${args.vendorId}/logo-${Date.now()}.${ext}`
  const { error } = await db.storage.from(LOGO_BUCKET).upload(path, args.bytes, {
    contentType: args.contentType || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    upsert: true,
  })
  if (error) {
    console.error(`[vendor-logo] ${args.source} upload failed:`, error.message)
    return null
  }
  await updatePortalState(args.vendorId, (s) => ({ ...s, profile: { ...(s.profile || {}), logo_path: path } }))
  try {
    await db.from('site_events').insert({
      session_id: `vendor-${args.vendorId}`,
      event_type: 'profile_logo_uploaded',
      path: '/exhibitor/portal/profile',
      metadata: { vendor_application_id: args.vendorId, storage_path: path, source: args.source, file_name: args.filename || null },
    })
  } catch { /* telemetry never blocks */ }
  return path
}

// ── Logo sent by EMAIL (Taona 2026-09-23: "anytime anyone sends their logo via
// email or whatsapp it gets uploaded for them"). Pink-hanger tried the portal for
// two months and got 9 reminders. Saved only when the mail is ABOUT their logo
// (mentions it, or answers a logo reminder) AND the image reads as a logo, so an
// email-signature graphic or a payment slip never becomes someone's logo.
export async function fileEmailedLogo(a: {
  vendor: { id: string; business_name?: string | null; contact_name?: string | null; email?: string | null; status?: string | null } | null
  subject: string
  body: string
  attachments: Array<{ filename?: string; contentType?: string; content?: Buffer; size?: number }>
}): Promise<string | null> {
  if (!a.vendor || a.vendor.status !== 'approved' || !a.vendor.email) return null
  const own = (a.body || '').split(/\n\s*On .+wrote:|\n>|_{8,}|\bFrom: /)[0]
  if (!/\blogo/i.test(`${a.subject} ${own}`)) return null
  const images = a.attachments.filter((f) => f.content && /^image\/(png|jpe?g|webp|gif)/i.test(f.contentType || '') && f.content.byteLength > 4_000 && f.content.byteLength < 5_000_000)
  const { seeImageBytes } = await import('@/lib/bot/see-image')
  for (const img of images) {
    const seen = await seeImageBytes(img.content!, img.contentType, 25_000)
    if (!seen || seen.isPaymentProof || !seen.isLogo) continue
    const path = await saveVendorLogo({ vendorId: a.vendor.id, bytes: img.content!, contentType: img.contentType, filename: img.filename, source: 'email' })
    if (!path) return null
    const { sendEmail } = await import('@/lib/email/resend')
    const first = String(a.vendor.contact_name || '').trim().split(/\s+/)[0] || 'there'
    await sendEmail({
      to: a.vendor.email,
      subject: /^re:/i.test(a.subject) ? a.subject : `Re: ${a.subject || 'Your logo'}`,
      text: `Hi ${first},\n\nThank you, we have added your logo to your ${String(a.vendor.business_name || '').trim()} profile. It will show in the festival's public vendor listings.\n\nWarm regards,\nThe Young at Heart Festival Team`,
    }).catch((e) => console.error('[vendor-logo] ack failed:', (e as Error).message))
    return path
  }
  return null
}
