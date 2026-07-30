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
const TIMEOUT_MS = 12_000

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
}

function normaliseMime(mime: string | undefined): string | null {
  if (!mime) return null
  // Meta sends "image/jpeg" but occasionally with parameters attached.
  const base = mime.split(';')[0].trim().toLowerCase()
  return SUPPORTED.has(base) ? base : null
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
    const mime = normaliseMime(media.contentType) || normaliseMime(mimeType)
    if (!mime) return null
    if (media.bytes.byteLength > MAX_BYTES) return null

    const client = new Anthropic()
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 300,
        system:
          'You are looking at an image a festival vendor sent to a support line over WhatsApp. ' +
          'Describe only what is actually visible. Do not guess at intent, do not advise, do not greet. ' +
          'If it shows an error message, a failed page, or a broken link, quote the visible error text. ' +
          'If it is a proof of payment, say so and include any visible amount, date and reference. ' +
          'If it is a document (certificate, licence, ID, menu), say which. ' +
          'Reply with JSON only: {"description": string, "isPaymentProof": boolean, "isProblem": boolean}',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mime as 'image/jpeg', data: media.bytes.toString('base64') },
              },
              { type: 'text', text: 'What is in this image?' },
            ],
          },
        ],
      },
      { timeout: TIMEOUT_MS },
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

    return {
      description: description.slice(0, 600),
      isPaymentProof: parsed.isPaymentProof === true,
      isProblem: parsed.isProblem === true,
    }
  } catch (e) {
    console.error('[see-image] failed:', (e as Error).message)
    return null
  }
}
