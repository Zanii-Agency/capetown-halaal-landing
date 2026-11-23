// CTH adapter over @zanii/intake transcribeAudio.
//
// Thin shim: hands the OpenAI key from CTH's environment to the intake
// primitive and returns the transcript. Intake is fully tenant-agnostic;
// this adapter is the place where CTH-specific concerns (which key, which
// default model, future tracing/quota plumbing) get wired in.
//
// Opt-in. No current caller. Lives here so the future "talk to human" /
// vendor-support lane (voice notes from vendors → text we can store) can
// import a stable CTH-local entry point without reaching across packages.

import { transcribeAudio as intakeTranscribe } from './intake/index.js'

export interface TranscribeOpts {
  /** Override the default OpenAI transcription model. */
  model?: string
}

/**
 * Transcribe a base64-encoded audio clip to text via OpenAI.
 * Returns "" on missing OPENAI_API_KEY, missing input, or any error.
 * Never throws.
 *
 * Wire-up reminder: any vendor-facing transcript that flows back to a
 * vendor reply MUST still pass through sendText() (and therefore the
 * bot-guards wall) before leaving CTH. Transcripts can carry brand names
 * the vendor spoke aloud, so they are NOT trusted output.
 */
export async function transcribeAudio(
  base64: string,
  mime: string,
  opts: TranscribeOpts = {},
): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY || ''
  return intakeTranscribe(base64, mime, { openaiKey, model: opts.model })
}
