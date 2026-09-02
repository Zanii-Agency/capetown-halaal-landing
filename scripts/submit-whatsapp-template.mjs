#!/usr/bin/env node
// Submit a WhatsApp template to Meta for approval via Graph API.
// Usage:  node scripts/submit-whatsapp-template.mjs <template_name>
// Reads body verbatim from docs/whatsapp-templates.md.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const envPath = path.join(repo, '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/i)
    if (!m) continue
    const k = m[1]; let v = m[2]
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    if (!process.env[k]) process.env[k] = v.replace(/\\n$/, '')
  }
}

const NAME = process.argv[2]
if (!NAME) { console.error('usage: submit-whatsapp-template.mjs <template_name>'); process.exit(1) }
const TOKEN = (process.env.WHATSAPP_TOKEN || '').trim()
const WABA = (process.env.WHATSAPP_BUSINESS_ID || '').trim()
if (!TOKEN || !WABA) { console.error('WHATSAPP_TOKEN / WHATSAPP_BUSINESS_ID missing'); process.exit(1) }

// Read body verbatim from the markdown doc, section per template name.
const doc = fs.readFileSync(path.join(repo, 'docs/whatsapp-templates.md'), 'utf8')
const sectionRe = new RegExp(`\\\`${NAME}\\\`[\\s\\S]*?\\*\\*Body:\\*\\*\\s*\\n\\s*\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\``, 'i')
const m = doc.match(sectionRe)
if (!m) { console.error(`template ${NAME} not found in docs/whatsapp-templates.md`); process.exit(1) }
const body = m[1].trim()

// Variable examples for Meta approval (they require a sample of each {{N}})
const VAR_SAMPLES = {
  vendor_application_approved: ['Samreen', 'Samreen Test Stall', '1 September 2026'],
  vendor_payment_confirmation: ['Samreen', 'R6 500', 'MARQUEE Full Space 3x3m'],
  // Paid-cohort message suite: {{1}} = first name, {{2}} = the operator's message.
  paid_vendor_update: ['Samreen', 'Setup opens Thursday 10 December from 09:00. Please bring your vehicle pass and stall confirmation.'],
  paid_vendor_action_required: ['Samreen', 'Upload your logo so you appear in the public listings.'],
  paid_vendor_question: ['Samreen', 'What time will your team arrive on setup day?'],
  paid_vendor_setup_details: ['Samreen', 'Setup opens Thursday 10 December from 09:00 at Youngsfield Military Base.'],
  paid_vendor_schedule_update: ['Samreen', 'Trading now starts at 10:00 on the Saturday, not 09:00.'],
  paid_vendor_reminder: ['Samreen', 'Please confirm your final stall layout by 1 December.'],
  paid_vendor_good_news: ['Samreen', 'Your stall is now live in the public vendor listings.'],
  master_lane_update: ['Samreen', 'We have received your EFT, thank you.'],
  payment_check: ['Samreen', 'Your stall fee of R3,500 is still outstanding.'],
  payment_proof_request: ['Samreen', 'We do not yet see your payment on our side.'],
  payment_arrangement_check: ['Samreen', 'Your agreed instalment was due on 15 November.'],
}
const examples = VAR_SAMPLES[NAME] || []

const payload = {
  name: NAME,
  language: 'en',
  category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: body,
      ...(examples.length ? { example: { body_text: [examples] } } : {}),
    },
  ],
}

console.log(`Submitting ${NAME} to WABA ${WABA}…`)
const res = await fetch(`https://graph.facebook.com/v20.0/${WABA}/message_templates`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
})
const json = await res.json()
console.log(JSON.stringify(json, null, 2))
if (!res.ok) process.exit(1)
console.log(`\n✓ Submitted. Approval typically takes 5-60 min.`)
console.log(`Check status:  node scripts/list-whatsapp-templates.mjs`)
