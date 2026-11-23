// CTH adapter over @zanii/intake extractTextFromBuffer.
//
// Thin shim: forwards a binary document to the intake primitive and
// returns clean text (or null when the type has no text layer). No
// API keys involved, extraction is local and free.
//
// Opt-in. No current caller. The future use case is the support lane:
// a vendor sends a PDF spec sheet, a docx of stand notes, or an xlsx of
// product line items, and CTH reads it into TEXT cheaply before deciding
// whether to escalate to a human.

import { extractTextFromBuffer as intakeExtract } from './intake/index.js'

export interface ExtractTextOpts {
  /** Cap stored text so one huge file can't bloat downstream rows. */
  maxChars?: number
}

/**
 * Extract clean text from a binary document.
 * Returns null when the input has no text layer (image scans, audio, video).
 * Returns "" on extraction failure. Never throws.
 *
 * Supported types (handled by intake): application/pdf, docx, xlsx, csv,
 * text/*, application/json. Anything else returns null.
 */
export async function extractTextFromBuffer(
  buf: Buffer | Uint8Array,
  mime: string,
  opts: ExtractTextOpts = {},
): Promise<string | null> {
  return intakeExtract(buf, mime, { maxChars: opts.maxChars })
}
