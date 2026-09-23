// LOOK AT THE IMAGE BEFORE ANSWERING IT.
//
// Zhaahira sent a screenshot of a payment link that would not open, captioned
// "Slms the link doesn't work". The bot replied "Thanks Zhaahira, got your
// document and it is on your application. The team will take a look." It had
// never opened the image, and it had thrown her caption away.
//
// Taona 2026-07-30: "its suppose to scan the image quietly to understand
// context". Quietly is the operative word. This produces CONTEXT for the agent,
// never a message of its own: the vendor should never read "I can see a
// screenshot showing...", they should just get an answer that fits what they
// sent.
//
// FAILS SOFT, ALWAYS. Vision is an enhancement on a webhook that must return
// 200 fast. Every failure path returns null and the caller behaves exactly as
// it did before this file existed.

import Anthropic from '@anthropic-ai/sdk'
import { fetchMediaBytes } from '@/lib/whatsapp'

const MODEL = process.env.CTH_VISION_MODEL || 'claude-sonnet-5'

// Anthropic accepts up to ~5MB per image after base64. WhatsApp re-encodes
// photos well under this; a bigger payload is a document scan we skip rather
// than risk a slow request on the webhook path.
const MAX_BYTES = 3_500_000
// The webhook AWAITS this before its 200 (the reply needs the image context, so
// it cannot be deferred to after()). Meta retries a webhook it thinks timed out,
// so the vision call is capped well under that window. A normal read is 2 to 4s;
// this only bites a hung call, which then fails soft to a caption-only reply.
// The wamid dedup guard catches any retry that still slips through.
const TIMEOUT_MS = 8_000

// The only formats the vision API takes. A HEIC or TIFF is not an error, it is
// simply not readable here, and the caller falls back to the plain ack.
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export type SeenImage = {
  /** One or two factual sentences describing what is on screen. */
  description: string
  /** True when it looks like a payment proof (bank app, receipt, transfer confirmation). */
  isPaymentProof: boolean
  /** True when it shows an error, a failed page, or something visibly broken. */
  isProblem: boolean
  /** True when it is a business LOGO / brand mark (so a vendor sending it means
   *  "this is my logo"): not a product photo, document, receipt or screenshot. */
  isLogo?: boolean
  /** Bank/institution name visible on a payment proof, else null. */
  bankName?: string | null
  /** Payment amount visible on a payment proof (as shown, e.g. "R3,700.00"), else null. */
  amount?: string | null
}

function normaliseMime(mime: string | undefined): string | null {
  if (!mime) return null
  // Meta sends "image/jpeg" but occasionally with parameters attached.
  const base = mime.split(';')[0].trim().toLowerCase()
  return SUPPORTED.has(base) ? base : null
}

/**
 * LOOK at raw image bytes and return what they show. The vision core shared by
 * the WhatsApp path (seeImage, which fetches bytes from Meta) and the emailed-
 * proof intake (which already holds the attachment bytes). Same verdict, one
 * prompt, so a proof judged over WhatsApp and one judged over email cannot drift.
 * Returns null whenever the image cannot be read for any reason (fails soft).
 */
export async function seeImageBytes(
  bytes: Buffer,
  mimeType?: string,
  timeoutMs: number = TIMEOUT_MS,
): Promise<SeenImage | null> {
  if (!process.env.ANTHROPIC_API_KEY || !bytes?.byteLength) return null
  const mime = normaliseMime(mimeType)
  if (!mime) return null
  if (bytes.byteLength > MAX_BYTES) return null

  try {
    const client = new Anthropic()
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 300,
        system:
          'You are looking at an image a festival vendor sent to the festival support line. ' +
          'Describe only what is actually visible. Do not guess at intent, do not advise, do not greet. ' +
          'If it shows an error message, a failed page, or a broken link, quote the visible error text. ' +
          'A PROOF OF PAYMENT is an actual bank transfer confirmation, deposit slip, banking-app receipt, ' +
          'or EFT confirmation that shows money moved: it names a bank and shows an amount. ' +
          'A marketing poster, event flyer, menu, price list, logo, product photo, certificate, licence or ID ' +
          'is NOT a proof of payment, even if it mentions the festival or prices. ' +
          'When it IS a proof, capture the bank/institution name and the amount exactly as shown. ' +
          'A LOGO is a business brand mark or name design (a graphic identity, usually on a plain background), ' +
          'not a product photo, a person, a document, a receipt, a poster or a screenshot of an app. ' +
          'Reply with JSON only: {"description": string, "isPaymentProof": boolean, "isProblem": boolean, "isLogo": boolean, "bankName": string|null, "amount": string|null}',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mime as 'image/jpeg', data: bytes.toString('base64') },
              },
              { type: 'text', text: 'What is in this image? Is it a proof of payment?' },
            ],
          },
        ],
      },
      { timeout: timeoutMs },
    )

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()

    // The model is asked for bare JSON but may fence it.
    const json = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const start = json.indexOf('{')
    const end = json.lastIndexOf('}')
    if (start === -1 || end === -1) return null

    const parsed = JSON.parse(json.slice(start, end + 1)) as Partial<SeenImage>
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
    if (!description) return null

    const clean = (s: unknown) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 120) : null)
    return {
      description: description.slice(0, 600),
      isPaymentProof: parsed.isPaymentProof === true,
      isProblem: parsed.isProblem === true,
      isLogo: parsed.isLogo === true,
      bankName: clean(parsed.bankName),
      amount: clean(parsed.amount),
    }
  } catch (e) {
    console.error('[see-image] failed:', (e as Error).message)
    return null
  }
}

/**
 * Read an inbound WhatsApp image and return what it shows.
 * Returns null whenever the image cannot be read for any reason.
 */
export async function seeImage(
  mediaId: string,
  mimeType?: string,
): Promise<SeenImage | null> {
  if (!process.env.ANTHROPIC_API_KEY || !mediaId) return null
  try {
    const media = await fetchMediaBytes(mediaId)
    if (!media) return null
    // Trust the bytes' own content type over the webhook's claim: the webhook
    // field has been absent on some inbound images.
    return await seeImageBytes(media.bytes, media.contentType || mimeType)
  } catch (e) {
    console.error('[see-image] failed:', (e as Error).message)
    return null
  }
}
