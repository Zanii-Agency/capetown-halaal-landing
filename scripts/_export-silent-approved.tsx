// Export APPROVED silent vendors in TWO groups (two worksheets):
//
//   Sheet 1 "Never logged in"   — auth last_sign_in_at is null
//   Sheet 2 "No WA response"    — HAVE logged in, but never sent an inbound
//                                 WhatsApp message (wa_messages direction='in')
//
// EFT EXCLUSION, NO MATTER WHAT (applies to both groups):
//   - ⟦EFT⟧ per-vendor marker in admin_notes
//   - payment status 'collected' (money recorded, not reconciled)
//   - eft_collected_at set (belt-and-braces for the same operator action)
//   - eft_submitted_at set (vendor uploaded their own proof of payment)
//   - proofs[] containing an 'eft_submission' or 'eft_accessories' file
//   - accessories sub-ledger submitted_at / collected_at (acc EFT in flight)
//   - payment method in {eft, manual_card, manual} (settled via the lane)
// Vendors who merely OPENED the EFT panel (eft_revealed_at / acc.revealed_at)
// are FINE — they stay in. Global EFT mode is NOT applied (it would sweep in
// every vendor).
//
// Usage:
//   npx tsx --env-file=.env.local scripts/_export-silent-approved.tsx

import ExcelJS from 'exceljs'
import { mkdirSync } from 'node:fs'
import { createAdminClient } from '../src/lib/supabase/admin'
import { parsePortalState } from '../src/lib/portal-state'
import { hasEftMarker } from '../src/lib/eft'

const MASTER_ONLY_METHODS = new Set(['eft', 'manual_card', 'manual'])

function last9(p?: string | null): string {
  return (p || '').replace(/\D/g, '').slice(-9)
}

interface Picked { biz: string; contact: string; phone: string; email: string; approvedAt: string }

async function main() {
  const db = createAdminClient()

  // 1) Auth users → last_sign_in_at by email
  const users: { email?: string; last_sign_in_at?: string | null }[] = []
  for (let page = 1; page <= 6; page++) {
    const { data } = await (db as never as { auth: { admin: { listUsers(o: unknown): Promise<{ data?: { users?: typeof users } }> } } })
      .auth.admin.listUsers({ page, perPage: 1000 })
    const u = data?.users || []
    users.push(...u)
    if (u.length < 1000) break
  }
  const byEmail = new Map(users.map((u) => [String(u.email || '').toLowerCase(), u]))
  console.log(`auth users loaded: ${users.length}`)

  // 2) Approved vendor applications
  const rows: Record<string, unknown>[] = []
  for (let p = 0; p < 25; p++) {
    const { data, error } = await db.from('vendor_applications')
      .select('id, business_name, contact_name, email, phone, status, approved_at, admin_notes')
      .eq('status', 'approved')
      .order('id').range(p * 1000, p * 1000 + 999)
    if (error) { console.error('QUERY FAILED:', error.message); process.exit(1) }
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  console.log(`approved applications: ${rows.length}`)

  // 3) Phones that have EVER sent an inbound WhatsApp message
  const responders = new Set<string>()
  for (let p = 0; p < 200; p++) {
    const { data, error } = await db.from('wa_messages')
      .select('wa_phone')
      .eq('direction', 'in')
      .range(p * 1000, p * 1000 + 999)
    if (error) { console.error('QUERY FAILED (wa_messages):', error.message); process.exit(1) }
    for (const m of data || []) {
      const k = last9((m as { wa_phone?: string }).wa_phone)
      if (k) responders.add(k)
    }
    if (!data || data.length < 1000) break
  }
  console.log(`inbound WA phones: ${responders.size}`)

  // 4) Filter into two groups
  const neverLoggedIn: Picked[] = []
  const noResponse: Picked[] = []
  const skipped = { eft: 0, fine: 0 }
  for (const r of rows) {
    const notes = String(r.admin_notes || '')
    const st = parsePortalState(notes) as unknown as {
      payment?: {
        status?: string
        method?: string
        eft_submitted_at?: string
        eft_collected_at?: string
        acc?: { submitted_at?: string; collected_at?: string }
        proofs?: { kind?: string }[]
      }
    }
    const pay = st.payment || {}
    const proofKinds = (pay.proofs || []).map((p) => String(p.kind || ''))
    const onEftLane =
      hasEftMarker(notes)
      || pay.status === 'collected'
      || !!pay.eft_collected_at
      || !!pay.eft_submitted_at
      || proofKinds.includes('eft_submission')
      || proofKinds.includes('eft_accessories')
      || !!pay.acc?.submitted_at
      || !!pay.acc?.collected_at
      || MASTER_ONLY_METHODS.has(String(pay.method || ''))
    if (onEftLane) { skipped.eft++; continue }

    const numbers = String(r.phone || '').split(/[\/,;]/).map((s) => last9(s)).filter(Boolean)
    const responded = numbers.some((n) => responders.has(n))
    const u = byEmail.get(String(r.email || '').toLowerCase())
    const loggedIn = !!(u && u.last_sign_in_at)

    const rec: Picked = {
      biz: String(r.business_name || '').trim(),
      contact: String(r.contact_name || '').trim(),
      phone: String(r.phone || '').trim(),
      email: String(r.email || '').trim(),
      approvedAt: r.approved_at ? String(r.approved_at).slice(0, 10) : '',
    }
    if (!loggedIn) neverLoggedIn.push(rec)
    else if (!responded) noResponse.push(rec)
    else skipped.fine++
  }
  neverLoggedIn.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt))
  noResponse.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt))

  console.log(`\nnever logged in: ${neverLoggedIn.length}`)
  console.log(`logged in but no WA response: ${noResponse.length}`)
  console.log(`(skipped: ${skipped.eft} EFT lane/collected/proof, ${skipped.fine} logged in AND responded — all good)`)

  // 5) Excel, one sheet per group
  const wb = new ExcelJS.Workbook()
  const cols: Partial<ExcelJS.Column>[] = [
    { header: 'Stall/Brand Name', key: 'biz', width: 30 },
    { header: 'Contact Person', key: 'contact', width: 24 },
    { header: 'WhatsApp Number', key: 'phone', width: 20 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Approval Date', key: 'approvedAt', width: 16 },
  ]
  function addSheet(name: string, list: Picked[]) {
    const ws = wb.addWorksheet(name)
    ws.columns = cols
    ws.getRow(1).font = { bold: true }
    ws.views = [{ state: 'frozen', ySplit: 1 }]
    ws.autoFilter = { from: 'A1', to: 'E1' }
    for (const r of list) ws.addRow(r)
  }
  addSheet('Never logged in', neverLoggedIn)
  addSheet('No WA response', noResponse)

  mkdirSync('exports', { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  const out = `exports/samreen-silent-approved-vendors-${today}.xlsx`
  await wb.xlsx.writeFile(out)
  console.log(`\nwrote ${out}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
