// Real email attachments (PDFs, photos a vendor sends) were never captured —
// only parsed.text/parsed.html ever got read out of mailparser's result, so
// support_inbox_messages had nothing to render even though WhatsApp media
// already worked (Taona 2026-07-13, "email attachments not rendering inline").
//
// support_inbox_messages has no JSONB column and DDL is blocked on this
// Supabase project (CTH-DOCTRINE law 8), so attachment metadata is encoded as
// a marker appended to body_text, the SAME pattern portal-state.ts/identity.ts
// already use for structured data in a DDL-blocked column. The marker is
// stripped before the body is ever shown to an operator.
import type { Attachment } from 'mailparser'
import type { createAdminClient } from '@/lib/supabase/admin'
import { isRealAttachment } from '@/lib/payments/email-proof-detect'

export const EMAIL_ATTACHMENTS_BUCKET = 'email-attachments'
const MARKER_RE = /\n*⟦ATTACH:([A-Za-z0-9+/=]+)⟧\s*$/

export interface StoredAttachment {
  filename: string
  mimeType: string
  size: number
  path: string
}

function safeFilename(name: string): string {
  return (name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file'
}

/**
 * Upload the REAL attachments from a parsed email (skips inline/embedded
 * images like signature logos — mailparser's own contentDisposition signal)
 * and return a marker string to append to body_text. Returns '' when there
 * is nothing worth keeping. Never throws — a storage hiccup just means this
 * email has no attachments today, not a dropped message.
 */
export async function captureAttachments(
  db: ReturnType<typeof createAdminClient>,
  messageId: string,
  attachments: Attachment[] | undefined,
): Promise<string> {
  if (!attachments?.length) return ''
  const MAX_BYTES = 15 * 1024 * 1024 // sanity cap, most mail servers already cap below this
  const stored: StoredAttachment[] = []
  const slug = messageId.replace(/[^\w.\-@]+/g, '_').slice(0, 80)

  let idx = 0
  for (const a of attachments) {
    // Inline resources (contentDisposition: 'inline', usually cid-referenced
    // from body_html) are signature graphics and tracking pixels, not
    // something a vendor "sent us". Real attachments are 'attachment' or,
    // for senders that never set the header, undefined.
    // Shared predicate with proof detection: a large inline image (pasted bank
    // screenshot) is real, a small one (signature logo) is not.
    if (!isRealAttachment(a)) continue
    if (!a.content || a.size > MAX_BYTES) continue
    const filename = safeFilename(a.filename || `attachment-${idx + 1}`)
    const path = `${slug}/${idx}-${filename}`
    try {
      const { error } = await db.storage.from(EMAIL_ATTACHMENTS_BUCKET).upload(path, a.content, {
        contentType: a.contentType || 'application/octet-stream',
        upsert: true,
      })
      if (error) { console.error('[email-attachments] upload failed:', error.message); continue }
      stored.push({ filename, mimeType: a.contentType || 'application/octet-stream', size: a.size || a.content.length, path })
      idx++
    } catch (e) {
      console.error('[email-attachments] upload threw:', (e as Error).message)
    }
  }
  if (!stored.length) return ''
  return `\n\n⟦ATTACH:${Buffer.from(JSON.stringify(stored)).toString('base64')}⟧`
}

/** Strip the marker from a stored body_text and decode the attachment list. */
export function parseAttachmentMarker(bodyText: string | null | undefined): { cleanBody: string; attachments: StoredAttachment[] } {
  const text = bodyText || ''
  const m = text.match(MARKER_RE)
  if (!m) return { cleanBody: text, attachments: [] }
  const cleanBody = text.slice(0, m.index).trimEnd()
  try {
    const attachments = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as StoredAttachment[]
    return { cleanBody, attachments: Array.isArray(attachments) ? attachments : [] }
  } catch {
    return { cleanBody, attachments: [] }
  }
}
