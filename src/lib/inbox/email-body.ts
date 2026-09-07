// Cleanup for email bodies that arrived as raw MIME rather than parsed text.
//
// Lifted from SupportInboxClient on 2026-07-26, where it was a local unexported
// function. That meant the OLD support inbox defended against these rows while
// the unified inbox — reading the very same table — rendered `Return-Path:` and
// `Received:` header blocks to the operator verbatim. Moving it to lib lets the
// unified route apply it SERVER-side, so every consumer gets clean text.
//
// Why these rows exist: both mail fetchers fall back to slicing the raw RFC822
// source when mailparser returns no text (`support-mail-fetcher/route.ts`,
// `mail-fetcher/route.ts`), which can leave headers — and, for HTML-only mail
// with no text/plain part, a base64 blob, or a whole MIME multipart body with
// its `--boundary` / `Content-Type:` parts — sitting in body_text.

import { parseAttachmentMarker } from '@/lib/email/attachments'

/** Decode quoted-printable: soft line breaks (=\n) and =XX hex escapes. */
function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** Recursively pull the readable text out of a (possibly NESTED) MIME multipart
 *  block. Handles multipart/mixed wrapping multipart/alternative wrapping
 *  text/plain + text/html. Returns null when no text part is found. */
function extractFromMime(src: string, depth = 0): string | null {
  if (depth > 4) return null
  // A real MIME boundary line is exactly `--<token>` on its own line. Require a
  // longish token so we never trip on a literal "--" in prose.
  const bm = src.match(/^--([A-Za-z0-9'()+_,\-./:=?]{8,})\s*$/m)
  if (!bm) return null
  const boundary = '--' + bm[1]
  let plain: string | null = null
  let html: string | null = null
  for (const part of src.split(boundary)) {
    const sep = part.search(/\r?\n\r?\n/)
    if (sep < 0) continue
    const headers = part.slice(0, sep)
    if (!/content-type:/i.test(headers)) continue
    let content = part.slice(sep + 2).replace(/\s*--\s*$/, '').trim()
    if (/content-type:\s*multipart\//i.test(headers)) {
      const nested = extractFromMime(content, depth + 1) // recurse into nested boundary
      if (nested != null && plain == null) plain = nested
      continue
    }
    if (/content-transfer-encoding:\s*base64/i.test(headers)) {
      try { content = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8') } catch { /* keep raw */ }
    } else if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
      content = decodeQuotedPrintable(content)
    }
    if (/content-type:\s*text\/plain/i.test(headers)) { plain = content; break }
    if (/content-type:\s*text\/html/i.test(headers) && html === null) {
      html = content.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
    }
  }
  const chosen = plain ?? html
  if (chosen == null) return null
  return chosen.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** When a whole MIME multipart body leaked into body_text (starts with, or
 *  contains, a `--boundary` line and `Content-Type:` parts, possibly nested),
 *  pull out the readable text part. Returns the body unchanged when there is no
 *  multipart boundary or no text part, so it is safe over any row. */
export function stripMimeMultipart(body: string | null | undefined): string {
  const src = body || ''
  const extracted = extractFromMime(src)
  return extracted == null ? src : extracted
}

/** Strip RFC822 headers, and decode a base64 body when the row is raw MIME.
 *  Also unwraps a leaked MIME multipart body first. Returns the body unchanged
 *  when it does not look like raw source, so it is safe to run over every message. */
export function stripRfc822Headers(body: string | null | undefined): string {
  const unwrapped = stripMimeMultipart(body)
  if (!unwrapped) return ''
  const head = unwrapped.slice(0, 400)
  const looksLikeRfc822 = /^(Return-Path|Received|From|To|Subject|Message-ID|X-[A-Za-z-]+):/m.test(head)
  if (!looksLikeRfc822) return unwrapped
  const splitIdx = unwrapped.search(/\r?\n\r?\n/)
  if (splitIdx < 0) return unwrapped
  const tail = unwrapped.slice(splitIdx + 2).trim()
  if (!tail) return ''

  // Some HTML-only emails (Content-Transfer-Encoding: base64, no text/plain
  // alternative) leave the raw base64 blob in the tail. Detect by checking if
  // the tail looks like base64 and decode it.
  if (tail.length > 20) {
    const sample = tail.replace(/\s/g, '').slice(0, 200)
    if (/^[A-Za-z0-9+/=]+$/.test(sample)) {
      try {
        // Buffer, not atob: this now runs on the server as well as the client.
        const decoded = Buffer.from(tail.replace(/\s/g, ''), 'base64').toString('utf8')
        // Strip HTML tags since this was originally text/html.
        return decoded.replace(/<[^>]*>/g, '').trim().slice(0, 4000) || decoded.slice(0, 4000)
      } catch { /* not valid base64, fall through */ }
    }
  }

  return tail
}

/** One-shot readable text for a stored email row: drop the ⟦ATTACH:…⟧ marker,
 *  unwrap MIME multipart, strip RFC822 headers/base64, collapse whitespace.
 *  Use this for previews/snippets where you only need clean plain text. */
export function cleanEmailText(body: string | null | undefined): string {
  if (!body) return ''
  const { cleanBody } = parseAttachmentMarker(body)
  return stripRfc822Headers(cleanBody).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
