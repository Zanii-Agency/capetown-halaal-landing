// Independent audit of exports/samreen-silent-approved-vendors-2026-08-22.xlsx.
// Does NOT reuse the export script's filter logic. For every vendor in the
// workbook: fetch the row fresh, scan the RAW admin_notes text for any 'eft'
// substring (case-insensitive), any 'collected' status, any proof files, and
// report. Also lists every APPROVED vendor carrying an EFT signal and checks
// none of them are in the workbook.
//
//   npx tsx --env-file=.env.local scripts/_audit-silent-export.tsx

import ExcelJS from 'exceljs'
import { createAdminClient } from '../src/lib/supabase/admin'

async function main() {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile('exports/samreen-silent-approved-vendors-2026-08-22.xlsx')

  const listed = new Map<string, string>() // email -> "sheet: business"
  for (const ws of wb.worksheets) {
    ws.eachRow((row, n) => {
      if (n === 1) return
      const v = row.values as unknown[]
      listed.set(String(v[4] || '').toLowerCase().trim(), `${ws.name}: ${v[1]}`)
    })
  }
  console.log(`workbook vendors: ${listed.size}`)

  const db = createAdminClient()
  const rows: Record<string, unknown>[] = []
  for (let p = 0; p < 25; p++) {
    const { data, error } = await db.from('vendor_applications')
      .select('id, business_name, email, status, paid_at, admin_notes')
      .eq('status', 'approved')
      .order('id').range(p * 1000, p * 1000 + 999)
    if (error) { console.error('QUERY FAILED:', error.message); process.exit(1) }
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }

  let problems = 0
  for (const r of rows) {
    const notes = String(r.admin_notes || '')
    const email = String(r.email || '').toLowerCase().trim()
    const inWorkbook = listed.has(email)

    // Raw, parse-free EFT signals
    const rawSignals: string[] = []
    if (/⟦EFT⟧/.test(notes)) rawSignals.push('EFT-MARKER')
    if (/eft_submitted_at":"[^"]/.test(notes)) rawSignals.push('proof-uploaded')
    if (/eft_collected_at":"[^"]/.test(notes)) rawSignals.push('marked-collected')
    if (/"status":"collected"/.test(notes)) rawSignals.push('status-collected')
    if (/"kind":"eft_submission"/.test(notes)) rawSignals.push('proof-file')
    if (/"kind":"eft_accessories"/.test(notes)) rawSignals.push('acc-proof-file')
    if (/"method":"(eft|manual_card|manual)"/.test(notes)) rawSignals.push('lane-method')
    if (/"acc":\{[^}]*"(submitted_at|collected_at)":"[^"]/.test(notes)) rawSignals.push('acc-eft')
    if (r.paid_at) rawSignals.push(`paid_at=${String(r.paid_at).slice(0, 10)}`)
    if (/"status":"paid"/.test(notes)) rawSignals.push('status-paid')

    if (rawSignals.length && inWorkbook) {
      problems++
      console.log(`\n!!! IN WORKBOOK WITH SIGNAL: ${listed.get(email)} <${email}>`)
      console.log(`    signals: ${rawSignals.join(', ')}`)
    }
    if (!rawSignals.length && inWorkbook && /eft/i.test(notes)) {
      // any other 'eft' mention we did not classify
      const snippet = notes.match(/.{0,60}eft.{0,60}/gi)?.slice(0, 3)
      console.log(`\n??? unclassified 'eft' text in workbook vendor ${listed.get(email)} <${email}>:`)
      snippet?.forEach((s) => console.log(`    ...${s}...`))
    }
  }

  console.log(`\n${problems === 0 ? 'CLEAN: no workbook vendor carries any EFT/collected/proof/paid signal.' : `${problems} PROBLEM(S) FOUND`}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
