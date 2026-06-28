// WhatsApp Cloud API client (Meta, provider-agnostic surface).
// Dormant until WHATSAPP_* env vars are set — see META-WHATSAPP-SETUP.md.
// Swapping to Twilio later only touches this file.

import { createHmac, timingSafeEqual } from 'crypto'
import { canSend, type WaCategory } from './wa-consent'

const GRAPH = 'https://graph.facebook.com/v21.0'
const WA_TOKEN = process.env.WHATSAPP_TOKEN || ''
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || ''
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || ''
const WA_APP_SECRET = process.env.WHATSAPP_APP_SECRET || ''

export const whatsappConfigured = Boolean(WA_TOKEN && WA_PHONE_ID)

// --- Phone normalization (South Africa default) ---
// WhatsApp wants digits with country code, no '+'. Billing phones arrive as
// 0821234567 (local) or +27821234567 — normalize both to 27821234567.
export function toWaId(phone: string, defaultCc = '27'): string {
  const digits = (phone || '').replace(/[^\d]/g, '')
  if (!digits) return ''
  if (digits.startsWith('0')) return defaultCc + digits.slice(1)
  if (digits.startsWith(defaultCc)) return digits
  return digits
}

// E.164 with '+' for storage/display.
export function toE164(phone: string, defaultCc = '27'): string {
  const id = toWaId(phone, defaultCc)
  return id ? `+${id}` : ''
}

interface SendResult {
  messageId: string
  to: string
  skipped?: string // set (with reason) when the consent gate blocked the send
}

async function waFetch(path: string, payload: unknown): Promise<Record<string, unknown>> {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    throw new Error('WhatsApp not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID.')
  }

  const res = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = (data as { error?: { message?: string } })?.error?.message || JSON.stringify(data)
    console.error(`WhatsApp API error: ${res.status}`, detail)
    throw new Error(`WhatsApp API error: ${res.status}, ${detail}`)
  }
  return data as Record<string, unknown>
}

function extractMessageId(data: Record<string, unknown>, to: string): SendResult {
  const messages = data.messages as Array<{ id: string }> | undefined
  return { messageId: messages?.[0]?.id || '', to }
}

// Upload a file (e.g. the FooEvents ticket PDF) to WhatsApp's media store and
// return a media id. Used to send the EXACT same PDF a buyer was emailed, by
// id (more reliable than asking Meta to fetch a public URL). Multipart upload.
export async function uploadMedia(
  bytes: Buffer | Uint8Array,
  mimeType = 'application/pdf',
  filename = 'ticket.pdf'
): Promise<string> {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    throw new Error('WhatsApp not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID.')
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mimeType)
  form.append('file', new Blob([ab], { type: mimeType }), filename)

  const res = await fetch(`${GRAPH}/${WA_PHONE_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
    body: form,
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.id) {
    const detail = data?.error?.message || JSON.stringify(data)
    throw new Error(`WhatsApp media upload failed: ${res.status}, ${detail}`)
  }
  return data.id as string
}

// --- Free-form text (only valid inside the 24h customer service window) ---
// Gated: blocked if the contact opted out or the 24h window is closed.
//
// Architecture 2 pre-send gate (2026-06-12): every outbound passes through
// the shared @sinanagency/bot-guards sanitizeReply with CTH's BotGuardsConfig.
// Catches: brand leaks (Sasa/Nisria/Jensen/Stephen mentions), em-dashes,
// Netlify mentions, urgency-manipulation phrasing. On catch, body is replaced
// with reaskPhrase and the original is logged for engineering review.
// Reference: ~/Code/bot-guards/ + src/lib/bot/guards-config.ts.
export async function sendText(to: string, body: string): Promise<SendResult> {
  const waId = toWaId(to)
  const gate = await canSend(toE164(to), { type: 'text' })
  if (!gate.allowed) return { messageId: '', to: waId, skipped: gate.reason }

  // Pre-send sanitization. Pure function. v0.2 (2026-06-12): caught is now an
  // ARRAY (strip-mode rules can fire several times without dropping) and
  // `dropped` says whether the body was replaced wholesale (brand leak,
  // urgency phrasing) or merely repaired (a stray dash stripped, answer kept).
  const { sanitizeReply } = await import('./bot-guards/index.js')
  const { CTH_BOT_GUARDS_CONFIG } = await import('./bot/guards-config')
  const sanitized = sanitizeReply(body, CTH_BOT_GUARDS_CONFIG)
  const sendBody = sanitized.body
  if (sanitized.caught.length) {
    try {
      const { createAdminClient } = await import('./supabase/admin')
      const db = createAdminClient()
      await db.from('site_events').insert({
        session_id: 'bot_pre_send_caught',
        event_type: sanitized.dropped ? 'pre_send_dropped' : 'pre_send_repaired',
        path: '/lib/whatsapp.sendText',
        metadata: {
          to: toE164(to),
          catches: sanitized.caught.map((c) => ({ kind: c.kind, pattern: c.pattern, mode: c.mode })),
          original: sanitized.caught[0]?.original || '',
          replaced_with: sendBody,
        },
      })
    } catch {
      // Best-effort log; never block the send.
    }
  }

  const data = await waFetch(`${WA_PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'text',
    text: { preview_url: false, body: sendBody },
  })
  return extractMessageId(data, waId)
}

// --- Free-form media (document/image), only valid inside the 24h window ---
// Uploads the bytes to the WhatsApp media endpoint, then sends a media message.
// Gated by the same 24h-window/consent check as sendText.
export async function sendMedia(
  to: string,
  opts: { bytes: Buffer | Uint8Array; mimeType: string; filename: string; caption?: string; kind: 'document' | 'image' },
): Promise<SendResult> {
  const waId = toWaId(to)
  const gate = await canSend(toE164(to), { type: 'text' })
  if (!gate.allowed) return { messageId: '', to: waId, skipped: gate.reason }
  let mediaId: string
  try {
    mediaId = await uploadMedia(opts.bytes, opts.mimeType, opts.filename)
  } catch (e) {
    return { messageId: '', to: waId, skipped: `media upload failed: ${(e as Error).message}` }
  }
  const media: Record<string, unknown> = { id: mediaId }
  if (opts.kind === 'document') media.filename = opts.filename
  if (opts.caption) media.caption = opts.caption
  const data = await waFetch(`${WA_PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: waId,
    type: opts.kind,
    [opts.kind]: media,
  })
  return extractMessageId(data, waId)
}

// --- Approved template (business-initiated) ---
// `bodyParams` fill the {{1}}, {{2}}... in order. `headerMedia` attaches a
// document/image to a template that has a media header (e.g. the QR ticket).
export async function sendTemplate(
  to: string,
  templateName: string,
  bodyParams: string[] = [],
  opts: {
    lang?: string
    // Provide EITHER a public `link` OR an uploaded media `id` (see uploadMedia).
    headerMedia?: { type: 'document' | 'image'; link?: string; id?: string; filename?: string }
    category?: WaCategory // defaults to 'utility' (transactional); set 'marketing' for promos
  } = {}
): Promise<SendResult> {
  const waId = toWaId(to)
  const gate = await canSend(toE164(to), { type: 'template', category: opts.category || 'utility' })
  if (!gate.allowed) return { messageId: '', to: waId, skipped: gate.reason }
  const components: Array<Record<string, unknown>> = []

  if (opts.headerMedia) {
    const media: Record<string, unknown> = opts.headerMedia.id
      ? { id: opts.headerMedia.id }
      : { link: opts.headerMedia.link }
    if (opts.headerMedia.filename) media.filename = opts.headerMedia.filename
    components.push({
      type: 'header',
      parameters: [{ type: opts.headerMedia.type, [opts.headerMedia.type]: media }],
    })
  }

  if (bodyParams.length) {
    // Template frames are Meta approved copy, but PARAMS are live text (names,
    // order summaries) and can carry a leak. Sanitize each against the wall
    // (2026-06-12): a brand inside a param drops THAT param to the reask
    // phrase; a stray dash is stripped. The template frame itself never dies.
    let cleanParams = bodyParams
    try {
      const { sanitizeReply } = await import('./bot-guards/index.js')
      const { CTH_BOT_GUARDS_CONFIG } = await import('./bot/guards-config')
      cleanParams = bodyParams.map((p) => sanitizeReply(String(p), CTH_BOT_GUARDS_CONFIG).body)
    } catch {
      // wall must never break delivery
    }
    components.push({
      type: 'body',
      parameters: cleanParams.map((text) => ({ type: 'text', text })),
    })
  }

  const data = await waFetch(`${WA_PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: templateName,
      language: { code: opts.lang || 'en' },
      ...(components.length ? { components } : {}),
    },
  })
  return extractMessageId(data, waId)
}

// --- Convenience: deliver a ticket (template + QR document header) ---
export async function sendTicket(args: {
  to: string
  firstName: string
  orderNumber: string
  ticketSummary: string
  // Provide EITHER the uploaded media id (preferred — the exact FooEvents PDF)
  // OR a public PDF url.
  mediaId?: string
  pdfUrl?: string
  filename?: string
}): Promise<SendResult> {
  return sendTemplate(
    args.to,
    'ticket_delivery',
    [args.firstName, args.orderNumber, args.ticketSummary],
    {
      headerMedia: {
        type: 'document',
        ...(args.mediaId ? { id: args.mediaId } : { link: args.pdfUrl }),
        filename: args.filename || 'YAH-Festival-Ticket.pdf',
      },
    }
  )
}

// --- Resolve a Meta media id -> raw bytes (server-only, token-gated) ---
// Meta media ids are short-lived (~1h TTL): you first GET the media id to get a
// signed download URL, then fetch that URL with the bearer token. This is the
// same two-step the admin inbox media proxy does on demand; centralised here so
// the webhook can ALSO call it at receipt time to copy the bytes into Storage
// before the id expires. Returns null (never throws) so callers can treat it as
// best-effort.
// Defense-in-depth bounds (B6.1, 2026-06-23): a slow Meta endpoint or an
// oversized upload must never hang the function or buffer 100MB into memory.
// Both fetches get a hard ~3s timeout via AbortSignal; the byte fetch is also
// capped at ~5MB (checked first against Content-Length, then against the
// actual buffer). Over-cap items bail to null so the caller keeps id-only
// behavior and the proxy falls back to the live Meta id (~1h TTL).
const WA_MEDIA_FETCH_TIMEOUT_MS = 3000
const WA_MEDIA_MAX_BYTES = 5 * 1024 * 1024 // 5MB

export async function fetchMediaBytes(
  mediaId: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!WA_TOKEN || !mediaId) return null
  try {
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(WA_MEDIA_FETCH_TIMEOUT_MS),
    })
    if (!metaRes.ok) return null
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string }
    if (!meta.url) return null

    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(WA_MEDIA_FETCH_TIMEOUT_MS),
    })
    if (!binRes.ok) return null

    // Size cap (cheap path): if Meta advertises a Content-Length over the cap,
    // bail before buffering a single byte.
    const declaredLen = Number(binRes.headers.get('content-length') || '0')
    if (declaredLen > WA_MEDIA_MAX_BYTES) {
      console.warn(
        `[wa-media] skipping oversized media ${mediaId}: content-length ${declaredLen} > ${WA_MEDIA_MAX_BYTES} cap`
      )
      return null
    }

    const arrayBuf = await binRes.arrayBuffer()
    // Size cap (post-buffer path): some responses omit Content-Length, so also
    // check the actual buffered length and drop it if it exceeded the cap.
    if (arrayBuf.byteLength > WA_MEDIA_MAX_BYTES) {
      console.warn(
        `[wa-media] skipping oversized media ${mediaId}: buffered ${arrayBuf.byteLength} > ${WA_MEDIA_MAX_BYTES} cap`
      )
      return null
    }

    const contentType =
      meta.mime_type || binRes.headers.get('content-type') || 'application/octet-stream'
    return { bytes: Buffer.from(arrayBuf), contentType }
  } catch {
    return null
  }
}

// --- Webhook verification (GET handshake from Meta) ---
export function verifyWebhook(mode: string | null, token: string | null, challenge: string | null): string | null {
  if (mode === 'subscribe' && token && token === WA_VERIFY_TOKEN) return challenge
  return null
}

// --- Payload signature check (POST webhook) ---
// Meta signs every POST with the app secret. Reject anything that doesn't match
// so nobody can spoof inbound messages / opt-outs against the bot.
// Fail CLOSED everywhere by default. The webhook signature is the ONLY thing
// authenticating the sender's identity (resolveIdentity + findAdmin trust
// msg.from verbatim), so an open verify = anyone can impersonate any vendor OR
// the master admin by POSTing a forged payload. The previous NODE_ENV==='production'
// carve-out failed OPEN on Vercel PREVIEW/branch deploys (NODE_ENV !== 'production'),
// which are reachable URLs wired to the same creds — full bot impersonation.
// Now: missing secret rejects on every DEPLOYED env; local dev must opt in
// EXPLICITLY with WHATSAPP_ALLOW_UNSIGNED=1 (set only in .env.local, never on a
// deploy).
export function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!WA_APP_SECRET) {
    if (process.env.WHATSAPP_ALLOW_UNSIGNED === '1') return true
    console.error('[whatsapp] WHATSAPP_APP_SECRET missing — rejecting webhook (set WHATSAPP_ALLOW_UNSIGNED=1 for LOCAL dev only)')
    return false
  }
  if (!signatureHeader?.startsWith('sha256=')) return false
  const expected = 'sha256=' + createHmac('sha256', WA_APP_SECRET).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  return a.length === b.length && timingSafeEqual(a, b)
}

// --- Inbound message parsing (POST webhook payload) ---
/** Inbound media descriptor (image/document/video/audio/sticker). The `id` is
 * the Meta media id — distinct from the wamid — and is the ONLY key that can
 * retrieve the bytes from the Graph API, so we surface + persist it. */
export interface InboundMedia {
  kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'
  id: string
  mimeType?: string
  filename?: string
  caption?: string
}
export interface InboundMessage {
  from: string // wa id, digits only
  messageId: string
  type: string
  text: string
  name?: string
  /** wamid of the message this one is a reply to (WhatsApp swipe-reply). */
  replyToWamid?: string
  /** Present when the inbound is a media message (image/doc/video/sticker). */
  media?: InboundMedia
}

// Pull the media descriptor (image/document/video/audio/sticker) out of a raw
// Meta message node, if any. Each media type nests `{ id, mime_type, … }` under
// a key named for its type. The `id` is the media id used by the media proxy.
function extractMedia(msg: WaMessageNode): InboundMedia | undefined {
  for (const kind of ['image', 'document', 'video', 'audio', 'sticker'] as const) {
    const node = (msg as unknown as Record<string, { id?: string; mime_type?: string; filename?: string; caption?: string }>)[kind]
    if (node?.id) {
      return { kind, id: node.id, mimeType: node.mime_type, filename: node.filename, caption: node.caption }
    }
  }
  return undefined
}

export function parseInbound(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = []
  const entries = (body as { entry?: Array<{ changes?: Array<{ value?: WaChangeValue }> }> })?.entry || []
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value
      const contacts = value?.contacts || []
      const profileName = contacts[0]?.profile?.name
      for (const msg of value?.messages || []) {
        const media = extractMedia(msg)
        // Non-text, non-media types (reaction / location / contacts) arrived with
        // an empty body and showed as "[media message]" / blank in the inbox.
        // Capture a readable label so they render meaningfully (native feel).
        const reaction = (msg as { reaction?: { emoji?: string } }).reaction
        const hasLocation = !!(msg as { location?: unknown }).location
        const hasContacts = Array.isArray((msg as { contacts?: unknown[] }).contacts)
        const fallback =
          reaction?.emoji ? `reacted ${reaction.emoji}` :
          hasLocation ? '📍 shared a location' :
          hasContacts ? '📇 shared a contact' : ''
        out.push({
          from: msg.from,
          messageId: msg.id,
          type: msg.type,
          // Use a media caption as the text so a captioned image still reads well.
          text: msg.text?.body || msg.button?.text || media?.caption || fallback || '',
          name: profileName,
          replyToWamid: (msg as { context?: { id?: string } }).context?.id,
          ...(media ? { media } : {}),
        })
      }
    }
  }
  return out
}

// --- Delivery status parsing (sent/delivered/read/failed) ---
export interface StatusUpdate {
  messageId: string
  status: string
  recipient: string
  errorMessage?: string
}

export function parseStatuses(body: unknown): StatusUpdate[] {
  const out: StatusUpdate[] = []
  const entries = (body as { entry?: Array<{ changes?: Array<{ value?: WaChangeValue }> }> })?.entry || []
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      for (const st of change.value?.statuses || []) {
        out.push({
          messageId: st.id,
          status: st.status,
          recipient: st.recipient_id,
          errorMessage: st.errors?.[0]?.title,
        })
      }
    }
  }
  return out
}

// A raw Meta message node. Media types (image/document/video/audio/sticker)
// each nest `{ id, mime_type, filename?, caption? }` under their own key.
type WaMediaNode = { id?: string; mime_type?: string; filename?: string; caption?: string }
interface WaMessageNode {
  from: string
  id: string
  type: string
  text?: { body: string }
  button?: { text: string }
  context?: { id?: string }
  image?: WaMediaNode
  document?: WaMediaNode
  video?: WaMediaNode
  audio?: WaMediaNode
  sticker?: WaMediaNode
}

interface WaChangeValue {
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>
  messages?: WaMessageNode[]
  statuses?: Array<{
    id: string
    status: string
    recipient_id: string
    errors?: Array<{ title: string }>
  }>
}
