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

const PROOF_WORDS_RE = /proof\s*of\s*payment|proof\s*of\s*deposit|payment\s*proof|proof\s*of\s*transfer|\bpop\b|payment\s*(?:made|sent|done|completed)|paid\s*(?:today|yesterday|now|via)|\beft\b|bank\s*transfer|direct\s*deposit/i

const PROOF_FILENAME_RE = /proof|payment|pop|deposit|eft|bank|receipt|statement|notification|transfer/i

const IMAGE_OR_PDF_RE = /^(application\/pdf|image\/(png|jpe?g|webp))$/i

function isRealAttachment(a: ProofAttachment): boolean {
  // Same rule as captureAttachments: inline resources are signature graphics.
  if (a.contentDisposition === 'inline') return false
  if (!a.content || (a.size ?? a.content.byteLength) > 10 * 1024 * 1024) return false
  const type = (a.contentType || '').toLowerCase()
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
  const text = `${args.subject || ''}\n${args.body || ''}`
  if (PROOF_WORDS_RE.test(text)) return true
  if (args.alreadyLane) return true
  return false
}
