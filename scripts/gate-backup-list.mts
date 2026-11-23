/**
 * Paper backup for the gate: who may enter on which day, by order number.
 *
 * Use when the FooEvents Check-ins app or the venue internet fails. Rebuild
 * it the evening before each festival day so late buyers are on it:
 *
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/gate-backup-list.mts [outDir]
 *
 * Output holds buyer names, so it is written OUTSIDE the repo by default
 * (~/Code/zanii/clients/cth/gate-lists) and must never go under public/ (Law 2).
 * Reads WooCommerce at run time through getOrders, which carries after= (Law 4, Law 6).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getOrders } from '../src/lib/woocommerce'

const DAYS = [
  { key: 'fri', label: 'Friday 11 December', product: 9448 },
  { key: 'sat', label: 'Saturday 12 December', product: 9450 },
  { key: 'sun', label: 'Sunday 13 December', product: 9452 },
] as const
const WEEKEND = 9454

type Row = { order: number; name: string; phone: string; dayQty: number; weekendQty: number }

const outDir = process.argv[2] || join(homedir(), 'Code/zanii/clients/cth/gate-lists')
mkdirSync(outDir, { recursive: true })

type Order = { id: number; status: string; billing: { first_name?: string; last_name?: string; phone?: string }; line_items: Array<{ product_id: number; quantity: number }> }
// getOrders pages internally; one call returns every order in the cycle.
const fetched = (await getOrders({ status: 'completed,processing' })) as Order[]
const orders = [...new Map(fetched.map((o) => [o.id, o])).values()]
if (orders.length !== fetched.length) throw new Error(`duplicate orders from WooCommerce: ${fetched.length} rows, ${orders.length} unique`)

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
const stamp = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })
let examined = 0

for (const day of DAYS) {
  const rows: Row[] = []
  for (const o of orders) {
    const dayQty = o.line_items.filter((l) => l.product_id === day.product).reduce((a, l) => a + l.quantity, 0)
    const weekendQty = o.line_items.filter((l) => l.product_id === WEEKEND).reduce((a, l) => a + l.quantity, 0)
    if (!dayQty && !weekendQty) continue
    const name = `${o.billing.first_name || ''} ${o.billing.last_name || ''}`.trim() || '(no name)'
    const phone = (o.billing.phone || '').replace(/\D/g, '').slice(-4)
    rows.push({ order: o.id, name, phone: phone ? `...${phone}` : '', dayQty, weekendQty })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  examined += rows.length
  const people = rows.reduce((a, r) => a + r.dayQty + r.weekendQty, 0)

  const csv = ['order,name,phone_last4,day_tickets,weekend_passes', ...rows.map((r) => `${r.order},"${r.name.replace(/"/g, "'")}",${r.phone},${r.dayQty},${r.weekendQty}`)].join('\n')
  writeFileSync(join(outDir, `gate-${day.key}.csv`), csv + '\n')

  const html = `<!doctype html><meta charset="utf-8"><title>Gate list ${esc(day.label)}</title>
<style>body{font:13px/1.35 Helvetica,Arial,sans-serif;margin:24px}h1{font-size:20px;margin:0}p{margin:4px 0 14px;color:#555}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:5px 7px;text-align:left}th{background:#eee}
td.n{text-align:center;width:70px}td.c{width:28px}tr{page-break-inside:avoid}</style>
<h1>Young at Heart 2026, gate backup list: ${esc(day.label)}</h1>
<p>${rows.length} orders, ${people} people allowed in today. Built ${esc(stamp)}. Weekend Pass holders are valid every day.
Check the order number on the buyer's ticket email, then tick the box.</p>
<table><tr><th>Name</th><th>Order</th><th>Phone</th><th>Day tickets</th><th>Weekend</th><th>In</th></tr>
${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.order}</td><td>${esc(r.phone)}</td><td class="n">${r.dayQty || ''}</td><td class="n">${r.weekendQty || ''}</td><td class="c"></td></tr>`).join('\n')}
</table>`
  writeFileSync(join(outDir, `gate-${day.key}.html`), html)
  console.log(`${day.label}: ${rows.length} orders, ${people} people`)
}
console.log(`orders read ${orders.length}, list rows written ${examined}, out ${outDir}`)
if (orders.length === 0) { console.error('NO ORDERS READ: the list is empty, do not rely on it'); process.exit(1) }
