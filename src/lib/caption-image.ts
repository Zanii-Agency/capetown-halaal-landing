// CTH adapter over @zanii/intake captionImage.
//
// Thin shim: hands the Anthropic key from CTH's environment to the intake
// vision primitive and returns a short caption. Default model is Haiku 4.5,
// matching CTH's brain (festival-brain.ts also runs on Haiku for cost).
//
// Opt-in. No current caller. Future use: a vendor sends a photo of their
// stand setup / product / damaged signage, and the support lane captures
// a one-line caption alongside the image for the inbox preview.

import { captionImage as intakeCaption } from './intake/index.js'

export interface CaptionImageOpts {
  /** Override the Anthropic model. Default: claude-haiku-4-5-20251001. */
  model?: string
  /** Override the prompt. Default is a generic 1-2 sentence caption. */
  prompt?: string
  /** Max output tokens. */
  maxTokens?: number
}

/**
 * Caption a base64-encoded image via Claude Vision (Haiku by default).
 * Returns "" on missing ANTHROPIC_API_KEY, missing input, or any error.
 * Never throws.
 *
 * Wire-up reminder: captions are LLM output. They MUST flow through the
 * bot-guards wall (sendText / sendTemplate) before any vendor sees them.
 * The wall catches brand leaks the model might fabricate.
 */
export async function captionImage(
  base64: string,
  mediaType: string,
  opts: CaptionImageOpts = {},
): Promise<string> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || ''
  return intakeCaption(base64, mediaType, {
    anthropicKey,
    model: opts.model,
    prompt: opts.prompt,
    maxTokens: opts.maxTokens,
  })
}
