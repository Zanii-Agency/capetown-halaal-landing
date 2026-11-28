// Daily deposit chase (08:00 SAST). See lib/payments/deposit-chase.ts for the
// timeline. Email AND WhatsApp (festival_announcement template, already approved).
// Same suppression as the other chase crons: paid / withdrawn / proof uploaded
// (person-level), master EFT lane, test vendors. Idempotent per stage+day via
// portal_state.deposit_chase. ?dry=1 lists targets without sending or writing.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState, hasPaid, isWithdrawn } from '@/lib/portal-state'
import { buildSuppressedPeople, newSendDeduper, hasProofUploaded } from '@/lib/payments/chase-targeting'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { sendEmail } from '@/lib/email/resend'
import { Campaign } from '@/lib/email/templates/Campaign'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { isTestVendor } from '@/lib/test-vendors'
import { RULE_START, CHASE_END, depositStage, reminderText, finalText, alertText } from '@/lib/payments/deposit-chase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ChaseLog = { sent?: string[]; alerted_at?: string }

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  if (!dryRun && day > CHASE_END) return NextResponse.json({ ok: true, stopped: `past ${CHASE_END}` })

  const admin = createAdminClient()
  const { data: apps, error } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, status, paid_at, preferred_booth_tier, special_requirements')
    .eq('status', 'approved')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const suppressed = buildSuppressedPeople((apps || []) as never[], now)
  const deduper = newSendDeduper()
  const results: Array<Record<string, unknown>> = []
  let laneExcluded = 0

  for (const app of apps || []) {
    if (isTestVendor(app)) continue
    const state = parsePortalState(app.admin_notes as string)
    if (hasPaid(state) || isWithdrawn(state) || hasProofUploaded(state)) continue
    if (suppressed.hardHas(app as never)) continue
    if (suppressed.laneHas(app as never)) { laneExcluded++; continue }

    const arr = state.payment?.arrangement
    const inst = arr?.plan_status === 'approved' ? [...(arr.installments || [])].sort((a, b) => (a.date < b.date ? -1 : 1)) : []
    const agreed = (arr?.approved_at || arr?.proposed_at || '').slice(0, 10)
    // Only plans / holds agreed under the deposit rule; older plans are untouched.
    if (!inst.length || !agreed || agreed < RULE_START) continue

    const deposit = inst[0]
    const bill = vendorBill({
      id: app.id as string,
      preferred_booth_tier: (app.preferred_booth_tier as string) || null,
      special_requirements: app.special_requirements,
      admin_notes: app.admin_notes as string,
      paid_at: app.paid_at as string | null,
    })
    if (bill.paidTotal >= deposit.amount - 0.005) continue // deposit landed

    const stage = depositStage(agreed, day)
    if (!stage) continue
    const log = ((state as unknown) as { deposit_chase?: ChaseLog }).deposit_chase || {}
    if (stage === 'alert' ? !!log.alerted_at : (log.sent || []).includes(day)) continue
    if (!deduper.claim(app as never)) continue

    const business = (app.business_name as string) || 'A vendor'
    const firstName = ((app.contact_name as string) || '').trim().split(/\s+/)[0] || 'there'
    const out: Record<string, unknown> = { id: app.id, business, stage, agreed, deposit: deposit.amount, due: deposit.date }

    if (!dryRun) {
      if (stage === 'alert') {
        // Into the support inbox as its own thread linked to the vendor. provider
        // must be 'imap' (CHECK constraint); message_id makes it once-only.
        const body = alertText(business, deposit.amount, deposit.date)
        const { data: th, error: thErr } = await admin.from('support_inbox_threads').insert({
          peer_email: 'deposit-alerts@youngatheart.co.za',
          peer_name: 'Deposit alert',
          subject: `Deposit not received: ${business}`,
          status: 'open',
          last_inbound_at: now.toISOString(),
          unread_count: 1,
          vendor_application_id: app.id,
        }).select('id').single()
        if (!thErr && th) {
          await admin.from('support_inbox_messages').insert({
            thread_id: (th as { id: string }).id,
            direction: 'in',
            from_address: 'deposit-alerts@youngatheart.co.za',
            from_name: 'Deposit alert',
            to_address: 'support@youngatheart.co.za',
            subject: `Deposit not received: ${business}`,
            body_text: body,
            message_id: `deposit-alert:${app.id}`,
            provider: 'imap',
            received_at: now.toISOString(),
          })
        }
        out.alerted = !thErr
        if (!thErr) {
          await updatePortalState(app.id as string, (s) => ({
            ...s, deposit_chase: { ...(((s as unknown) as { deposit_chase?: ChaseLog }).deposit_chase || {}), alerted_at: now.toISOString() },
          }) as typeof s)
        }
      } else {
        const text = stage === 'final' ? finalText(deposit.amount) : reminderText(deposit.amount, deposit.date)
        if (app.email) {
          const res = await sendEmail({
            to: app.email as string,
            subject: stage === 'final' ? `Final notice: your stall deposit, ${business}` : `Reminder: your stall deposit, ${business}`,
            react: Campaign({ preview: text.slice(0, 90), heading: stage === 'final' ? 'Your stall is at risk' : 'Your deposit is due', greeting: `Hi ${firstName},`, paragraphs: [text] }),
          })
          out.emailSent = res.ok
        }
        if (app.phone) {
          try {
            const wa = await sendTemplate(toE164(app.phone as string), 'festival_announcement', [firstName, text], { category: 'utility' })
            out.waSent = !wa.skipped
            if (wa.skipped) out.waSkipped = wa.skipped
          } catch (e) { out.waError = (e as Error).message }
        }
        if (out.emailSent || out.waSent) {
          await updatePortalState(app.id as string, (s) => {
            const cur = ((s as unknown) as { deposit_chase?: ChaseLog }).deposit_chase || {}
            return { ...s, deposit_chase: { ...cur, sent: [...(cur.sent || []), day] } } as typeof s
          })
        }
      }
    }
    results.push(out)
  }

  return NextResponse.json({ ok: true, dryRun, scanned: apps?.length ?? 0, targets: results.length, laneExcluded, results })
}
