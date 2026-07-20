// One-off: tell KOCO AND DESIGN (reported "Could not generate badge" on
// WhatsApp 2026-07-07) that staff badges now work. Email via Resend with
// confirmDelivery + WhatsApp via the approved template (outside 24h window).
import { config } from 'dotenv'
config({ path: '.env.local' })

const { sendEmail } = await import('../src/lib/email/resend')
const { sendTemplate } = await import('../src/lib/whatsapp')

const MSG =
  'Salaam! The staff badge problem you reported on the exhibitor portal has been fixed. ' +
  'Please log in at https://cthalaal.co.za/exhibitor/portal and add your staff again. ' +
  'Each badge is emailed to you right away and also sent here on WhatsApp. Reply here if you need any help.'

const email = await sendEmail({
  to: 'crlov@naver.com',
  subject: 'Staff badges are fixed, please add your staff again',
  text: `Salaam KOCO AND DESIGN,\n\n${MSG}\n\nWarm regards,\nYoung at Heart Festival`,
  confirmDelivery: true,
})
console.log('EMAIL:', JSON.stringify(email))

const wa = await sendTemplate('+27617702806', 'festival_announcement', ['KOCO AND DESIGN', MSG], { category: 'utility' })
console.log('WHATSAPP:', JSON.stringify(wa))
