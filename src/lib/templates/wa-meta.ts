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
  // ---------------------------------------------------------------------------
  // PAID-COHORT MESSAGE SUITE — added 2026-09-02. A flexible, two-way channel to
  // the paid vendor union (Yoco / master-EFT / cash / waived / Samreen, i.e. the
  // `paid=true` audience). Each is UTILITY so it dodges the marketing cap that
  // silently dropped festival_announcement (0/1000). Shape is identical for all
  // three: {{1}} = first name, {{2}} = the operator's free message. The approved
  // body carries a "reply here on WhatsApp" invite so a vendor's reply reopens
  // the 24h window and lands in the existing inbox/bot. Keep {{2}} transactional
  // (about their confirmed stall); promotional content can get the SEND
  // re-categorised as marketing by Meta and re-capped.
  // ACTION REQUIRED (operator): create + approve these EXACT names (UTILITY,
  // English) at Meta against the YAH WABA before they deliver. Bodies live in
  // docs/whatsapp-templates.md; submit via scripts/submit-whatsapp-template.mjs.
  // ---------------------------------------------------------------------------
  {
    key: 'paid_vendor_update',
    label: 'Paid vendor update (2-way)',
    description: 'Send any update to a paid vendor about their confirmed stall. Invites a reply.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, a message from Young at Heart Festival 2026 about your confirmed stall:\n\n{{2}}\n\nYou can reply here on WhatsApp if you have any questions. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Your message', placeholder: 'Setup opens Thursday 10 December from 09:00.', required: true },
    ],
  },
  {
    key: 'paid_vendor_action_required',
    label: 'Paid vendor action needed (2-way)',
    description: 'Ask a paid vendor to do one thing for their confirmed stall. Invites a reply.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, one thing needs your attention for your confirmed stall at Young at Heart Festival 2026:\n\n{{2}}\n\nReply here on WhatsApp and we will help, or complete it in your portal: https://cthalaal.co.za/exhibitor/portal. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Action needed', placeholder: 'Upload your logo so you appear in the public listings.', required: true },
    ],
  },
  {
    key: 'paid_vendor_question',
    label: 'Paid vendor question (2-way)',
    description: 'Ask a paid vendor a question and collect their answer by reply.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, a quick question about your confirmed stall at Young at Heart Festival 2026:\n\n{{2}}\n\nJust reply here on WhatsApp with your answer. Thank you. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Your question', placeholder: 'What time will your team arrive on setup day?', required: true },
    ],
  },
  {
    key: 'paid_vendor_setup_details',
    label: 'Paid vendor setup details (2-way)',
    description: 'Send setup-day logistics to a paid vendor about their confirmed stall. Invites a reply.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, setup details for your confirmed stall at Young at Heart Festival 2026:\n\n{{2}}\n\nBring your vehicle pass and stall confirmation on the day. Reply here on WhatsApp if anything is unclear. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Setup details', placeholder: 'Setup opens Thursday 10 December from 09:00 at Youngsfield.', required: true },
    ],
  },
  {
    key: 'paid_vendor_schedule_update',
    label: 'Paid vendor schedule update (2-way)',
    description: 'Tell a paid vendor about a timing or schedule change for their confirmed stall.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, an update to the schedule for your confirmed stall at Young at Heart Festival 2026:\n\n{{2}}\n\nPlease note the change. Reply here on WhatsApp if this affects your plans. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Schedule change', placeholder: 'Trading now starts at 10:00 on the Saturday, not 09:00.', required: true },
    ],
  },
  {
    key: 'paid_vendor_reminder',
    label: 'Paid vendor reminder (2-way)',
    description: 'A friendly reminder to a paid vendor about their confirmed stall. Invites a reply.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, a friendly reminder for your confirmed stall at Young at Heart Festival 2026:\n\n{{2}}\n\nReply here on WhatsApp if you need a hand. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Reminder', placeholder: 'Please confirm your final stall layout by 1 December.', required: true },
    ],
  },
  {
    key: 'paid_vendor_good_news',
    // Meta re-categorised this to MARKETING on approval (2026-09-02): the "good
    // news / glad to have you" register reads promotional to Meta's classifier.
    // Kept by operator decision despite the 131049 marketing cap, so it can
    // under-deliver like festival_announcement. Category here MUST match Meta
    // (source of truth) or canSend applies the wrong window rules.
    label: 'Paid vendor good news (MARKETING, may be capped)',
    description: 'Positive/welcome note. Meta categorised this MARKETING, so it is subject to the delivery cap. For guaranteed delivery use paid_vendor_update instead.',
    category: 'marketing',
    lang: 'en',
    previewBody:
      'Hi {{1}}, good news about your confirmed stall at Young at Heart Festival 2026:\n\n{{2}}\n\nWe are glad to have you with us. Reply here on WhatsApp anytime. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Good news', placeholder: 'Your stall is now live in the public vendor listings.', required: true },
    ],
  },
  {
    // Admin-only. Owner/master alerts outside the 24h window (notify.ts). NOT
    // for vendors and NOT in the picker's intent: it carries no festival copy.
    key: 'admin_alert',
    label: 'Admin alert',
    description: 'Internal: owner/master alert when their 24h window is shut.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, an item on the Young at Heart Festival admin desk needs your attention:\n\n{{2}}\n\nOpen the admin inbox to action it.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Samreen', required: true },
      { key: 'alert', label: 'Alert', placeholder: 'VENDOR SUPPORT MESSAGE - ...', required: true },
    ],
  },
  // ---------------------------------------------------------------------------
  // MASTER-LANE (unpaid EFT cohort) message. The 2-way twin of paid_vendor_update
  // for vendors on the EFT lane (collected / proof-uploaded / ⟦EFT⟧, not yet
  // Yoco-reconciled), used by the /admin/eft Outreach composer. Copy says "your
  // stall", NEVER "confirmed" (they are mid-settlement). UTILITY so it dodges the
  // general_announcement marketing cap (0/1000). {{1}} = first name, {{2}} = the
  // operator's free message. Keep {{2}} transactional (about their stall) so Meta
  // does not re-categorise the send as marketing.
  // ACTION REQUIRED (operator): create + approve this EXACT name (UTILITY, English)
  // at Meta against the YAH WABA. Body in docs/whatsapp-templates.md; submit via
  // scripts/submit-whatsapp-template.mjs. Until approved the WA send fails
  // observably (wa_messages status 'failed'), never silently.
  // ---------------------------------------------------------------------------
  {
    key: 'master_lane_update',
    label: 'Master-lane update (2-way)',
    description: 'Send any update to an EFT-lane vendor about their stall. Invites a reply.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, a message from Young at Heart Festival 2026 about your stall:\n\n{{2}}\n\nYou can reply here on WhatsApp if you have any questions. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Your message', placeholder: 'We have received your EFT, thank you.', required: true },
    ],
  },
  // ---------------------------------------------------------------------------
  // PAYMENT-CHECK SUITE — added 2026-09-02. Flexible two-way UTILITY templates
  // for following up on / confirming a vendor's payment. Same [first_name,
  // message] shape as the paid + master-lane suites. Copy says "your stall"
  // (not "confirmed") because these go to vendors who have NOT paid yet. Audience
  // + lane rules are enforced at the send layer (chase 403 gate / broadcast
  // paid=false filter), never in the template body, which carries no amount/PII.
  // Submit the exact names below (UTILITY, en) at Meta before they deliver.
  // ---------------------------------------------------------------------------
  {
    key: 'payment_check',
    label: 'Payment check (2-way)',
    description: 'Follow up with a vendor on their stall payment. Invites a reply.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, we are checking in on the payment for your stall at Young at Heart Festival 2026:\n\n{{2}}\n\nReply here on WhatsApp if you have any questions or need the payment link again. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Your message', placeholder: 'Your stall fee of R3,500 is still outstanding.', required: true },
    ],
  },
  {
    key: 'payment_proof_request',
    label: 'Payment proof request (2-way)',
    description: 'Ask a vendor to reply with proof of a payment they say they made.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, we are confirming the payment for your stall at Young at Heart Festival 2026:\n\n{{2}}\n\nIf you have already paid, please reply here on WhatsApp with your proof of payment (a screenshot or PDF). The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Your message', placeholder: 'We do not yet see your payment on our side.', required: true },
    ],
  },
  {
    key: 'payment_arrangement_check',
    label: 'Payment arrangement check (2-way)',
    description: 'Check in on an agreed payment plan or extension for a vendor stall.',
    category: 'utility',
    lang: 'en',
    previewBody:
      'Hi {{1}}, we are checking in on the payment arrangement for your stall at Young at Heart Festival 2026:\n\n{{2}}\n\nReply here on WhatsApp to confirm or if anything has changed. The YAH Team.',
    params: [
      { key: 'first_name', label: 'First name', placeholder: 'Aisha', required: true },
      { key: 'message', label: 'Your message', placeholder: 'Your agreed instalment was due on 15 November.', required: true },
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

/**
 * The paid-cohort message suite (name + free message + reply invite). Every
 * template here takes exactly two body vars, in this order: [first_name, message].
 * Exported so the broadcast + chase allowlists and their positional-var builders
 * stay in sync from one source instead of hardcoding the names three times.
 */
export const PAID_VENDOR_MESSAGE_TEMPLATE_KEYS = [
  'paid_vendor_update',
  'paid_vendor_action_required',
  'paid_vendor_question',
  'paid_vendor_setup_details',
  'paid_vendor_schedule_update',
  'paid_vendor_reminder',
  'paid_vendor_good_news',
] as const

/**
 * The master-lane (unpaid EFT cohort) message suite. Same [first_name, message]
 * two-var shape as the paid suite, but for the /admin/eft Outreach composer's
 * audience (EFT-lane vendors, not yet reconciled). Kept as its own export so the
 * chase allowlist and the var mapper pick it up without conflating it with the
 * paid cohort.
 */
export const MASTER_LANE_MESSAGE_TEMPLATE_KEYS = ['master_lane_update'] as const

/**
 * Payment-follow-up suite. Same [first_name, message] two-var shape, for
 * checking on / confirming a vendor's payment (unpaid cohort). Own export so the
 * send-route allowlists and the var mapper pick it up without conflating it with
 * the paid or master-lane cohorts.
 */
export const PAYMENT_CHECK_MESSAGE_TEMPLATE_KEYS = [
  'payment_check',
  'payment_proof_request',
  'payment_arrangement_check',
] as const

// Every two-var [first_name, message] template: paid + master-lane + payment-check.
const TWO_VAR_MESSAGE_TEMPLATES = new Set<string>([
  ...PAID_VENDOR_MESSAGE_TEMPLATE_KEYS,
  ...MASTER_LANE_MESSAGE_TEMPLATE_KEYS,
  ...PAYMENT_CHECK_MESSAGE_TEMPLATE_KEYS,
])

/**
 * Build the ordered positional variables Meta expects for a broadcast/chase WA
 * send, per template. The paid-cohort suite is a strict [first_name, message]
 * pair; every other template keeps the legacy [name, business, stall, message]
 * order with empty slots dropped. Centralised here so the two send routes map
 * vars identically and cannot drift.
 */
export function waBroadcastVariables(
  templateKey: string,
  v: { firstName?: string | null; businessName?: string | null; stallCode?: string | null; message?: string | null },
): string[] {
  const name = (v.firstName || '').trim() || 'there'
  const msg = (v.message || '').trim()
  if (TWO_VAR_MESSAGE_TEMPLATES.has(templateKey)) {
    // {{1}} = name, {{2}} = the operator's message. The message is required by
    // the approved body; an empty {{2}} fails observably at Meta (logged) rather
    // than shipping a blank slot, which is the correct loud failure.
    //
    // Meta rejects raw newlines/tabs INSIDE a body parameter (this flattened a
    // digest in prod twice), so the variable stays one flowing line. Paragraph
    // structure lives in the fixed, approved template body around {{2}}, not in
    // the operator's text.
    const oneLine = msg.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
    return [name, oneLine]
  }
  return [name, (v.businessName || '').trim(), (v.stallCode || '').trim(), msg].filter((s) => s.length > 0)
}
