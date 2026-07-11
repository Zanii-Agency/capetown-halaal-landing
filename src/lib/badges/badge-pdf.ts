// Self-rendered CTH staff badge PDF (KT #206653/#206655). We render the badge
// ourselves instead of depending on FooEvents' (broken) PDF email.
//
// THE QR CONTRACT (grounded in the gate verifier, workflow wf_59b77a3b):
// the festival gate validates a badge purely by the numeric WooCommerce ORDER
// ID (src/app/api/admin/verifier/lookup + check-in read `o.id`), plus the
// portal_state.staff row we already write. FooEvents' ticket hash / PDF is NOT
// in the gate contract. So the QR encodes ONLY the plain numeric wc_order_id,
// which the verifier's decodeQrPayload accepts directly. No FooEvents dependency.

import QRCode from 'qrcode'
import { YAH_LOGO_DATA_URI } from './yah-logo'

export interface BadgeInput {
  name: string
  role: string            // owner | manager | staff | driver | support
  businessName: string
  stall?: string | null
  phone?: string
  vehicleReg?: string
  wcOrderId: number       // THE QR PAYLOAD — plain numeric WC order id
}

// Escape user-supplied strings at the HTML trust boundary (name, business).
function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

export function buildBadgeHtml(b: BadgeInput, qrDataUri: string): string {
  const cleanBiz = b.businessName.replace(/^DEMO\s*·?\s*/i, '')
  const RED = '#cd2653'
  const INK = '#1a1416'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 90mm 120mm; margin: 0; }
    * { box-sizing: border-box; }
    html,body{margin:0;background:#fff}
    body{font-family:Inter,-apple-system,system-ui,'Helvetica Neue',Arial,sans-serif;color:${INK};-webkit-font-smoothing:antialiased}
    .card{width:90mm;height:120mm;display:flex;flex-direction:column;overflow:hidden}
    /* red header band with the logo */
    .head{background:${RED};color:#fff;padding:6mm 6mm 5mm;display:flex;flex-direction:column;align-items:center;text-align:center}
    /* NO box-shadow here: Chrome print-to-pdf rasterizes shadows into an OPAQUE
       bitmap, which Quartz viewers (Apple Preview / iPhone) show as a white
       square behind the chip. */
    .logo{width:16mm;height:16mm;border-radius:50%;background:#fff;padding:1.2mm;display:flex;align-items:center;justify-content:center;overflow:hidden}
    /* the logo bitmap has white corner pixels — clip it round so no white square
       ever shows on the red band */
    .logo img{width:100%;height:100%;object-fit:contain;border-radius:50%}
    .head .kicker{font-size:8px;font-weight:800;letter-spacing:.26em;text-transform:uppercase;margin-top:2.5mm;opacity:.92}
    .head .passtype{font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;margin-top:1mm}
    /* body */
    .body{flex:1;padding:5.5mm 6mm 0;display:flex;flex-direction:column;align-items:center;text-align:center}
    .name{font-family:Georgia,'Fraunces',serif;font-size:21px;font-weight:600;line-height:1.05;margin:0}
    .biz{font-size:10.5px;color:#6b6b6b;margin-top:1.5mm;line-height:1.3}
    .role{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.16em;color:${RED};border:1.2px solid ${RED};padding:1.4mm 3.2mm;border-radius:999px;margin-top:2.5mm}
    .qrwrap{margin-top:auto;margin-bottom:auto;padding:3mm;border:1px solid #eee;border-radius:8px;background:#fff}
    .qr{width:36mm;height:36mm;display:block}
    .qrhint{font-size:7.5px;letter-spacing:.14em;text-transform:uppercase;color:#b7b0b3;margin-top:1.5mm}
    .meta{font-size:9.5px;color:#8a8286;margin-top:2mm}
    /* footer */
    .foot{border-top:1px solid #efe7ea;margin:0 6mm;padding:3.5mm 0 4.5mm;text-align:center}
    .foot .when{font-size:9px;font-weight:700;color:${INK}}
    .foot .where{font-size:8px;color:#9a9296;margin-top:.6mm}
    .foot .pass{font-size:7.5px;color:#c3bcc0;margin-top:1.4mm;letter-spacing:.08em}
  </style></head><body>
    <div class="card">
      <div class="head">
        <div class="logo"><img src="${YAH_LOGO_DATA_URI}" alt="Young at Heart"/></div>
        <div class="kicker">Young at Heart Festival 2026</div>
        <div class="passtype">Exhibitor Staff Pass</div>
      </div>
      <div class="body">
        <div class="name">${esc(b.name)}</div>
        <div class="biz">${esc(cleanBiz)}${b.stall ? `<br/>Stall ${esc(b.stall)}` : ''}</div>
        <div class="role">${esc(b.role)}</div>
        <div class="qrwrap"><img class="qr" src="${qrDataUri}" alt="Gate QR"/></div>
        <div class="qrhint">Scan at the gate</div>
        <div class="meta">${esc(b.phone || '')}${b.vehicleReg ? ` &nbsp;·&nbsp; ${esc(b.vehicleReg)}` : ''}</div>
      </div>
      <div class="foot">
        <div class="when">11 to 13 December 2026</div>
        <div class="where">Youngsfield Military Base, Cape Town</div>
        <div class="pass">Pass #${b.wcOrderId}</div>
      </div>
    </div>
  </body></html>`
}

/**
 * Render the staff badge to a PDF Buffer. Mirrors renderInvoicePdf's puppeteer
 * pattern (same pinned chromium pack — keep in sync with invoice-pdf.ts /
 * png-renderer.ts). Returns null on failure (never throws) so callers still
 * write portal_state and can retry delivery.
 */
export async function renderBadgePdf(b: BadgeInput): Promise<Buffer | null> {
  try {
    // QR payload = the numeric WC order id ONLY (the gate lookup key).
    const qrDataUri = await QRCode.toDataURL(String(b.wcOrderId), { margin: 1, width: 512 })
    const html = buildBadgeHtml(b, qrDataUri)
    const chromium = (await import('@sparticuz/chromium-min')).default
    const puppeteer = (await import('puppeteer-core')).default
    const executablePath = await chromium.executablePath(
      'https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar',
    )
    const browser = await puppeteer.launch({ args: chromium.args, executablePath, headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      const pdf = await page.pdf({ width: '90mm', height: '120mm', printBackground: true })
      return Buffer.from(pdf)
    } finally {
      await browser.close()
    }
  } catch (e) {
    console.error('[badge-pdf] render failed:', (e as Error).message)
    return null
  }
}
