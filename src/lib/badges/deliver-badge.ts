// Render + deliver a CTH staff badge over email (guaranteed) + WhatsApp
// (best-effort). Replaces the FooEvents PDF-email dependency that never
// attached the badge. See badge-pdf.ts for the QR contract.

import { renderBadgePdf, type BadgeInput } from './badge-pdf'
import { sendMedia, toE164 } from '@/lib/whatsapp'
import { sendEmail } from '@/lib/email/resend'

export interface DeliverResult {
  pdf: boolean
  email: boolean
  whatsapp: string   // messageId, or a skip/failure reason
}

/**
 * Render the badge and push it out. Email is the reliable channel (Resend, no
 * 24h window). WhatsApp via sendMedia is best-effort: it is gated to the 24h
 * customer-service window (whatsapp.ts), so a vendor who added staff from the
 * web portal (no open WA session) will see it `skipped` — email carries the
 * badge in that case. When the vendor is in-window (e.g. asked the bot to
 * resend), sendMedia delivers the PDF straight to WhatsApp.
 */
export async function deliverBadge(
  input: BadgeInput & { vendorPhone?: string; vendorEmail?: string; intro?: string },
): Promise<DeliverResult> {
  const pdf = await renderBadgePdf(input)
  if (!pdf) return { pdf: false, email: false, whatsapp: 'render_failed' }

  const filename = `CTH-Staff-Badge-${input.wcOrderId}.pdf`

  // Email (primary channel) — attach the PDF, and CONFIRM it actually left
  // Resend (KT #206657: an accepted send can still be silently suppressed).
  let email = false
  if (input.vendorEmail) {
    try {
      const r = await sendEmail({
        to: input.vendorEmail,
        subject: `Staff badge for ${input.name}, Young at Heart 2026`,
        text:
          `Hi,\n\n${input.intro ? `${input.intro}\n\n` : ''}Attached is the festival staff gate pass for ${input.name} (${input.role}) at ${input.businessName}` +
          `${input.stall ? `, stall ${input.stall}` : ''}.\n\n` +
          `Print it or show it on a phone. The QR code is scanned at the gate. Pass number ${input.wcOrderId}.\n\n` +
          `See you 11 to 13 December 2026 at Youngsfield Military Base.\n\nYoung at Heart Festival`,
        attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
        confirmDelivery: true,
      })
      email = !!r?.ok
      if (!r?.ok) {
        // The vendor thinks their badge is on the way — tell ops it is not, so
        // Samreen can WhatsApp it manually (portal "Resend badge" re-renders it).
        console.error('[deliver-badge] email failed:', r?.error)
        try {
          const { notifyOwners } = await import('@/lib/bot/notify')
          await notifyOwners({
            event: 'system_alert',
            body: `Staff badge email for ${input.name} (order ${input.wcOrderId}) did NOT reach ${input.vendorEmail}${r?.suppressed ? ' (Resend suppression: the address is blocked on Resend, not a typo)' : ''}. Send the badge manually via WhatsApp or another email.`,
            audience: 'all',
          })
        } catch (e) {
          console.error('[deliver-badge] ops alert failed:', (e as Error).message)
        }
      }
    } catch (e) {
      console.error('[deliver-badge] email failed:', (e as Error).message)
    }
  }

  // WhatsApp (best-effort, 24h-window gated).
  let whatsapp = 'no_phone'
  const e164 = input.vendorPhone ? toE164(input.vendorPhone) : ''
  if (e164) {
    try {
      const r = await sendMedia(e164, {
        bytes: pdf, mimeType: 'application/pdf', filename, kind: 'document',
        caption: `Staff badge for ${input.name}. Scan the QR at the gate.`,
      })
      whatsapp = r.messageId || r.skipped || 'unknown'
    } catch (e) {
      whatsapp = `error: ${(e as Error).message}`
    }
  }

  return { pdf: true, email, whatsapp }
}
