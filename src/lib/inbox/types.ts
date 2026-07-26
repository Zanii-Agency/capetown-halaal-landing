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
  from: string
  subject?: string
  /** An array: WhatsApp is always 0 or 1, a real email can carry several. */
  media?: MediaInfo[]
  /** Client-only. Optimistic outbound, not yet confirmed by the server.
   *  Never returned by the route. */
  pending?: boolean
}

/** The contact a thread belongs to, as the renderers need it. */
export interface ThreadContact {
  business_name: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  channels: Array<'whatsapp' | 'email'>
}
