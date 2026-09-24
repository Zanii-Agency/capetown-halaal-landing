// =============================================================================
// Mass outreach template registry.
//
// Each template is a pure function (vars) => { subject, body_text, body_html }.
// body_html is rendered through the Campaign template in src/lib/email/templates
// so the brand wrapper, footer, and unsubscribe link stay consistent.
//
// Merge tags supported in every template:
//   {{first_name}}      — vendor contact_name first token
//   {{business_name}}   — vendor business_name
//   {{stall_code}}      — allocated stall code (if confirmed)
//   {{amount_due}}      — outstanding stall fee in R formatted text
//   {{due_date}}        — payment due date (e.g. "10 July 2026")
//
// Doctrine: every body string is em-dash free. The Campaign wrapper enforces
// the brand voice, but the template author is responsible for the substance.
// =============================================================================

import { render } from '@react-email/components'
import { Campaign, type CampaignProps } from '@/lib/email/templates/Campaign'
import { createElement } from 'react'
import { renderTemplate as renderInterpolated, type InterpolateVars } from '@/lib/interpolate'

export type TemplateKey =
  | 'doc_chase'
  | 'payment_reminder'
  | 'contract_sign_reminder'
  | 'stall_allocation_notice'
  | 'general_announcement'

export interface TemplateVars {
  first_name?: string | null
  business_name?: string | null
  stall_code?: string | null
  amount_due?: string | null
  due_date?: string | null
  custom_message?: string | null
  unsubscribe_url?: string | null
}

export interface RenderedTemplate {
  subject: string
  body_text: string
  body_html: string
}

// ---- merge helper ---------------------------------------------------------
// Delegates to lib/interpolate so that null / empty placeholders collapse
// cleanly: "Hi {{first_name}}," with no name renders as "Hi," not "Hi ,".

function merge(input: string, vars: TemplateVars): string {
  return renderInterpolated(input, vars as InterpolateVars)
}

// ---- spec for each template ------------------------------------------------

interface TemplateSpec {
  subject: string
  preview: string
  heading: string
  greeting?: string
  paragraphs: string[]
  cta?: { label: string; href: string }
  signoff?: string
  showEvent?: boolean
}

const SPECS: Record<TemplateKey, TemplateSpec> = {
  doc_chase: {
    subject: 'Documents still outstanding for {{business_name}}',
    preview: 'A couple of documents are still outstanding from your application.',
    heading: 'A quick nudge on outstanding documents',
    greeting: 'Hi {{first_name}},',
    paragraphs: [
      'Thanks again for applying as an exhibitor at Young at Heart Festival 2026. To finalise your application for {{business_name}}, we still need a couple of documents from you.',
      'Please log into your exhibitor portal and upload the items listed under My Documents. Once everything is in, your application moves to the next review pass.',
      '{{custom_message}}',
    ],
    cta: { label: 'Open my exhibitor portal', href: 'https://cthalaal.co.za/exhibitor' },
  },
  payment_reminder: {
    subject: 'Stall fee outstanding for {{business_name}}',
    preview: 'A friendly reminder about your stall fee.',
    heading: 'A friendly nudge on your stall fee',
    greeting: 'Hi {{first_name}},',
    paragraphs: [
      'Your stall at Young at Heart Festival 2026 is provisionally held for {{business_name}}, and we just need to settle the stall fee to fully lock it in.',
      'Amount due: {{amount_due}}. Due date: {{due_date}}.',
      'You can pay by card from the portal, or reply to this email if you prefer EFT and we will send the banking details.',
      '{{custom_message}}',
    ],
    cta: { label: 'Pay my stall fee', href: 'https://cthalaal.co.za/exhibitor' },
  },
  contract_sign_reminder: {
    subject: 'Please sign your exhibitor contract, {{business_name}}',
    preview: 'Your exhibitor contract is ready for signature.',
    heading: 'Your contract is ready for signature',
    greeting: 'Hi {{first_name}},',
    paragraphs: [
      'The exhibitor contract for {{business_name}} is waiting on your signature in the portal. It locks in your stall, the dates, and the rules of the festival.',
      'Open the portal, click Sign contract, and you are done in a minute.',
      '{{custom_message}}',
    ],
    cta: { label: 'Sign my contract', href: 'https://cthalaal.co.za/exhibitor' },
  },
  stall_allocation_notice: {
    subject: 'Your stall location at Young at Heart 2026',
    preview: 'Your stall has been allocated.',
    heading: 'You have a stall',
    greeting: 'Hi {{first_name}},',
    paragraphs: [
      'We have allocated stall {{stall_code}} to {{business_name}} for Young at Heart Festival 2026.',
      'Open the portal to see exactly where you sit on the festival map, who your neighbours are, and the load-in window for your section.',
      '{{custom_message}}',
    ],
    cta: { label: 'View my stall on the map', href: 'https://cthalaal.co.za/exhibitor' },
  },
  general_announcement: {
    subject: 'An update from Young at Heart Festival',
    preview: 'An update from the Young at Heart team.',
    heading: 'An update from Young at Heart',
    greeting: 'Hi {{first_name}},',
    paragraphs: [
      '{{custom_message}}',
    ],
    showEvent: true,
    // Brand law per Taona M13: mass / autonomous outbound carries the Zanii
    // sign-off so the recipient knows the channel. Admin-curated 1:1
    // templates (doc_chase, payment_reminder, contract_sign_reminder,
    // stall_allocation_notice) keep the human signoff because an admin
    // actually reviews each one before send. Mass announcement defaults to
    // the bot signoff for transparency.
    signoff: 'Zanii AI on behalf of Young at Heart Festival',
  },
}

/**
 * Brand sign-off helpers. Use BOT_SIGNOFF on autonomous / mass channels
 * (broadcast, auto-reply, AI-suggested replies that go out without review).
 * Use HUMAN_SIGNOFF on admin-curated 1:1 mail. Never "AI assistant" — that
 * label was explicitly rejected (KT memory feedback_sasa_always_first_person
 * + memory feedback_sasa_nisria_only — same family of brand laws).
 */
export const BOT_SIGNOFF = 'Zanii AI on behalf of Young at Heart Festival'
export const HUMAN_SIGNOFF = 'Warm regards,'

// ---- public render ---------------------------------------------------------

export async function renderTemplate(key: TemplateKey, vars: TemplateVars): Promise<RenderedTemplate> {
  const spec = SPECS[key]
  if (!spec) throw new Error(`Unknown template key: ${key}`)

  const subject = merge(spec.subject, vars)
  const mergedParagraphs = spec.paragraphs
    .map((p) => merge(p, vars))
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  // Build the React email element via Campaign for the HTML.
  const props: CampaignProps = {
    preview: merge(spec.preview, vars),
    heading: merge(spec.heading, vars),
    greeting: spec.greeting ? merge(spec.greeting, vars) : undefined,
    paragraphs: mergedParagraphs,
    cta: spec.cta,
    showEvent: spec.showEvent,
    signoff: spec.signoff,
    unsubscribeUrl: vars.unsubscribe_url ?? undefined,
  }
  const body_html = await render(createElement(Campaign, props))

  // Plain-text fallback. No HTML tags, paragraph spacing preserved.
  const lines: string[] = []
  if (props.greeting) lines.push(props.greeting, '')
  for (const p of mergedParagraphs) {
    lines.push(p, '')
  }
  if (props.cta) {
    lines.push(`${props.cta.label}: ${props.cta.href}`, '')
  }
  lines.push(props.signoff || 'Warm regards,')
  lines.push('The Young at Heart Festival Team')
  if (vars.unsubscribe_url) {
    lines.push('', `Unsubscribe: ${vars.unsubscribe_url}`)
  }
  const body_text = lines.join('\n')

  return { subject, body_text, body_html }
}

export const TEMPLATE_KEYS: TemplateKey[] = [
  'doc_chase',
  'payment_reminder',
  'contract_sign_reminder',
  'stall_allocation_notice',
  'general_announcement',
]

export const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  doc_chase: 'Documents outstanding',
  payment_reminder: 'Stall fee reminder',
  contract_sign_reminder: 'Sign contract reminder',
  stall_allocation_notice: 'Stall allocation notice',
  general_announcement: 'General announcement',
}

// ============================================================================
// Compatibility shim exports — Stream D's TemplatePicker.tsx expects these
// shapes from this module. Added here so the two streams converge without
// either side rewriting (both shipped on parallel branches). Names mirror
// the WA template registry at /lib/templates/wa-meta.ts so TemplatePicker
// can render both channels through a uniform interface.
// ============================================================================

export interface MailTemplateSpec {
  key: TemplateKey
  label: string
  /** One-liner shown next to the label in the picker. */
  description: string
  /** Merge tags this template uses (declared so the picker can render param inputs). */
  vars: Array<keyof TemplateVars>
  /** Parallel param descriptors so the picker can render uniform inputs across channels. */
  params: Array<{ key: string; label: string; placeholder?: string; required?: boolean }>
}

const TEMPLATE_VARS: Record<TemplateKey, Array<keyof TemplateVars>> = {
  doc_chase: ['first_name', 'business_name'],
  payment_reminder: ['first_name', 'business_name', 'amount_due', 'due_date'],
  contract_sign_reminder: ['first_name', 'business_name'],
  stall_allocation_notice: ['first_name', 'business_name', 'stall_code'],
  general_announcement: ['first_name', 'business_name', 'custom_message'],
}

const TEMPLATE_DESCRIPTIONS: Record<TemplateKey, string> = {
  doc_chase: 'Nudge a vendor about missing documents.',
  payment_reminder: 'Friendly stall fee reminder with amount + due date.',
  contract_sign_reminder: 'Ask a vendor to sign their exhibitor contract.',
  stall_allocation_notice: 'Tell a vendor their stall code is allocated.',
  general_announcement: 'Custom announcement with merged greeting.',
}

const VAR_LABELS: Record<keyof TemplateVars, { label: string; placeholder?: string }> = {
  first_name: { label: 'First name', placeholder: 'Aisha' },
  business_name: { label: 'Business name', placeholder: 'Aisha Eats' },
  stall_code: { label: 'Stall code', placeholder: 'F-12' },
  amount_due: { label: 'Amount due', placeholder: 'R 6,500' },
  due_date: { label: 'Due date', placeholder: '10 July 2026' },
  custom_message: { label: 'Custom message', placeholder: 'Optional extra paragraph' },
  unsubscribe_url: { label: 'Unsubscribe URL' },
}

export const MAIL_TEMPLATES: MailTemplateSpec[] = TEMPLATE_KEYS.map((key) => ({
  key,
  label: TEMPLATE_LABELS[key],
  description: TEMPLATE_DESCRIPTIONS[key],
  vars: TEMPLATE_VARS[key],
  params: TEMPLATE_VARS[key].map((v) => ({
    key: String(v),
    label: VAR_LABELS[v].label,
    placeholder: VAR_LABELS[v].placeholder,
    required: v !== 'custom_message' && v !== 'unsubscribe_url',
  })),
}))

export function findMailTemplate(key: string): MailTemplateSpec | undefined {
  return MAIL_TEMPLATES.find((t) => t.key === key)
}

/**
 * SYNC preview renderer for TemplatePicker. Returns the subject + a plain-text
 * body built directly from the spec + merged tags. Does NOT go through the
 * Campaign React renderer (which is async). The actual SEND path still calls
 * the async `renderTemplate(key, vars)` for the full HTML email body.
 *
 * Shape returned: { body, subject } to mirror the WA template preview shape.
 */
export function renderMailTemplate(
  specOrKey: MailTemplateSpec | TemplateKey,
  vars: TemplateVars,
): { subject: string; body: string; body_text: string; body_html: string } {
  const key: TemplateKey = typeof specOrKey === 'string' ? specOrKey : specOrKey.key
  const spec = SPECS[key]
  if (!spec) return { subject: '(unknown template)', body: '', body_text: '', body_html: '' }
  const subject = merge(spec.subject, vars)
  const paragraphs = spec.paragraphs
    .map((p) => merge(p, vars))
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const lines: string[] = []
  if (spec.greeting) lines.push(merge(spec.greeting, vars), '')
  for (const p of paragraphs) lines.push(p, '')
  if (spec.cta) lines.push(`${spec.cta.label}: ${spec.cta.href}`, '')
  lines.push(spec.signoff || 'Warm regards,')
  lines.push('The Young at Heart Festival Team')
  const text = lines.join('\n').trim()
  // For the SYNC preview path we expose body_html === body_text (plain text
  // wrapped in <pre>). The actual SEND path calls renderTemplate(key, vars)
  // which goes through react-email Campaign for the real HTML.
  const html = `<pre style="font-family:sans-serif;white-space:pre-wrap">${text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))}</pre>`
  return { subject, body: text, body_text: text, body_html: html }
}

/**
 * Synchronous text-only preview for the composer UI. Skips react-email HTML
 * rendering (which is async), returns subject + body text shaped like the wa
 * preview so the picker can render both channels uniformly.
 */
export function renderMailTemplatePreview(
  spec: MailTemplateSpec,
  vars: TemplateVars,
): { subject: string; body: string } {
  const tspec = SPECS[spec.key]
  if (!tspec) return { subject: '', body: '' }
  const subject = merge(tspec.subject, vars)
  const lines: string[] = []
  if (tspec.greeting) lines.push(merge(tspec.greeting, vars), '')
  for (const p of tspec.paragraphs) {
    const m = merge(p, vars).trim()
    if (m) lines.push(m, '')
  }
  if (tspec.cta) lines.push(`${tspec.cta.label}: ${tspec.cta.href}`, '')
  lines.push(tspec.signoff || 'Warm regards,')
  lines.push('The Young at Heart Festival Team')
  return { subject, body: lines.join('\n').trim() }
}

/**
 * Validate that every required merge tag for the given template has a non-empty
 * value. Returns { ok: true } or { ok: false, missing: string[] }. The picker uses
 * this to enable/disable the "Send" button.
 */
export function validateMailTemplate(
  specOrKey: MailTemplateSpec | TemplateKey,
  vars: TemplateVars,
): { ok: true } | { ok: false; error: string; missing: string[] } {
  const key: TemplateKey = typeof specOrKey === 'string' ? specOrKey : specOrKey.key
  const spec = findMailTemplate(key)
  if (!spec) return { ok: false, error: 'Template not found', missing: ['(template not found)'] }
  // custom_message + unsubscribe_url are optional everywhere.
  const required = spec.vars.filter((v) => v !== 'custom_message' && v !== 'unsubscribe_url')
  const missing = required.filter((v) => {
    const val = vars[v]
    return val == null || String(val).trim() === ''
  }).map(String)
  if (missing.length === 0) return { ok: true }
  return { ok: false, error: `Missing: ${missing.join(', ')}`, missing }
}

// ---- free text in the branded layout ---------------------------------------

// The FIRST LINE must be only a sign-off phrase ("Thank you for your payment." is a sentence, not a sign-off).
const SIGNOFF_RE = /^(((kind|warm|best)\s+)?regards|thanks|thank you|many thanks|sincerely|cheers)[,.!]?$/i
const noDash = (s: string) => s.replace(/\s*[\u2013\u2014]\s*/g, ', ') // Law 7, subject + body

/** Split an operator's typed email into paragraphs (blank line = new paragraph,
 *  single newline kept) and pull a trailing sign-off off the body so the branded
 *  layout's own sign-off line uses THEIR words instead of repeating one. */
export function freeTextParts(text: string): { paragraphs: string[]; signoff?: string } {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const last = paragraphs[paragraphs.length - 1]
  const lines = last ? last.split('\n').map((l) => l.trim()).filter(Boolean) : []
  if (lines.length && lines.length <= 3 && SIGNOFF_RE.test(lines[0])) {
    // Keep every word she typed: "Kind regards,\nSamreen" -> "Kind regards, Samreen".
    paragraphs.pop()
    return { paragraphs, signoff: lines.join(' ') }
  }
  return { paragraphs }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

/** Free-text email in the SAME branded Campaign layout the templates use (Taona
 *  2026-09-24: "keep the formatting of the email that would have been sent"). */
export async function renderFreeTextEmail(text: string, subject: string, unsubscribeUrl?: string | null): Promise<string> {
  subject = noDash(subject)
  const { paragraphs, signoff } = freeTextParts(noDash(text))
  const bodyHtml = paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br/>')}</p>`).join('')
  return render(createElement(Campaign, {
    preview: (paragraphs[0] || subject).slice(0, 120),
    heading: subject,
    bodyHtml,
    signoff,
    unsubscribeUrl: unsubscribeUrl ?? undefined,
  }))
}
