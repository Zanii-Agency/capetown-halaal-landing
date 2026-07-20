/**
 * Meta-approved WhatsApp template registry.
 *
 * Single source of truth for the templates the inbox composer can stage and
 * send. Names here MUST match the exact `name` field of templates Meta has
 * approved against the YAH WABA. The categories drive 24h-window / utility vs
 * marketing rules in `lib/whatsapp.canSend`.
 *
 * Params are described declaratively so the picker can render the right input
 * fields and the reply endpoint can validate the payload before hitting Meta.
 *
 * Doctrine guard (CTH-DOCTRINE law 7): every example/label is em-dash free.
 * Brand law: first-contact templates carry the "Zanii AI on behalf of Young at
 * Heart" sign-off inside the Meta-approved body — we don't append it here.
 */
export type WaTemplateCategory = 'utility' | 'marketing' | 'authentication'

export interface WaTemplateParam {
  key: string
  label: string
  placeholder?: string
  example?: string
  required?: boolean
}

export interface WaTemplateSpec {
  key: string // Meta template name (Meta-approved, case-sensitive)
  label: string // Human label for the picker
  description: string // One-liner shown in the picker
  category: WaTemplateCategory
  lang: string // BCP-47 / Meta lang code, e.g. 'en'
  params: WaTemplateParam[]
  // Friendly preview body — NOT what Meta sends. Meta sends the approved copy;
  // this is what the operator reads in the picker. Mirrors the approved body
  // with {{n}} interpolated for clarity.
  previewBody: string
}

export const WA_META_TEMPLATES: WaTemplateSpec[] = [
  {
    key: 'vendor_application_approved',
    label: 'Vendor application approved',
    description: 'Congratulate a vendor on approval and share their stall code.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Great news {{1}}! Your stall application for Young at Heart Festival 2026 is approved. Your stall: {{2}}. We will share setup details and a payment link shortly.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'stall_code', label: 'Stall code', placeholder: 'F-12', required: true },
    ],
  },
  {
    key: 'vendor_document_request',
    label: 'Vendor document request',
    description: 'Ask a vendor for a missing document (licence, ID, insurance).',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, we still need the following document to finalise your stall: {{2}}. You can reply here with a clear photo or PDF.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      {
        key: 'document_label',
        label: 'Document needed',
        placeholder: 'Public liability insurance certificate',
        required: true,
      },
    ],
  },
  {
    key: 'vendor_payment_reminder',
    label: 'Vendor payment reminder',
    description: 'Remind a vendor that their stall payment is due.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, this is a friendly reminder that your stall fee of R{{2}} is due on {{3}}. Reply here if you need the payment link again.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'amount', label: 'Amount (ZAR)', placeholder: '3500', required: true },
      { key: 'due_date', label: 'Due date', placeholder: '20 June 2026', required: true },
    ],
  },
  {
    key: 'vendor_stall_allocation',
    label: 'Vendor stall allocation',
    description: 'Inform a vendor of their final stall allocation and section.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, your final stall allocation is {{2}} in {{3}}. The vendor portal map shows your exact location and your neighbours.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'stall_code', label: 'Stall code', placeholder: 'F-12', required: true },
      { key: 'section_name', label: 'Section', placeholder: 'Food Court', required: true },
    ],
  },
  {
    key: 'vendor_setup_reminder',
    label: 'Vendor setup reminder',
    description: 'Remind a vendor about setup day timing and entry process.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, setup at Youngsfield Military Base opens on Thursday 10 December from 09:00. Bring your vehicle pass and stall confirmation.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
    ],
  },
  {
    key: 'vendor_application_declined',
    label: 'Vendor application declined',
    description: 'Notify a vendor their application was not selected.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, thank you for applying to Young at Heart Festival 2026. After a careful review we are not able to offer a stall this year. Your details stay on file for future events.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
    ],
  },
  // ---------------------------------------------------------------------------
  // PENDING META APPROVAL — added 2026-06-22 to stop notifyVendor silently 400ing
  // on template names Meta never had. The two events below (document approved /
  // document rejected) fire from an ADMIN action in the workbench, so the vendor
  // is almost never inside the 24h customer service window. A free-form sendText
  // would be blocked by canSend and never deliver, so these MUST go via a
  // business-initiated template. The exact `key` names below must be CREATED AND
  // APPROVED in Meta Business Manager against the YAH WABA before they will
  // actually deliver. Until approved, the send will skip/fail observably (logged
  // by notifyVendor) instead of silently 400ing on a name that can never exist.
  // ---------------------------------------------------------------------------
  {
    key: 'vendor_document_approved',
    label: 'Vendor document approved',
    description: 'Confirm to a vendor that a submitted document was approved.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, good news. Your {{2}} has been approved. Thank you for submitting. You can review your documents in the vendor portal.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'document_label', label: 'Document', placeholder: 'food handling certificate', required: true },
    ],
  },
  {
    key: 'vendor_document_rejected',
    label: 'Vendor document needs attention',
    description: 'Tell a vendor a submitted document was not approved and why.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, your {{2}} was not approved. Reason: {{3}}. Please log in to the vendor portal to upload a replacement.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'document_label', label: 'Document', placeholder: 'food handling certificate', required: true },
      { key: 'reason', label: 'Reason', placeholder: 'image was blurry', required: true },
    ],
  },
  // ---------------------------------------------------------------------------
  // PENDING META APPROVAL — added 2026-06-23 to stop confirmPayment() silently
  // skipping the paid-confirmation WhatsApp. confirmPayment() (lib/payments/
  // confirm.ts) fires this template on the unpaid -> paid transition, but the
  // name was never registered here, so findWaTemplate('vendor_payment_
  // confirmation') returned undefined and the vendor got the email but no
  // WhatsApp. Param order below MUST match the exact sendTemplate() call in
  // confirm.ts: [firstName, formatRand(amount), pricing.stallLabel]
  //   {{1}} = first_name      (e.g. "Aisha")
  //   {{2}} = amount          (already a formatted Rand string, e.g. "R3,500")
  //   {{3}} = stall_label     (e.g. "Food stall F-12")
  // NOTE: amount arrives PRE-FORMATTED as "R3,500" (formatRand), so the approved
  // Meta body must NOT prepend its own "R" before {{2}}.
  // ACTION REQUIRED (operator): this exact `key` ('vendor_payment_confirmation')
  // must be CREATED AND APPROVED in Meta Business Manager against the YAH WABA
  // before it will actually deliver. Until approved, the send fails observably
  // (logged + written to wa_messages with status 'failed') instead of silently
  // skipping.
  // ---------------------------------------------------------------------------
  {
    key: 'vendor_payment_confirmation',
    label: 'Vendor payment confirmation',
    description: 'Confirm to a vendor that their stall payment was received.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Payment received, {{1}}. We have confirmed {{2}} for your stall: {{3}}. Your trading spot at Young at Heart Festival 2026 is secured. Welcome to the family.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'amount', label: 'Amount (formatted Rand)', placeholder: 'R3,500', required: true },
      { key: 'stall_label', label: 'Stall', placeholder: 'Food stall F-12', required: true },
    ],
  },
  // ---------------------------------------------------------------------------
  // PENDING META APPROVAL — added 2026-06-25 for the logo-upload campaign. Paid
  // vendors are almost never inside the 24h customer service window, so this
  // proactive nudge MUST go via a business-initiated template. Create + approve
  // a template named EXACTLY `vendor_logo_reminder` (English, Utility category)
  // in Meta Business Manager against the YAH WABA with this body before it will
  // deliver. Until approved, notifyVendor / the logo-campaign endpoint will skip
  // observably (logged) instead of silently failing.
  // ---------------------------------------------------------------------------
  {
    key: 'vendor_logo_reminder',
    label: 'Vendor logo reminder',
    description: 'Ask a paid vendor to upload their logo so they go live in the public sector listings.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, your stall at Young at Heart Festival 2026 is paid and confirmed. One step left: upload your logo in your vendor portal so you appear with your branding in the public sector listings shoppers browse. It takes under a minute: https://cthalaal.co.za/exhibitor/portal/profile',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
    ],
  },
]

export function findWaTemplate(key: string): WaTemplateSpec | undefined {
  return WA_META_TEMPLATES.find((t) => t.key === key)
}

/**
 * Validate a params payload against the template spec.
 * Returns the ordered string[] Meta expects, or an error message.
 */
export function buildWaTemplateParams(
  spec: WaTemplateSpec,
  params: Record<string, string>
): { ok: true; ordered: string[] } | { ok: false; error: string } {
  const ordered: string[] = []
  for (const p of spec.params) {
    const v = (params[p.key] ?? '').trim()
    if (p.required && !v) {
      return { ok: false, error: `missing required param: ${p.key}` }
    }
    ordered.push(v)
  }
  return { ok: true, ordered }
}

/**
 * Render the friendly preview body with the param values filled in.
 * Used by the picker preview pane and the AI summary suggested replies.
 */
export function renderWaTemplatePreview(
  spec: WaTemplateSpec,
  params: Record<string, string>
): string {
  let out = spec.previewBody
  spec.params.forEach((p, i) => {
    const v = (params[p.key] ?? '').trim() || `{{${i + 1}}}`
    out = out.replaceAll(`{{${i + 1}}}`, v)
  })
  return out
}
