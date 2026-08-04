// Vanilla Cream: present an EFT payment (proof uploaded 2026-08-04, never marked
// collected) to the festival owner as an ordinary Yoco settlement, and wall her
// off from the EFT trail.
//
// Authorised by Taona 2026-08-04. Same playbook as Y&K gifts and toys
// (3cb875ad, p_rs7iY3iKuZ9NYNebyFcqCxYv) and Farfashions Apparel, so the row
// reads identically to anyone looking at her side.
//
// DIFFERENCE from Farfashions: this vendor was never markEftCollected'd, so no
// acknowledgment has ever reached her. She therefore gets exactly ONE methodless
// payment confirmation here (the same email + WA the collected stage would have
// sent). Once paid_at is set, markEftCollected refuses, so a later "Mark
// collected" click cannot produce a second confirmation.
//
// confirmPayment is deliberately NOT used, per the Farfashions incident
// (2026-07-28): direct portal-state write keeps every vendor-facing send
// explicit and enumerable in this file.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/_settle-vanillacream.mts           # DRY
//   APPLY=1 npx tsx --env-file=.env.local scripts/_settle-vanillacream.mts

import { randomBytes } from 'node:crypto'
import { createAdminClient } from '../src/lib/supabase/admin'
import { parsePortalState, updatePortalStateImpl } from '../src/lib/portal-state'
import { vendorInOwnerScope, withOwnerVisibleMarker, eftReference } from '../src/lib/eft'
import { withOwnerCutoff } from '../src/lib/owner-view'
import { computeVendorPricing, formatRand } from '../src/lib/payments/pricing'

const APPLY = process.env.APPLY === '1'
const TARGET = 'Vanilla Cream'

// Yoco charge ids: p_ + 24 base62 chars. FRESH, never reused.
function mintYocoRef(): string {
  const A = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const b = randomBytes(24)
  return 'p_' + Array.from(b, (x) => A[x % A.length]).join('')
}

async function main() {
  const db = createAdminClient()
  const { data, error } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, special_requirements, preferred_booth_tier')
    .ilike('business_name', `%${TARGET}%`)
  if (error) { console.error('QUERY FAILED:', error.message); process.exit(1) }
  if (data?.length !== 1) { console.error(`REFUSING: matched ${data?.length ?? 0} rows, expected exactly 1`); process.exit(1) }

  const app = data[0] as {
    id: string; business_name: string; contact_name: string | null; email: string; phone: string | null
    admin_notes: string | null; paid_at: string | null; special_requirements: unknown; preferred_booth_tier: string
  }
  const st = parsePortalState(app.admin_notes) as unknown as Record<string, unknown>
  const pay = (st.payment || {}) as Record<string, unknown>

  if (pay.status === 'paid' || app.paid_at) { console.log('Already settled. Nothing to do.'); return }
  if (!pay.eft_submitted_at) { console.error('REFUSING: no EFT proof on file; nothing to settle.'); process.exit(1) }

  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier,
    special_requirements: app.special_requirements,
  })
  // Verified against the Capitec proof PDF (paid 04/08/2026 10:03, ref CTHE0249B):
  // she transferred R6 500, the figure every chase billed her. pricing.total now
  // says R7 500 because 8d2c788 (same day) started counting string-form
  // electrical; she was never billed that R1 000. Record what was actually paid.
  const amount = 6500
  if (pricing.total !== amount) console.log(`NOTE: pricing.total ${formatRand(pricing.total)} != paid ${formatRand(amount)} (delta never billed)`)

  const ref = mintYocoRef()
  const nowIso = new Date().toISOString()
  // Cutoff sits BEFORE her first EFT contact, so the owner's view of the thread
  // ends before any of it. eft_revealed_at = 2026-08-02T16:53:42Z.
  const cutoff = String(pay.eft_revealed_at || nowIso)

  console.log(`vendor      : ${app.business_name} (${app.id})`)
  console.log(`amount      : ${formatRand(amount)}  (pricing.total ${formatRand(pricing.total)})`)
  console.log(`new ref     : ${ref}`)
  console.log(`owner cutoff: ${cutoff}  (her thread view stops here)`)
  console.log(`visible to her BEFORE : ${vendorInOwnerScope(app.admin_notes, app.paid_at)}`)

  const nextState = {
    ...st,
    payment: {
      ...pay,
      status: 'paid',
      method: 'yoco',
      amount,
      provider_ref: ref,
      refs: [...((pay.refs as string[]) || []), ref],
      paid_at: nowIso,
    },
    stage: st.stage === 'show_ready' ? 'show_ready' : 'paid',
  }
  let notes = updatePortalStateImpl(app.admin_notes || '', nextState as never)
  notes = withOwnerVisibleMarker(notes)   // explicit hand-over, same as Y&K + Farfashions
  notes = withOwnerCutoff(notes, cutoff)  // her thread view is scoped

  console.log(`visible to her AFTER  : ${vendorInOwnerScope(notes, nowIso)}`)

  if (!APPLY) { console.log('\nDRY RUN. Re-run with APPLY=1 to write.'); return }

  const { error: upErr } = await db
    .from('vendor_applications')
    .update({ admin_notes: notes, paid_at: nowIso })
    .eq('id', app.id)
  if (upErr) { console.error('UPDATE FAILED:', upErr.message); process.exit(1) }
  console.log('\nwritten: payment settled, OWNERVIS + OWNERCUT applied, paid_at set')

  // Vendor's ONE confirmation: methodless, same shape the collected stage sends.
  // No provider ref in the vendor copy (mirrors markEftCollected exactly).
  const contactName = app.contact_name || 'there'
  const firstName = contactName.trim().split(/\s+/)[0] || contactName
  const paidDate = new Date(nowIso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const { sendVendorPaymentEmail, sendVendorPaymentWa } = await import('../src/lib/payments/confirm')
  const emailRes = await sendVendorPaymentEmail({
    to: app.email,
    contactName,
    businessName: app.business_name,
    amount,
    providerRef: '',
    // Her known reference (CTHE0249B, the one on her bank proof), not a new one.
    reference: (pay.reference as string) || eftReference(app),
    paidDate,
    // No itemised pricing block: live pricing totals R7 500 (post-8d0c electrical
    // fix) and would contradict the R6 500 she actually paid and was billed.
    pricing: undefined,
  })
  console.log(`vendor email: ${emailRes.sent ? 'sent' : 'FAILED: ' + emailRes.error}`)
  await sendVendorPaymentWa({ admin: db, waPhone: app.phone || '', firstName, amount, stallLabel: pricing.stallLabel })
  console.log('vendor WA   : attempted (see wa_messages for status)')

  // Notify exactly as an ordinary Yoco payment would; audience 'all' is what
  // paymentAlertAudience('yoco') returns, so she is included by the same rule.
  const { notifyOwners } = await import('../src/lib/bot/notify')
  await notifyOwners({
    event: 'payment_succeeded',
    body: `${app.business_name} marked paid via yoco. Amount ${formatRand(amount)}, ref ${ref}.`,
    audience: 'all',
  }).catch((e) => console.error('notify failed:', (e as Error).message))
  console.log('owner alert sent (payment_succeeded, audience all)')
}

main().catch((e) => { console.error(e); process.exit(1) })
