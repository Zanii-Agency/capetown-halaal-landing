// The wire shape of the unified inbox, in ONE place.
//
// Until 2026-07-26 this interface existed three times — in the messages route,
// in CustomerInboxClient and in NeedsYouClient — and they had already drifted
// (only the client copies carried `pending`). A shared type is what stops the
// server and the two surfaces disagreeing about what a message is.
//
// Imported by:
//   src/app/api/admin/inbox/unified/messages/route.ts   (producer)
//   src/app/(admin)/admin/customer-inbox/CustomerInboxClient.tsx
//   src/app/(admin)/admin/customer-inbox/NeedsYouClient.tsx
//   src/components/admin/inbox/*                        (renderers)

export interface MediaInfo {
  kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'
  /** null for legacy rows captured before media ids were stored — the renderer
   *  shows an honest chip rather than a broken image. */
  url: string | null
  mimeType?: string
  filename?: string
}

export interface CommItem {
  id: string
  channel: 'whatsapp' | 'email'
  direction: 'in' | 'out'
  /** Outbound only: sent by the bot rather than a human operator. */
  bot?: boolean
  body: string
  /** ARRIVAL time (row insert), not the sender's declared timestamp — both
   *  channels use the same clock so a merged sort is meaningful. */
  at: string
  /** Display name — from_name when the sender supplied one, else the local part. */
  from: string
  subject?: string
  /** An array: WhatsApp is always 0 or 1, a real email can carry several. */
  media?: MediaInfo[]
  /** Client-only. Optimistic outbound, not yet confirmed by the server.
   *  Never returned by the route. */
  pending?: boolean

  // ── EMAIL ONLY ────────────────────────────────────────────────────────────
  /** SANITISED SERVER-SIDE by sanitizeEmailHtml. Present only when the row had
   *  body_html. The renderer passes this to dangerouslySetInnerHTML and MUST NOT
   *  re-sanitise or bypass this route — any other producer of this field would
   *  skip the sanitiser. */
  bodyHtml?: string
  /** The real address behind `from`, for the Gmail-style header line. */
  fromAddress?: string
  /** Recipient, so the header can read "to support@…". */
  to?: string
  /** Which inbox it landed in — drives the Gmail / YAH badge. */
  mailbox?: 'gmail' | 'youngatheart'
  /** The sender's OWN declared timestamp. `at` is arrival (what we sort on);
   *  this is what an email client would display as "sent". */
  sentAt?: string

  // ── WHATSAPP ONLY ─────────────────────────────────────────────────────────
  /** Outbound delivery state, for the ticks. */
  status?: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
  /** Failure reason, shown on the failed-send indicator. */
  error?: string
}

/** The contact a thread belongs to, as the renderers need it. */
export interface ThreadContact {
  business_name: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  channels: Array<'whatsapp' | 'email'>
}
