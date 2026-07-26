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
// with no text/plain part, a base64 blob — sitting in body_text.

/** Strip RFC822 headers, and decode a base64 body when the row is raw MIME.
 *  Returns the body unchanged when it does not look like raw source, so it is
 *  safe to run over every message. */
export function stripRfc822Headers(body: string | null | undefined): string {
  if (!body) return ''
  const head = body.slice(0, 400)
  const looksLikeRfc822 = /^(Return-Path|Received|From|To|Subject|Message-ID|X-[A-Za-z-]+):/m.test(head)
  if (!looksLikeRfc822) return body
  const splitIdx = body.search(/\r?\n\r?\n/)
  if (splitIdx < 0) return body
  const tail = body.slice(splitIdx + 2).trim()
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
