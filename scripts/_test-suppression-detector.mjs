// One-shot self-check for the confirmDelivery suppression detector (KT #206657).
// Sends two real emails: one to a known-suppressed address (must come back
// ok:false suppressed:true) and one to the festival's own inbox (must stay ok:true).
// Run: npx tsx scripts/_test-suppression-detector.mjs
import { config } from 'dotenv'
config({ path: '.env.local' })

const { sendEmail } = await import('../src/lib/email/resend.ts')

const suppressed = await sendEmail({
  to: 'taona@zanii.agency', // proven suppressed on Resend 2026-07-11
  subject: 'CTH suppression-detector self-test (expect: never delivered)',
  text: 'If you can read this, the address is no longer suppressed.',
  confirmDelivery: true,
})
console.log('SUPPRESSED-ADDRESS RESULT:', JSON.stringify(suppressed))

const healthy = await sendEmail({
  to: 'support@youngatheart.co.za',
  subject: 'CTH suppression-detector self-test (control)',
  text: 'Control send: this address is healthy, result must be ok:true.',
  confirmDelivery: true,
})
console.log('HEALTHY-ADDRESS RESULT:', JSON.stringify(healthy))

const pass = suppressed.ok === false && suppressed.suppressed === true && healthy.ok === true
console.log(pass ? 'PASS: detector catches suppression, no false positive' : 'FAIL')
process.exit(pass ? 0 : 1)
