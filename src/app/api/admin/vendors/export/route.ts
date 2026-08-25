/**
 * GET /api/admin/vendors/export?ids=<csv>&status=<filter>
 *
 * Streams a properly-formatted .xlsx of vendors, in the column layout Samreen
 * uses (matches her ExampleSheet.xlsx): Category, Stall/Brand Name, Description,
 * Traded before, Contact, WhatsApp, Instagram, Stall Type, Electrical
 * Appliances, detailed appliance list, plus ops columns (gas, estimate,
 * allocated stall, payment, contract, status).
 *
 * Same auth + audit contract as /api/admin/vendors/csv (owner/operator only,
 * 1000-row cap, logged to vendor_application_events). Formatting (bold frozen
 * header, column widths, text wrap, autofilter) is why this is xlsx not csv.
 */

import { NextRequest, NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseAllocation, tierLabel } from '@/lib/stalls'
import { parseVendorExtras } from '@/lib/vendor-extras'
import { rosterPaid } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// [header text, column width, wrap?]. Header text mirrors Samreen's sheet for
// the first block, then ops columns she also tracks.
const COLUMNS: Array<[string, number, boolean]> = [
  ['Category', 22, false],
  ['Stall/Brand Name', 26, false],
  ['Description of Business/Goods', 46, true],
  ['Traded with CTH before', 16, false],
  ['Contact Person', 22, false],
  ['Whatsapp Number', 18, false],
  ['Instagram handle', 22, false],
  ['Stall Type', 40, true],
  ['Electrical Appliances', 40, true],
  ['Detailed appliance list', 40, true],
  ['Uses gas', 10, false],
  ['Est. total (R)', 14, false],
  ['Allocated stall', 14, false],
  ['Payment status', 14, false],
  ['Contract signed', 16, false],
  ['Application status', 16, false],
]

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in. Please log in again.' }, { status: 401 })

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, role, email').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'Your account is not an admin user.' }, { status: 403 })
  const role = ((adminUser as { role?: string }).role || 'operator').toLowerCase()
  if (!['owner', 'operator'].includes(role)) {
    return NextResponse.json({ error: `Your role (${role}) cannot export vendor data. Ask the owner for owner/operator access.` }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const idsParam = sp.get('ids')
  const ids = idsParam ? idsParam.split(',').map((x) => x.trim()).filter(Boolean) : null
  const status = sp.get('status') || 'approved'

  const MAX_ROWS = 1000
  let q = db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, product_categories, business_description, preferred_booth_tier, special_requirements, status, admin_notes, paid_at, contract_signed_at, contract_pdf_path, is_duplicate')
    .order('business_name', { ascending: true })
    .limit(MAX_ROWS)
  if (ids && ids.length) q = q.in('id', ids)
  else if (status && status !== 'all') q = q.eq('status', status)

  const { data, error } = await q
  if (error) {
    console.error('[vendors/export] query failed:', error.message)
    return NextResponse.json({ error: `Could not read vendors: ${error.message}` }, { status: 500 })
  }

  // APPROVED + PARTICIPATING ONLY (Taona 2026-08-25: "so she doesnt have to
  // manually remove withdraw and rejected"). Withdrawn vendors are status
  // 'rejected' + a ⟦PORTAL⟧ withdrawn marker; both are dropped here, and the
  // status guard also covers a hand-picked `ids` selection that includes one.
  // Skip merged duplicates too (Chocotag's blank twin).
  const rows = ((data || []) as Array<Record<string, unknown>>).filter(
    (r) => !r.is_duplicate && r.status === 'approved' && !parsePortalState(r.admin_notes as string).withdrawn,
  )

  // NO row-scoping. The lane hides payment POSTURE, not the pipeline: the festival
  // owner's ops roster must list every vendor (stall, gas, electrical, contract),
  // and only the Payment-status column is normalised — a master-lane vendor (EFT,
  // manual_card, capture 'manual', collected) reads 'unpaid' until Yoco reconciles
  // them (reconciledPaid). This route used to drop those rows via buildLaneScope,
  // which hid 155 of 238 approved vendors from her Excel (Taona 2026-08-10:
  // "all vendors show, EFT shows as unpaid, they only show paid once yoco
  // reconciled").

  // Audit every PII export (same pattern as the CSV route).
  try {
    const actorEmail = ((adminUser as { email?: string | null }).email) ?? user.email ?? null
    const rowIds = rows.map((r) => r.id as string)
    if (rowIds.length > 0) {
      await db.from('vendor_application_events').insert({
        application_id: rowIds[0],
        event_type: 'xlsx_export',
        before_value: { row_count: rowIds.length, filter: status, ids_filter: ids ? ids.slice(0, 50) : null, exported_ids_sample: rowIds.slice(0, 50) },
        after_value: null,
        actor_email: actorEmail,
        actor_role: role,
        note: `Excel export of ${rowIds.length} vendors by ${actorEmail || 'unknown'}`,
      })
    }
  } catch (e) {
    console.warn('[vendors/export] audit insert failed:', (e as Error).message)
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Young at Heart Festival'
  wb.created = new Date()
  const ws = wb.addWorksheet('Vendors', {
    // Freeze the title + header rows AND the first two columns (Category, Brand)
    // so the vendor stays on screen while scrolling right. NO sheet protection:
    // the file is fully editable.
    views: [{ state: 'frozen', xSplit: 2, ySplit: 2 }],
  })

  const LAST_COL = COLUMNS.length
  ws.columns = COLUMNS.map(([, width]) => ({ width })) // widths only; headers set on row 2

  // Row 1: title band across the sheet.
  ws.mergeCells(1, 1, 1, LAST_COL)
  const titleCell = ws.getCell(1, 1)
  const exportedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  titleCell.value = `Young at Heart Festival 2026  ·  Vendor List  ·  ${exportedOn}  ·  ${rows.length} vendors`
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8A1C3B' } }
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
  ws.getRow(1).height = 28

  // Row 2: column headers (brand fill, bold white, wrapped).
  const headerRow = ws.getRow(2)
  COLUMNS.forEach(([h], i) => { headerRow.getCell(i + 1).value = h })
  headerRow.height = 30
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCD2653' } }
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
  })

  for (const r of rows) {
    const notes = (r.admin_notes as string) || ''
    const extras = parseVendorExtras(r.special_requirements as string | null)
    const { stall } = parseAllocation(notes)
    const cats = (r.product_categories as string[] | null) || []
    const contractSigned = !!(r.contract_signed_at || r.contract_pdf_path)

    ws.addRow([
      cats.join(', '),
      r.business_name || '',
      r.business_description || '',
      extras.tradedBefore,
      r.contact_name || '',
      r.phone || '',
      extras.social,
      extras.stallType || tierLabel(r.preferred_booth_tier as string),
      extras.appliances,
      extras.applianceDetails,
      extras.usesGas,
      extras.totalEstimate ?? '',
      stall || '',
      rosterPaid(notes, r.paid_at as string | null) ? 'paid' : 'unpaid',
      contractSigned ? 'Yes' : 'No',
      (r.status as string) || '',
    ])
  }

  // Column formats: phone as TEXT (keep the leading 0, no scientific notation),
  // Est. total as Rand currency so it reads and sums like money.
  ws.getColumn(6).numFmt = '@'
  ws.getColumn(12).numFmt = '"R" #,##0'
  ws.getColumn(6).alignment = { vertical: 'top' }
  ws.getColumn(12).alignment = { vertical: 'top', horizontal: 'right' }

  // Wrap the long text columns.
  COLUMNS.forEach(([, , wrap], i) => {
    if (wrap) ws.getColumn(i + 1).alignment = { wrapText: true, vertical: 'top' }
  })

  const thin = { style: 'thin' as const, color: { argb: 'FFD9D9D9' } }
  const lastRow = rows.length + 2 // title(1) + header(2) + data
  for (let i = 3; i <= lastRow; i++) {
    const row = ws.getRow(i)
    row.alignment = { ...row.alignment, vertical: 'top' }
    // Subtle zebra banding for readability.
    if (i % 2 === 1) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (!cell.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBF4F6' } }
      })
    }
  }
  // Thin borders across the whole used range (header + data).
  for (let i = 2; i <= lastRow; i++) {
    for (let c = 1; c <= LAST_COL; c++) {
      ws.getCell(i, c).border = { top: thin, left: thin, bottom: thin, right: thin }
    }
  }

  // AutoFilter on the header row so Samreen can sort/filter, and edit freely.
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: LAST_COL } }

  const buffer = await wb.xlsx.writeBuffer()
  const filename = `vendors-${new Date().toISOString().slice(0, 10)}.xlsx`
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}
