// Send the Taona-approved reply to Tasneem Joseph (Vanilla Cream) explaining the
// R1 000 appliance electricity line on her invoice. Mirrors the unified-inbox
// reply route's support@ branch (thread lookup + In-Reply-To + sendEmail, which
// auto-mirrors into the Support Inbox). Approved verbatim 2026-08-04.
import { createAdminClient } from '../src/lib/supabase/admin'
import { sendEmail } from '../src/lib/email/resend'

const TO = 't.josephgallie@gmail.com'
const text = [
  'Wa Alaykum Salaam Tasneem,',
  '',
  'Shukran for reaching out, and jazakAllah khair for your payment. We have received your R6 500 stall fee and your trading spot at Young at Heart Festival 2026 is confirmed. You should already have the confirmation in your inbox.',
  '',
  'To clear up the invoice: the additional R1 000 you are seeing is the appliance electricity fee from your application. You listed 1x small display fridge (R400) and 1x large display fridge/freezer (R600). Electricity for appliances is charged separately from the stall fee, which is why the invoice total reads R7 500 while your stall fee is R6 500.',
  '',
  'And yes, you can handle it exactly as you asked. Your R6 500 is paid and settled now. Once your menu is final closer to the event, simply confirm which appliances you will be bringing and the electricity portion can be paid then. If your appliance list changes, the fee adjusts to what you actually bring on the day.',
  '',
  'Warm regards,',
  'The Young at Heart Festival Team',
].join('\n')

async function main() {
  const db = createAdminClient()
  const { data: threads } = await db
    .from('support_inbox_threads')
    .select('id, subject')
    .ilike('peer_email', TO)
    .order('last_handled_at', { ascending: false, nullsFirst: false })
    .limit(1)
  const thread = threads?.[0] as { id: string; subject: string | null } | undefined
  let subject = thread?.subject || 'Vanilla Cream vendor fee update'
  subject = 'Re: ' + subject.replace(/^re:\s*/i, '')
  let inReplyTo: string | undefined
  if (thread?.id) {
    const { data: lastMsg } = await db
      .from('support_inbox_messages')
      .select('message_id')
      .eq('thread_id', thread.id)
      .not('message_id', 'is', null)
      .order('received_at', { ascending: false })
      .limit(1)
    inReplyTo = (lastMsg?.[0]?.message_id as string | undefined) || undefined
  }
  console.log('thread:', thread?.id, '| subject:', subject, '| inReplyTo:', inReplyTo || '(none)')
  const res = await sendEmail({
    to: TO,
    subject,
    text,
    extraHeaders: inReplyTo ? { 'In-Reply-To': inReplyTo, 'References': inReplyTo } : undefined,
  })
  console.log('send result:', JSON.stringify(res))
}
main().catch((e) => { console.error(e); process.exit(1) })
