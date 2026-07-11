// Correction: on 2026-07-10 the OLD festival-brain LLM told this vendor (AMC
// Cookware / Sakiena, +27744520230) "the team will send EFT details via
// email" — CTH does not accept EFT (hard rule). Fixed the prompt hint + added
// a grounded FAQ (vendor_payment_method). This sends the correction.
import { config } from 'dotenv'
config({ path: '.env.local' })
const { sendTemplate } = await import('../src/lib/whatsapp')
const MSG =
  'Apologies, our earlier message about emailing EFT bank details was wrong. ' +
  'We do not accept EFT, stall fees are paid by card only through your exhibitor portal. ' +
  'Please log in at cthalaal.co.za/exhibitor/login, open your invoice, and pay there. ' +
  'Reply here if you cannot access the portal and we will send the payment link directly.'
const r = await sendTemplate('+27744520230', 'festival_announcement', ['Sakiena', MSG], { category: 'utility' })
console.log(JSON.stringify(r))
