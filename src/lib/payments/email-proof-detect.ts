// Detect a vendor's proof-of-payment EMAIL.
//
// The WhatsApp path (handle-eft-proof-media) already auto-lanes a vendor who
// sends a proof there. Vendors also just email "ProofOfPayment.pdf" to
// support@, and before this detector those emails sat in the inbox as ordinary
// threads until a human noticed — Taona 2026-08-02: "if vendor emails proof of
// payment or via whatsapp, it should autopopulate on masterlane if it isnt
// acknowledged". The mail fetcher uses this to decide when to lane the vendor
// and record the proof through recordEftProof.
//
// Pure: unit-tested without IMAP, mailparser, or a DB.

export interface ProofAttachment {
  filename?: string
  contentType?: string
  contentDisposition?: string
  size?: number
  content?: Buffer
}

// \bpop\b(?![-\s]*up\b): "POP" / "POP attached" (proof of payment) match, but
// "pop up" / "pop-up" (a signage/display term) do NOT — that token, buried in a
// quoted signage thread, is what false-flagged the maspark agreement (2026-09-07).
const PROOF_WORDS_RE = /proof\s*of\s*payment|proof\s*of\s*deposit|payment\s*proof|proof\s*of\s*transfer|\bpop\b(?![-\s]*up\b)|payment\s*(?:made|sent|done|completed)|paid\s*(?:today|yesterday|now|via)|\beft\b|bank\s*transfer|direct\s*deposit/i

const PROOF_FILENAME_RE = /proof|payment|pop|deposit|eft|bank|receipt|statement|notification|transfer/i

/** The sender's OWN message, with any quoted reply / forwarded chain removed. A
 *  long quotes/agreement/signage thread carries payment words ("EFT", "bank", a
 *  "pop-up") in its HISTORY that say nothing about a proof the sender is making
 *  now. Proof WORDS are matched only against this (subject + new text); the
 *  filename check and alreadyLane are unaffected, so real proofs still detect.
 *  (maspark signed-agreement false alert, 2026-09-07.) */
export function stripQuotedReply(body: string): string {
  if (!body) return ''
  const cut = body.search(/\n\s*(_{6,}|From:\s|On\s.{0,80}\bwrote:|-{2,}\s*(Original Message|Forwarded message)|Sent from my )/i)
  return (cut >= 0 ? body.slice(0, cut) : body).trim()
}

const IMAGE_OR_PDF_RE = /^(application\/pdf|image\/(png|jpe?g|webp))$/i

/** Inline resources are usually signature graphics and tracking pixels, but an
 *  iPhone/Gmail "paste a screenshot" of a bank app also arrives as
 *  contentDisposition:'inline' (microbshuttle@, shameemakhan87@ on 2026-09-01,
 *  both proofs lost). A signature logo is a few KB; a bank screenshot is 200KB+.
 *  zanii-codef: size floor as the tell, cid-reference check if it misfires. */
export const INLINE_IMAGE_MIN_BYTES = 60 * 1024

/** Shared with captureAttachments so storage and proof detection cannot drift. */
export function isRealAttachment(a: ProofAttachment): boolean {
  const size = a.size ?? a.content?.byteLength ?? 0
  const type = (a.contentType || '').toLowerCase()
  // An inline PDF is never a signature graphic (Bil's, iPhone Mail 2026-09-01).
  const inlineOk = type === 'application/pdf' || (/^image\//.test(type) && size >= INLINE_IMAGE_MIN_BYTES)
  if (a.contentDisposition === 'inline' && !inlineOk) return false
  if (!a.content || size > 10 * 1024 * 1024) return false
  if (IMAGE_OR_PDF_RE.test(type)) return true
  // Senders that omit a content type: accept a payment-ish filename.
  return !!a.filename && /\.(pdf|png|jpe?g|webp)$/i.test(a.filename)
}

/** First attachment worth treating as a proof, preferring payment-ish names. */
export function pickProofAttachment(attachments: ProofAttachment[]): ProofAttachment | null {
  const real = attachments.filter(isRealAttachment)
  if (!real.length) return null
  return real.find((a) => a.filename && PROOF_FILENAME_RE.test(a.filename)) || real[0]
}

/**
 * True when this email should be treated as a vendor sending proof of payment.
 *
 *   - a payment-ish attachment filename ("ProofOfPayment.pdf", "POP.jpg",
 *     "EFT slip", "bank notification") — filename alone is enough;
 *   - payment wording in subject or body WITH any real attachment;
 *   - already on the EFT lane with any real attachment (same eager rule as the
 *     WhatsApp path: a lane vendor's document is a proof unless clearly not).
 */
export function looksLikeProofEmail(args: {
  subject?: string | null
  body?: string | null
  attachments: ProofAttachment[]
  alreadyLane?: boolean
}): boolean {
  const real = args.attachments.filter(isRealAttachment)
  if (!real.length) return false
  if (real.some((a) => a.filename && PROOF_FILENAME_RE.test(a.filename))) return true
  // Words are matched against the subject + the sender's OWN message only, never
  // the quoted history (that is where a signage/agreement thread hides "eft" /
  // "pop-up" and false-flags as a proof).
  const text = `${args.subject || ''}\n${stripQuotedReply(args.body || '')}`
  // KNOW THE DIFFERENCE (Taona, 2026-09-07): a quotes / agreement / artwork /
  // signage business thread is NOT a stall-fee proof, no matter how many payment
  // words it drags along, UNLESS the sender's own text explicitly says a payment
  // was made. A proof-ish attachment FILENAME already returned true above, so an
  // actual "ProofOfPayment.pdf" on such a thread still counts.
  const saysPaid = /proof\s*of\s*payment|payment\s*proof|proof\s*of\s*(?:deposit|transfer)|\bpop\b(?![-\s]*up\b)|payment\s*(?:made|sent|done|completed)|paid\s*(?:today|yesterday|now|via|the\s|R\d)/i.test(text)
  if (!saysPaid && /\b(quotations?|quotes?|estimate|proposal|agreement|contract|sponsorship|artwork|signage)\b/i.test(args.subject || '')) return false
  if (PROOF_WORDS_RE.test(text)) return true
  if (args.alreadyLane) return true
  return false
}
