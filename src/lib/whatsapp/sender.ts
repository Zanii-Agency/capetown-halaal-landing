// =============================================================================
// WhatsApp template send stub.
//
// We don't yet have a Meta WABA wired into this codebase, so this is a thin
// adapter pattern: callers always call `sendTemplate(input)` and we either
// hit the Meta Cloud API (when env wired) or no-op with a clear pending result
// that the broadcast loop logs to mail_messages-equivalent later.
//
// The chokepoint is intentional. When WABA lands, replace the body of this
// function only. No call site needs to change.
// =============================================================================

import { logWhatsAppOutbound } from '../outbound-log'

const WABA_TOKEN = (process.env.META_WABA_TOKEN || '').trim()
const WABA_PHONE_NUMBER_ID = (process.env.META_WABA_PHONE_NUMBER_ID || '').trim()
const WABA_GRAPH_VERSION = (process.env.META_WABA_GRAPH_VERSION || 'v21.0').trim()

export interface WaSendTemplateInput {
  /** E.164 phone, no +. e.g. "27659435012" */
  to: string
  /** Approved Meta template name. */
  template: string
  /** Variable values, ordered to match template. */
  variables?: string[]
  /** Language code, default en. */
  lang?: string
}

export interface WaSendResult {
  ok: boolean
  providerMessageId?: string
  error?: string
  statusCode?: number
  skipped?: boolean
}

export async function sendTemplate(input: WaSendTemplateInput): Promise<WaSendResult> {
  if (!WABA_TOKEN || !WABA_PHONE_NUMBER_ID) {
    // Skipping — caller should log as pending. NOT an error, so broadcast
    // counters do not turn red just because WABA isn't live yet.
    return { ok: false, skipped: true, error: 'WABA not configured' }
  }
  const url = `https://graph.facebook.com/${WABA_GRAPH_VERSION}/${WABA_PHONE_NUMBER_ID}/messages`
  const components = (input.variables && input.variables.length)
    ? [{
        type: 'body',
        parameters: input.variables.map((text) => ({ type: 'text', text })),
      }]
    : []
  const body = {
    messaging_product: 'whatsapp',
    to: input.to.replace(/[^0-9]/g, ''),
    type: 'template',
    template: {
      name: input.template,
      language: { code: input.lang || 'en' },
      ...(components.length ? { components } : {}),
    },
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WABA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, statusCode: res.status, error: (json?.error?.message as string) || `WABA HTTP ${res.status}` }
    }
    const id = json?.messages?.[0]?.id as string | undefined
    await logWhatsAppOutbound({
      phone: input.to,
      body: `[Template: ${input.template}]`,
      providerMessageId: id || null,
      templateName: input.template,
      metadata: { variables: input.variables },
    })
    return { ok: true, providerMessageId: id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export const WABA_CONFIGURED = !!(WABA_TOKEN && WABA_PHONE_NUMBER_ID)
