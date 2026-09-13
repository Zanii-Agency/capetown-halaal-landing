// SOFT "just checking in for an update" follow-up to EVERY unpaid vendor
// (Taona 2026-09-12: "reach out to all that have not paid", tone = "just asking
// for an update", NO deadline, NO amount). WhatsApp (payment_check UTILITY
// template) + email, one per person.
//
// Reuses the hard-won bits from chase-all-unpaid.tsx: person-level suppression
// (paid/withdrawn/proof), union-find de-dup so a duplicate application row never
// double-texts the same person, on-plan skip, a recency floor so we do NOT re-hit
// anyone chased in the last MIN_GAP_DAYS (a final-notice went out 2026-09-12 and a
// gentle email 2026-09-11), and history logging. Includes master/EFT-lane vendors
// (their portal routes their money to the right account; the copy names no method).
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/chase-update-checkin-2026-09-12.mts            # DRY (default)
//   ONLY="Some Biz" SEND=1 node --env-file=.env.local --import tsx scripts/chase-update-checkin-2026-09-12.mts   # canary one
//   SEND=1 node --env-file=.env.local --import tsx scripts/chase-update-checkin-2026-09-12.mts     # live all
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalStateImpl, isWithdrawn, getArrangement } from '@/lib/portal-state'
import { buildSuppressedPeople, hasProofUploaded } from '@/lib/payments/chase-targeting'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { sendEmail } from '@/lib/email/resend'
import { isTestVendor } from '@/lib/test-vendors'
import { EmailLayout, Heading, Paragraph, Button, Signoff } from '@/lib/email/components'
import React from 'react'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const MIN_GAP_DAYS = process.env.MIN_GAP_DAYS ? Number(process.env.MIN_GAP_DAYS) : 2
const PORTAL = 'https://cthalaal.co.za/exhibitor/portal/payments'
const e164 = (p?: string | null) => { try { return p ? toE164(p) : '' } catch { return '' } }
const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 86400000)

// PAYMENT follow-up copy (Taona 2026-09-12: "it's about following up on
// payment"). Clearly about settling the stall fee, but warm and NO amount, NO
// deadline. payment_check {{2}} is the one free-text detail line (no newlines /
// no >4-space runs per Meta).
const WA_DETAIL = 'We wanted to follow up on the payment for your stall. Is there any update on your side, and is there anything you need from us to help you get it settled? Your stall is still held for you.'

const EMAIL_SUBJECT = 'Following up on your Young at Heart Festival stall payment'
function CheckinEmail(first: string) {
  return React.createElement(EmailLayout, null,
    React.createElement(Heading, null, `Salaam ${first},`),
    React.createElement(Paragraph, null, 'We wanted to follow up on the payment for your stall at the Young at Heart Festival 2026.'),
    React.createElement(Paragraph, null, 'Is there any update on your side? If there is anything you need from us to help you get it settled, please just reply and let us know. Your stall is still held for you.'),
    React.createElement(Button, { href: PORTAL, children: 'Pay for my stall' }),
    React.createElement(Paragraph, null, 'You can settle any time from your portal, whenever it suits you.'),
    React.createElement(Signoff, null),
  )
}

type Row = { id: string; business_name: string | null; contact_name: string | null; email: string | null; phone: string | null; admin_notes: string | null }

async function main() {
  const db = createAdminClient()
  const today = new Date()
  const { data: all } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes')
    .eq('status', 'approved')
  const rows = (all || []) as Row[]

  const hardIdx = buildSuppressedPeople(rows as never[], today)

  // Unpaid, not test, not withdrawn, not paid/proof (hardHas), not on a plan.
  const unpaid = rows.filter((r) => {
    if (isTestVendor(r as never)) return false
    const st = parsePortalState(r.admin_notes || '')
    if (isWithdrawn(st)) return false
    if (hardIdx.hardHas(r as never)) return false
    // NEVER chase anyone who uploaded a proof of payment (Taona 2026-09-13): the
    // money is with us to reconcile, not with them to pay again. (hardHas already
    // covers this via hasProofUploaded; explicit here so the intent can't drift.)
    if (hasProofUploaded(st)) return false
    if (getArrangement(st, today)) return false
    // NEVER chase anyone who genuinely made a payment plan (Taona 2026-09-13),
    // even one whose in-force window getArrangement reads differently: an APPROVED
    // instalment arrangement on record is a commitment we honour, not chase.
    const arr = (st.payment as { arrangement?: { plan_status?: string; installments?: unknown[] } } | undefined)?.arrangement
    if (arr?.plan_status === 'approved' && (arr.installments?.length ?? 0) > 0) return false
    return true
  })

  // Union-find person de-dup (share email OR phone) — never double-text a person.
  const uf = unpaid.map((_, i) => i)
  const find = (x: number): number => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x] } return x }
  const union = (a: number, b: number) => { uf[find(a)] = find(b) }
  const byEmail = new Map<string, number>(); const byPhone = new Map<string, number>()
  unpaid.forEach((r, i) => {
    const em = (r.email || '').trim().toLowerCase(); const ph = e164(r.phone)
    if (em) { if (byEmail.has(em)) union(i, byEmail.get(em)!); else byEmail.set(em, i) }
    if (ph) { if (byPhone.has(ph)) union(i, byPhone.get(ph)!); else byPhone.set(ph, i) }
  })
  const comp = new Map<number, Row[]>()
  unpaid.forEach((r, i) => { const root = find(i); const g = comp.get(root) || []; g.push(r); comp.set(root, g) })

  const lastChasedAt = (rs: Row[]): Date | null => {
    let latest: Date | null = null
    for (const r of rs) {
      const h = ((parsePortalState(r.admin_notes || '') as unknown) as { payment_reminders?: { history?: Array<{ at: string }> } }).payment_reminders?.history || []
      for (const e of h) { const d = new Date(e.at); if (!latest || d > latest) latest = d }
    }
    return latest
  }

  let targets = [...comp.values()].map((rs) => {
    const p = rs[0]
    return {
      rows: rs, primary: p,
      first: (p.contact_name || 'there').trim().split(/\s+/)[0] || 'there',
      biz: (p.business_name || '').trim(),
      phones: [...new Set(rs.map((r) => e164(r.phone)).filter(Boolean))],
      emails: [...new Set(rs.map((r) => (r.email || '').trim()).filter(Boolean))],
      lastAt: lastChasedAt(rs),
    }
  })
  if (ONLY) targets = targets.filter((t) => t.biz.toLowerCase() === ONLY)

  const skippedRecent: string[] = []
  targets = targets.filter((t) => {
    if (MIN_GAP_DAYS > 0 && t.lastAt && daysBetween(t.lastAt, today) < MIN_GAP_DAYS) {
      skippedRecent.push(`${t.biz} (chased ${daysBetween(t.lastAt, today)}d ago)`); return false
    }
    return true
  })

  console.log(`\n${DRY ? 'DRY RUN (nothing sent)' : 'LIVE SEND'} — ${targets.length} people (${unpaid.length} unpaid rows), MIN_GAP_DAYS=${MIN_GAP_DAYS}`)
  console.log(`skipped ${skippedRecent.length} chased in last ${MIN_GAP_DAYS}d`)
  console.log('='.repeat(70))

  let waOk = 0, mailOk = 0, recorded = 0
  const fails: string[] = []
  for (const t of targets) {
    console.log(`\n### ${t.biz}  [${t.rows.length > 1 ? `${t.rows.length} rows MERGED, ` : ''}${t.lastAt ? `last chased ${daysBetween(t.lastAt, today)}d ago` : 'never chased'}]`)
    console.log(`  WA → ${t.phones.join(', ') || '(none)'}: Hi ${t.first}, ${WA_DETAIL.slice(0, 60)}…`)
    console.log(`  EMAIL → ${t.emails.join(', ') || '(none)'}: "${EMAIL_SUBJECT}"`)
    if (DRY) continue

    let sent = false
    if (!t.phones.length) fails.push(`WA ${t.biz}: no phone`)
    for (const phone of t.phones) {
      try {
        const wr = await sendTemplate(phone, 'payment_check', [t.first, WA_DETAIL], { category: 'utility' })
        if (wr.skipped) fails.push(`WA ${t.biz} (${phone}): skipped ${wr.skipped}`)
        else { waOk++; sent = true; console.log(`  WA sent → ${phone}`) }
      } catch (e) { fails.push(`WA ${t.biz} (${phone}): ${(e as Error).message}`) }
    }
    for (const email of t.emails) {
      try {
        const er = await sendEmail({ to: email, subject: EMAIL_SUBJECT, react: CheckinEmail(t.first) })
        if (er.ok) { mailOk++; sent = true; console.log(`  EMAIL sent → ${email}`) } else fails.push(`EMAIL ${t.biz} (${email}): ${er.error}`)
      } catch (e) { fails.push(`EMAIL ${t.biz} (${email}): ${(e as Error).message}`) }
    }

    if (!sent) { fails.push(`RECORD ${t.biz}: nothing sent`); continue }
    for (const r of t.rows) {
      const st = parsePortalState(r.admin_notes || '')
      const prior = ((st as unknown) as { payment_reminders?: { history?: Array<{ at: string; week: number }> } }).payment_reminders?.history || []
      const next = { ...st, payment_reminders: { ...(((st as unknown) as { payment_reminders?: object }).payment_reminders || {}), history: [...prior, { at: new Date().toISOString(), week: Math.min(prior.length + 1, 4) }] } }
      const { error } = await db.from('vendor_applications').update({ admin_notes: updatePortalStateImpl(r.admin_notes || '', next as never) }).eq('id', r.id)
      if (!error) recorded++; else fails.push(`RECORD ${t.biz} (${r.id}): ${error.message}`)
    }
    await new Promise((res) => setTimeout(res, 250)) // Law 5 throttle
  }

  console.log(`\n${'='.repeat(70)}`)
  if (!DRY) {
    console.log(`WA sent: ${waOk} | email sent: ${mailOk} | history rows recorded: ${recorded}`)
    if (fails.length) { console.log(`\nFAILURES (${fails.length}):`); fails.forEach((f) => console.log('  - ' + f)) }
  } else {
    console.log(`Would message ${targets.length} people. Re-run with SEND=1 to go live (ONLY="Biz" for a canary first).`)
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
