// Approved-vendor allocation list, for the organisers to print before the event.
// Returns two formats: CSV (opens cleanly in Excel) and a brand-styled PDF.
//
// CSV is the default. ?format=pdf returns a rendered A4-landscape PDF
// produced via puppeteer-core + @sparticuz/chromium-min (the same pattern as
// lib/payments/invoice-pdf.ts).
//
// Auth: admin session OR `Authorization: Bearer ${CRON_SECRET}` header.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseAllocation, STALL_LIST } from '@/lib/stalls'
import { parsePortalState } from '@/lib/portal-state'
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface VendorRow {
  stall: string
  type: string
  typeLabel: string
  business: string
  category: string
  phone: string
  email: string
  paid: 'Paid' | 'Pending' | 'Unpaid'
}

const TYPE_LABELS: Record<string, string> = {
  FT: 'Food',
  FS: 'Full Space',
  TS: 'Table Space',
  BS: 'Sponsor',
}

function escCsv(v: string | null | undefined): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`
}

function escHtml(v: string | null | undefined): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string))
}

async function isAuthorized(req: NextRequest): Promise<boolean> {
  // Header-only Bearer (constant-time). `?secret=` query branch removed
  // because it leaks into access logs / browser history / referrers.
  if (verifyCronAuth(req.headers.get('authorization'))) return true
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return false
    const admin = createAdminClient()
    const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
    return !!adminUser
  } catch {
    return false
  }
}

async function loadRows(): Promise<VendorRow[]> {
  const admin = createAdminClient()
  const { data: apps } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, product_categories, paid_at, status, admin_notes')
    .eq('status', 'approved')

  const rows: VendorRow[] = []
  for (const a of apps || []) {
    const notes = (a.admin_notes as string) || ''
    const { stall } = parseAllocation(notes)
    const portalState = parsePortalState(notes)
    const stallMeta = stall ? STALL_LIST.find((s) => s.code === stall) : null
    const typeCode = stallMeta?.type ?? (stall ? stall.replace(/[0-9]+$/, '').toUpperCase() : '')
    const typeLabel = TYPE_LABELS[typeCode] || typeCode || ''
    const categories = Array.isArray(a.product_categories) ? (a.product_categories as string[]) : []
    const paidNow = portalState.payment?.status === 'paid' || !!a.paid_at
    const pending = portalState.payment?.status === 'pending'
    rows.push({
      stall: stall || '',
      type: typeCode,
      typeLabel,
      business: (a.business_name as string) || '',
      category: categories[0] || '',
      phone: (a.phone as string) || '',
      email: (a.email as string) || '',
      paid: paidNow ? 'Paid' : pending ? 'Pending' : 'Unpaid',
    })
  }
  // Allocated stalls first (sorted by code), unallocated last (sorted by business)
  rows.sort((a, b) => {
    if (!!a.stall && !b.stall) return -1
    if (!a.stall && !!b.stall) return 1
    if (a.stall && b.stall) return a.stall.localeCompare(b.stall, undefined, { numeric: true })
    return a.business.localeCompare(b.business)
  })
  return rows
}

function buildCsv(rows: VendorRow[]): string {
  const header = ['#', 'Stall', 'Type', 'Type label', 'Business', 'Category', 'Contact phone', 'Contact email', 'Payment'].map(escCsv).join(',')
  const body = rows.map((r, i) => [
    String(i + 1), r.stall, r.type, r.typeLabel, r.business, r.category, r.phone, r.email, r.paid,
  ].map(escCsv).join(','))
  // BOM so Excel opens UTF-8 correctly
  return '﻿' + [header, ...body].join('\r\n')
}

function buildHtml(rows: VendorRow[]): string {
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const totalAllocated = rows.filter((r) => r.stall).length
  const totalPaid = rows.filter((r) => r.paid === 'Paid').length
  const byType: Record<string, number> = {}
  for (const r of rows) {
    const key = r.type || 'Unallocated'
    byType[key] = (byType[key] || 0) + 1
  }
  const typeSummary = Object.entries(byType)
    .map(([k, v]) => `${k === 'Unallocated' ? 'Not yet allocated' : (TYPE_LABELS[k] || k) + ' (' + k + ')'}: ${v}`)
    .join(' &middot; ')

  const tbody = rows.map((r, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="stall">${escHtml(r.stall) || '<span class="muted">,</span>'}</td>
      <td><span class="chip chip-${escHtml(r.type.toLowerCase())}">${escHtml(r.type) || '<span class="muted">,</span>'}</span></td>
      <td>${escHtml(r.business)}</td>
      <td class="cat">${escHtml(r.category)}</td>
      <td class="num phone">${escHtml(r.phone)}</td>
      <td><span class="paid paid-${r.paid.toLowerCase()}">${escHtml(r.paid)}</span></td>
    </tr>`).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Vendor allocation list, Young at Heart Festival 2026</title>
<style>
  @page { size: A4 landscape; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #171717; margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 14px; border-bottom: 2px solid #cd2653; }
  .kicker { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: #cd2653; font-weight: 700; margin-bottom: 4px; }
  h1 { font-family: 'Fraunces', 'Times New Roman', Georgia, serif; font-size: 26px; margin: 0; line-height: 1.15; letter-spacing: -0.005em; }
  .sub { color: #737373; font-size: 11px; margin-top: 4px; }
  .right { text-align: right; font-size: 11px; color: #525252; }
  .right .num { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 16px; color: #cd2653; font-weight: 700; }
  .summary { margin: 14px 0 10px; padding: 10px 14px; background: #fdf3f6; border-left: 3px solid #cd2653; border-radius: 4px; font-size: 11px; color: #525252; line-height: 1.6; }
  .summary b { color: #171717; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
  thead th { background: #1a1416; color: #fff; text-align: left; padding: 8px 9px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  thead th:first-child { border-radius: 6px 0 0 6px; width: 28px; text-align: center; }
  thead th:last-child { border-radius: 0 6px 6px 0; }
  tbody td { padding: 8px 9px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  tbody tr:nth-child(even) { background: #fafaf9; }
  td.num { font-variant-numeric: tabular-nums; color: #9ca3af; }
  td.stall { font-family: 'JetBrains Mono', 'Courier New', monospace; font-weight: 700; color: #1a1416; }
  td.phone { color: #525252; font-family: 'JetBrains Mono', 'Courier New', monospace; }
  td.cat { color: #525252; font-size: 10.5px; }
  .muted { color: #d4d4d4; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; }
  .chip-ft { background: #fff1e6; color: #c2410c; }
  .chip-fs { background: #f3e8ff; color: #6b21a8; }
  .chip-ts { background: #fef9c3; color: #854d0e; }
  .chip-bs { background: #e0f2fe; color: #075985; }
  .paid { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 9.5px; font-weight: 700; }
  .paid-paid { background: #d1fae5; color: #065f46; }
  .paid-pending { background: #fef3c7; color: #92400e; }
  .paid-unpaid { background: #fee2e2; color: #991b1b; }
  .footer { margin-top: 14px; font-size: 9.5px; color: #9ca3af; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="kicker">Vendor allocation list, internal use</div>
      <h1>Young at Heart Festival 2026</h1>
      <div class="sub">11&ndash;13 December 2026 &middot; Youngsfield Military Base, Cape Town</div>
    </div>
    <div class="right">
      <div>Generated ${escHtml(today)}</div>
      <div class="num">${rows.length} approved vendor${rows.length === 1 ? '' : 's'}</div>
    </div>
  </div>

  <div class="summary">
    <b>Allocation status:</b> ${totalAllocated} of ${rows.length} stalls assigned &middot; ${totalPaid} paid<br/>
    <b>Type breakdown:</b> ${typeSummary || '<span class="muted">no allocations yet</span>'}
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Stall</th>
        <th>Type</th>
        <th>Business</th>
        <th>Category</th>
        <th>Phone</th>
        <th>Payment</th>
      </tr>
    </thead>
    <tbody>${tbody || '<tr><td colspan="7" style="padding:20px;text-align:center;color:#9ca3af;font-style:italic">No approved vendors yet.</td></tr>'}</tbody>
  </table>

  <div class="footer">Vendor allocation list, generated ${escHtml(today)} &middot; Young at Heart Festival 2026</div>
</body>
</html>`
}

async function renderPdf(html: string): Promise<Buffer | null> {
  try {
    const chromium = (await import('@sparticuz/chromium-min')).default
    const puppeteer = (await import('puppeteer-core')).default
    const executablePath = await chromium.executablePath(
      'https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar'
    )
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: true,
    })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      const pdf = await page.pdf({
        format: 'A4', landscape: true, printBackground: true,
        margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
      })
      return Buffer.from(pdf)
    } finally {
      await browser.close()
    }
  } catch (e) {
    console.error('[vendor-list] pdf render failed:', (e as Error).message)
    return null
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const format = (new URL(request.url).searchParams.get('format') || 'csv').toLowerCase()
  const rows = await loadRows()
  const stamp = new Date().toISOString().slice(0, 10)

  if (format === 'pdf') {
    const html = buildHtml(rows)
    const pdf = await renderPdf(html)
    if (!pdf) {
      return NextResponse.json({ error: 'PDF render failed' }, { status: 500 })
    }
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="yah-vendor-list-${stamp}.pdf"`,
      },
    })
  }

  // CSV (Excel-compatible) default
  const csv = buildCsv(rows)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="yah-vendor-list-${stamp}.csv"`,
    },
  })
}
