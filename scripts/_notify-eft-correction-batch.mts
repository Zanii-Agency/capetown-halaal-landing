// Correction batch: between 2026-06-28 and 2026-07-10 the OLD festival-brain
// LLM told these vendors an EFT/bank-transfer option exists ("card/EFT option"
// in the portal, or "bank details for EFT"). CTH does not accept EFT, ever
// (hard rule). Root cause fixed in system-prompt.ts + a grounded FAQ added
// (vendor_payment_method). This sends each vendor the correction.
import { config } from 'dotenv'
config({ path: '.env.local' })
const { sendTemplate } = await import('../src/lib/whatsapp')

const MSG =
  'Correction: our earlier message mentioning an EFT or bank transfer option was wrong, sorry for the confusion. ' +
  'We only accept card payment (Yoco) for stall fees, through your exhibitor portal. ' +
  'Please log in at cthalaal.co.za/exhibitor/login, open Payments, and pay by card there. ' +
  'Reply here if you cannot access the portal and we will send the payment link directly.'

const vendors = [
  { name: 'Jess', phone: '+27848279730' },       // Primal Wellness
  { name: 'Shahieda', phone: '+27837001182' },   // 53 Plumtree Studio
  { name: 'Shabnam', phone: '+27723066786' },    // Exclusive Hijabs
  { name: 'Razaan', phone: '+27629601771' },     // Retrodaisy
  { name: 'Asif', phone: '+27714213486' },       // Fragrances by Naz
]

for (const v of vendors) {
  const r = await sendTemplate(v.phone, 'festival_announcement', [v.name, MSG], { category: 'utility' })
  console.log(v.phone, JSON.stringify(r))
}
