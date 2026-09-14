// Shared proof-CONTENT validation for the emailed + WhatsApp proof paths: read a
// document and decide whether it is actually a bank payment proof (money moved),
// not an invoice, quote, statement, menu, price list or poster, and pull out the
// bank and amount. Keeps both ingest paths on ONE verdict rather than two drifting
// heuristics (KT #206893: sibling ingest paths share a core, never reimplement).

import Anthropic from '@anthropic-ai/sdk'

const MODEL = process.env.CTH_VISION_MODEL || 'claude-sonnet-5'

/**
 * Extract a PDF's text layer. Bank payment confirmations are generated (text)
 * PDFs, so a real emailed proof has text. Returns null on a scanned/image-only
 * PDF (no text layer) or any failure, and the caller treats "no text" as
 * unverifiable rather than a proof.
 */
export async function extractPdfText(buf: Buffer, maxChars = 8000): Promise<string | null> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const { text } = await extractText(pdf, { mergePages: true })
    const raw = Array.isArray(text) ? text.join('\n') : String(text || '')
    const cleaned = raw.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!cleaned) return null
    return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + '\n\n[…truncated]' : cleaned
  } catch (e) {
    console.warn('[proof-content] pdf text extraction failed:', (e as Error).message)
    return null
  }
}

export type ProofTextVerdict = {
  /** One or two factual sentences on what the document is. */
  description: string
  /** True ONLY for an actual payment confirmation showing money moved. */
  isPaymentProof: boolean
  /** Bank/institution named on the proof, else null. */
  bankName: string | null
  /** Amount paid as shown (e.g. "R3,700.00"), else null. */
  amount: string | null
}

/**
 * Ask the model whether extracted document TEXT is a real proof of payment, as
 * opposed to an invoice, quote, order, statement, menu, price list, poster or
 * agreement (all of which can carry amounts and banking details without money
 * having moved). Mirrors the see-image vision prompt so an emailed PDF and an
 * emailed screenshot are judged by the same standard. Returns null on any failure;
 * the caller must treat null as "could not verify" and NOT file.
 */
export async function classifyProofText(text: string, timeoutMs = 25_000): Promise<ProofTextVerdict | null> {
  if (!process.env.ANTHROPIC_API_KEY || !text?.trim()) return null
  try {
    const client = new Anthropic()
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 300,
        system:
          'You are reading the text extracted from a document a festival vendor emailed to the festival. ' +
          'A PROOF OF PAYMENT is an actual bank transfer confirmation, deposit slip, banking-app receipt or EFT ' +
          'confirmation showing money MOVED: it names a bank and shows an amount that was paid. ' +
          'An invoice, quote, estimate, purchase order, statement of account, price list, menu, poster, flyer or ' +
          'signed agreement is NOT a proof of payment, even when it shows amounts or banking details. ' +
          'When it IS a proof, capture the bank/institution name and the amount paid exactly as shown. ' +
          'Reply with JSON only: {"description": string, "isPaymentProof": boolean, "bankName": string|null, "amount": string|null}',
        messages: [
          { role: 'user', content: [{ type: 'text', text: `Document text:\n\n${text}\n\nIs this a proof of payment?` }] },
        ],
      },
      { timeout: timeoutMs },
    )
    const rawOut = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    const json = rawOut.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const start = json.indexOf('{')
    const end = json.lastIndexOf('}')
    if (start === -1 || end === -1) return null
    const parsed = JSON.parse(json.slice(start, end + 1)) as Partial<ProofTextVerdict>
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
    if (!description) return null
    const clean = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 120) : null)
    return {
      description: description.slice(0, 600),
      isPaymentProof: parsed.isPaymentProof === true,
      bankName: clean(parsed.bankName),
      amount: clean(parsed.amount),
    }
  } catch (e) {
    console.error('[proof-content] classifyProofText failed:', (e as Error).message)
    return null
  }
}
