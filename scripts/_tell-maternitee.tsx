// Tell Raeesa (MaterniTee) what actually went wrong, in her own WhatsApp thread.
//
// Taona 2026-07-29: "help them to understand what it was". She has been told
// "sent" three times over five weeks. She is owed the real reason, and the real
// reason is our data entry, not her spam folder.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/_tell-maternitee.tsx           # DRY
//   SEND=1 npx tsx --env-file=.env.local scripts/_tell-maternitee.tsx

import { sendText, sendTemplate, toE164 } from '../src/lib/whatsapp'
import { windowOpenFor } from '../src/lib/wa-window'

const PHONE = '+27824305318'

const BODY = `Raeesa, we found the problem and it was on our side.

The email address saved on your application had a typo in it, raeesajenk*j*ns instead of raeesajenk*i*ns. So every login email we sent went to an address that does not exist. Nothing was ever reaching you, and it was not sitting in your spam.

We have corrected it to raeesajenkins@gmail.com and sent a fresh link to set your password. It should arrive within a few minutes. Please check promotions and spam as well, just in case.

Apologies for the runaround since June. Once you are in, your stall change to the 3x3m Full Marquee at R6 500 and your payment plan request are both still on the team's list.`

async function main() {
  const DRY = process.env.SEND !== '1'
  if (/[—–]/.test(BODY)) { console.error('REFUSING: long dash in vendor copy (law 7)'); process.exit(1) }

  console.log(DRY ? 'DRY RUN, nothing sent\n' : 'SENDING\n')
  console.log(BODY)
  if (DRY) return

  const e = toE164(PHONE)
  const open = await windowOpenFor(e)
  // Free text keeps the paragraph breaks that make this readable. Outside the
  // window the template flattens it, which is worse but still better than
  // leaving her with no explanation.
  const r = open
    ? await sendText(e, BODY)
    : await sendTemplate(e, 'festival_announcement', ['Raeesa', BODY.replace(/\s*\n\s*/g, ' ')], { category: 'utility' })
  console.log(`\nwindow=${open ? 'open, free text' : 'closed, template'}  sent=${!r.skipped}${r.skipped ? ` (${r.skipped})` : ''}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
