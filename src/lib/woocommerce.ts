const WC_BASE = 'https://tickets.youngatheart.co.za/wp-json/wc/v3'
const WC_KEY = process.env.WC_CONSUMER_KEY || ''
const WC_SECRET = process.env.WC_CONSUMER_SECRET || ''

// Public WP origin (FooEvents writes ticket post URLs under this host).
export const WP_ORIGIN = 'https://tickets.youngatheart.co.za'

// The hidden WC product (id 9487, slug staff-badge) FooEvents is wired to.
// Vendor staff-badge orders are POSTed with this line_item, status=completed,
// so FooEvents auto-fires its ticket generation hooks. See
// docs/staff-badges-via-fooevents.md.
export const STAFF_BADGE_PRODUCT_ID = Number(process.env.STAFF_BADGE_PRODUCT_ID || 9487)

interface WCOrderLineItem {
  id: number
  name: string
  product_id: number
  quantity: number
  subtotal: string
  total: string
  price: number
}

export interface WCOrder {
  id: number
  status: string
  currency: string
  total: string
  date_created: string
  date_modified: string
  billing: {
    first_name: string
    last_name: string
    email: string
    phone: string
    city: string
    state: string
    country: string
  }
  payment_method: string
  payment_method_title: string
  line_items: WCOrderLineItem[]
  customer_id: number
  transaction_id: string
}

export interface WCProduct {
  id: number
  name: string
  price: string
  total_sales: number
  stock_quantity: number | null
  status: string
}

async function wcFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  if (!WC_KEY || !WC_SECRET) {
    throw new Error('WooCommerce credentials missing. Set WC_CONSUMER_KEY and WC_CONSUMER_SECRET.')
  }

  const url = new URL(`${WC_BASE}${endpoint}`)
  url.searchParams.set('consumer_key', WC_KEY)
  url.searchParams.set('consumer_secret', WC_SECRET)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const res = await fetch(url.toString(), {
    cache: 'no-store',
  })

  if (!res.ok) {
    const body = await res.text().catch(() => 'no body')
    console.error(`WooCommerce API error: ${res.status} ${endpoint}`, body)
    throw new Error(`WooCommerce API error: ${res.status} on ${endpoint}`)
  }

  return res.json()
}

// Doctrine Law 6: every orders.list call MUST carry `after=` scoped to the
// current festival cycle, or it silently includes last year's data.
const FESTIVAL_CYCLE_AFTER = '2026-01-01T00:00:00'

// Audit finding #16: getOrders previously fetched only the first 100 orders,
// which silently truncated ticket dashboards once sales crossed 100 in week 1.
// Now paginates with `page=` until the response is shorter than per_page.
export async function getOrders(params: Record<string, string> = {}): Promise<WCOrder[]> {
  const perPage = 100
  const merged: Record<string, string> = { after: FESTIVAL_CYCLE_AFTER, ...params, per_page: String(perPage) }
  const all: WCOrder[] = []
  for (let page = 1; page <= 50; page++) { // hard cap at 5000 orders so a runaway loop never hangs
    const batch = await wcFetch<WCOrder[]>('/orders', { ...merged, page: String(page) })
    all.push(...batch)
    if (batch.length < perPage) break
  }
  return all
}

// Audit finding #16: /reports/orders/totals returns all-time data with no
// date filter (the endpoint doesn't accept `after=`). For festival-cycle
// counts, paginate through /orders with the cycle filter and sum.
export async function getOrdersCount(): Promise<number> {
  const orders = await getOrders({ status: 'completed,processing,on-hold,pending' })
  return orders.length
}

export async function getProducts(): Promise<WCProduct[]> {
  return wcFetch<WCProduct[]>('/products', { per_page: '20' })
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff-badge WC orders (FooEvents-no-fork, Law 3)
//
// We POST a real WC order against STAFF_BADGE_PRODUCT_ID with status=completed.
// FooEvents listens for the woocommerce_order_status_completed hook and
// auto-generates the ticket post + PDF + QR. We never reimplement any of that.
// All custom staff metadata (name, ID, vehicle reg, role, vendor link) lives
// in meta_data so FooEvents check-in scans surface it on the gate.
// ─────────────────────────────────────────────────────────────────────────────

export interface WCOrderMeta { key: string; value: string }

export interface CreateStaffOrderInput {
  vendorApplicationId: string
  vendorFirstName: string
  vendorLastName: string
  vendorEmail: string
  vendorPhone: string
  vendorBusinessName: string
  stallCode: string | null
  staff: {
    name: string
    id_number: string
    vehicle_reg: string
    role: string
    portalStaffId: string
  }
}

export interface WCOrderCreatedResult {
  id: number
  number: string
  status: string
  meta_data: WCOrderMeta[]
  /** FooEvents writes the ticket post id(s) here once generation completes. */
  fooevents_ticket_id?: string
  /** Public order-received URL if surfaced by WC. */
  ticket_pdf_url?: string
}

interface WCOrderRaw {
  id: number
  number: string
  status: string
  meta_data?: WCOrderMeta[]
}

async function wcPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  if (!WC_KEY || !WC_SECRET) {
    throw new Error('WooCommerce credentials missing. Set WC_CONSUMER_KEY and WC_CONSUMER_SECRET.')
  }
  const url = new URL(`${WC_BASE}${endpoint}`)
  url.searchParams.set('consumer_key', WC_KEY)
  url.searchParams.set('consumer_secret', WC_SECRET)
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => 'no body')
    console.error(`WooCommerce POST ${endpoint} failed: ${res.status}`, txt)
    throw new Error(`WooCommerce POST ${endpoint} failed: ${res.status}`)
  }
  return res.json()
}

async function wcPut<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  if (!WC_KEY || !WC_SECRET) {
    throw new Error('WooCommerce credentials missing. Set WC_CONSUMER_KEY and WC_CONSUMER_SECRET.')
  }
  const url = new URL(`${WC_BASE}${endpoint}`)
  url.searchParams.set('consumer_key', WC_KEY)
  url.searchParams.set('consumer_secret', WC_SECRET)
  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => 'no body')
    console.error(`WooCommerce PUT ${endpoint} failed: ${res.status}`, txt)
    throw new Error(`WooCommerce PUT ${endpoint} failed: ${res.status}`)
  }
  return res.json()
}

async function wcGet<T>(endpoint: string): Promise<T> {
  if (!WC_KEY || !WC_SECRET) {
    throw new Error('WooCommerce credentials missing. Set WC_CONSUMER_KEY and WC_CONSUMER_SECRET.')
  }
  const url = new URL(`${WC_BASE}${endpoint}`)
  url.searchParams.set('consumer_key', WC_KEY)
  url.searchParams.set('consumer_secret', WC_SECRET)
  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) {
    const txt = await res.text().catch(() => 'no body')
    throw new Error(`WooCommerce GET ${endpoint} failed: ${res.status}: ${txt}`)
  }
  return res.json()
}

/** Pull the FooEvents-generated ticket id off an order's meta. Returns
 *  undefined when generation has not landed yet (caller may poll). */
function pluckFooEventsTicketId(meta: WCOrderMeta[] | undefined): string | undefined {
  if (!meta) return undefined
  // FooEvents serialises tickets under `WooCommerceEventsTickets` /
  // `_WooCommerceEventsTickets`. Different versions use slightly different
  // shapes (PHP-serialised string, JSON array, or a single ticket id). We
  // surface the first ticket id we can extract; the verifier admin agent
  // reads the order number anyway, so this is a soft signal.
  const KEYS = ['WooCommerceEventsTickets', '_WooCommerceEventsTickets', 'WooCommerceEventsTicketID']
  for (const k of KEYS) {
    const row = meta.find((m) => m.key === k)
    if (!row || !row.value) continue
    const v = String(row.value)
    // try JSON first
    try {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed) && parsed[0]) return String(parsed[0].id || parsed[0].ID || parsed[0])
      if (parsed && typeof parsed === 'object') {
        const first = Object.values(parsed)[0] as unknown
        if (first && typeof first === 'object' && 'id' in (first as object)) return String((first as { id: unknown }).id)
      }
      if (parsed) return String(parsed)
    } catch { /* not JSON */ }
    // raw numeric id
    if (/^\d+$/.test(v)) return v
    // PHP-serialised shape: best-effort regex for `i:<id>` or `s:<n>:"<id>"`
    const m = v.match(/i:(\d+);/) || v.match(/"id";s:\d+:"(\d+)"/)
    if (m) return m[1]
  }
  return undefined
}

/**
 * Create a completed WC order for a single staff badge. FooEvents auto-fires
 * ticket generation on the woocommerce_order_status_completed transition.
 *
 * Returns the order id + (when available) the FooEvents ticket id. The PDF
 * URL is surfaced via the order-received endpoint; the FooEvents PDF download
 * itself is gated behind login on WP, so for vendor delivery we rely on the
 * existing /api/whatsapp/deliver-ticket pipeline (FooEvents emails the PDF
 * which our WP hook reposts as base64).
 */
export async function createStaffBadgeOrder(input: CreateStaffOrderInput): Promise<WCOrderCreatedResult> {
  // FooEvents ticket blueprint (KT #206653). FooEvents mints a ticket/badge only
  // when the order carries this WooCommerceEventsOrderTickets structure — the same
  // shape the checkout builds for a normal ticket buyer. A REST order without it
  // creates the order but NO badge (the old bug: order made, nothing to print).
  // Verified live: order WITH this + a pending->completed transition sets
  // WooCommerceEventsTicketsGenerated=yes; without it, no generation.
  const [staffFirst, ...staffRest] = (input.staff.name || 'Staff').trim().split(/\s+/)
  const staffLast = staffRest.join(' ')
  const orderTickets = {
    '1': {
      '1': {
        WooCommerceEventsProductID: String(STAFF_BADGE_PRODUCT_ID),
        WooCommerceEventsOrderID: '0', // patched to the real id after creation
        WooCommerceEventsTicketType: '',
        WooCommerceEventsStatus: 'Paid',
        WooCommerceEventsCustomerID: '0',
        WooCommerceEventsAttendeeName: staffFirst || 'Staff',
        WooCommerceEventsAttendeeLastName: staffLast,
        WooCommerceEventsAttendeeEmail: input.vendorEmail,
        WooCommerceEventsAttendeeTelephone: input.vendorPhone,
        WooCommerceEventsAttendeeCompany: input.vendorBusinessName,
        WooCommerceEventsAttendeeDesignation: input.staff.role,
        WooCommerceEventsVariations: '',
        WooCommerceEventsVariationID: '',
        WooCommerceEventsPrice: '',
      },
    },
  }

  const meta: WCOrderMeta[] = [
    { key: 'staff_name', value: input.staff.name },
    { key: 'staff_id_number', value: input.staff.id_number },
    { key: 'staff_vehicle_reg', value: input.staff.vehicle_reg },
    { key: 'staff_role', value: input.staff.role },
    { key: 'vendor_application_id', value: input.vendorApplicationId },
    { key: 'vendor_portal_staff_id', value: input.staff.portalStaffId },
    { key: 'stall_code', value: input.stallCode || '' },
    { key: '_is_staff_badge', value: '1' },
    { key: 'WooCommerceEventsOrderTickets', value: orderTickets as unknown as string },
    { key: 'WooCommerceEventsTicketsPurchased', value: { [String(STAFF_BADGE_PRODUCT_ID)]: 1 } as unknown as string },
  ]

  const body = {
    // Create PENDING, then transition to completed below. FooEvents generates on
    // the woocommerce_order_status_completed TRANSITION; an order born 'completed'
    // via REST does not fire that hook, so it must transition.
    status: 'pending',
    set_paid: false,
    customer_note: `Staff badge for ${input.vendorBusinessName}${input.stallCode ? ` (stall ${input.stallCode})` : ''}`,
    billing: {
      first_name: staffFirst || input.vendorFirstName,
      last_name: staffLast || input.vendorLastName || input.vendorBusinessName,
      email: input.vendorEmail,
      phone: input.vendorPhone,
      address_1: input.stallCode ? `Vendor stall ${input.stallCode}` : 'Vendor stall (unallocated)',
      city: 'Cape Town',
      state: 'WC',
      country: 'ZA',
    },
    line_items: [{ product_id: STAFF_BADGE_PRODUCT_ID, quantity: 1 }],
    meta_data: meta,
  }

  const created = await wcPost<WCOrderRaw>('/orders', body)
  // Patch the real order id into the blueprint, then transition to completed to
  // fire FooEvents generation. The returned completed order is what we poll.
  orderTickets['1']['1'].WooCommerceEventsOrderID = String(created.id)
  const order = await wcPut<WCOrderRaw>(`/orders/${created.id}`, {
    status: 'completed',
    set_paid: true,
    meta_data: [{ key: 'WooCommerceEventsOrderTickets', value: orderTickets as unknown as string }],
  })

  // Poll briefly for FooEvents ticket generation (the hook runs on status
  // completed, but on a busy WP host the post insert can lag by 1–6 seconds).
  // We poll up to ~10s before giving up — verifier admin still works off
  // order.number, so missing ticket_id is a soft TODO not a hard failure.
  let ticketId: string | undefined = pluckFooEventsTicketId(order.meta_data)
  const startedAt = Date.now()
  while (!ticketId && Date.now() - startedAt < 10_000) {
    await new Promise((r) => setTimeout(r, 1500))
    try {
      const refreshed = await wcGet<WCOrderRaw>(`/orders/${order.id}`)
      ticketId = pluckFooEventsTicketId(refreshed.meta_data)
      if (ticketId) {
        order.meta_data = refreshed.meta_data
        break
      }
    } catch (e) {
      console.warn('[wc] poll ticket-id failed', e)
      break
    }
  }

  return {
    id: order.id,
    number: order.number,
    status: order.status,
    meta_data: order.meta_data || [],
    fooevents_ticket_id: ticketId,
    // FooEvents stores the PDF behind an authed WP route. The vendor receives
    // the PDF via WhatsApp through the existing deliver-ticket pipeline; the
    // admin link below opens the order edit page where the ticket PDF can be
    // re-downloaded.
    ticket_pdf_url: `${WP_ORIGIN}/wp-admin/post.php?post=${order.id}&action=edit`,
  }
}

/** Cancel a staff badge WC order. FooEvents invalidates the ticket on the
 *  woocommerce_order_status_cancelled hook. */
export async function cancelStaffBadgeOrder(orderId: number): Promise<void> {
  await wcPost(`/orders/${orderId}`, { status: 'cancelled' })
}

export async function getTicketStats() {
  // Only fetch 2026 event orders (filters out last year's festival)
  const after = '2026-01-01T00:00:00'
  const [orders, failedOrders, pendingOrders] = await Promise.all([
    getOrders({ status: 'completed', after }),
    getOrders({ status: 'failed', after }),
    getOrders({ status: 'pending,on-hold,cancelled', after }),
  ])

  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total), 0)
  const totalTickets = orders.reduce((sum, o) => {
    return sum + o.line_items.reduce((s, item) => s + item.quantity, 0)
  }, 0)

  // Breakdown by ticket type
  const ticketBreakdown: Record<string, { qty: number; revenue: number }> = {}
  for (const order of orders) {
    for (const item of order.line_items) {
      if (!ticketBreakdown[item.name]) {
        ticketBreakdown[item.name] = { qty: 0, revenue: 0 }
      }
      ticketBreakdown[item.name].qty += item.quantity
      ticketBreakdown[item.name].revenue += parseFloat(item.total)
    }
  }

  // Sales by date (last 30 days)
  const salesByDate: Record<string, { orders: number; revenue: number; tickets: number }> = {}
  for (const order of orders) {
    const date = order.date_created.split('T')[0]
    if (!salesByDate[date]) {
      salesByDate[date] = { orders: 0, revenue: 0, tickets: 0 }
    }
    salesByDate[date].orders++
    salesByDate[date].revenue += parseFloat(order.total)
    salesByDate[date].tickets += order.line_items.reduce((s, item) => s + item.quantity, 0)
  }

  return {
    totalRevenue,
    totalTickets,
    totalOrders: orders.length,
    ticketBreakdown,
    salesByDate,
    recentOrders: orders.slice(0, 10),
    failedOrders: failedOrders.map(o => ({
      id: o.id,
      status: o.status,
      total: o.total,
      date_created: o.date_created,
      billing: o.billing,
      line_items: o.line_items,
      payment_method_title: o.payment_method_title,
    })),
    pendingOrders: pendingOrders.map(o => ({
      id: o.id,
      status: o.status,
      total: o.total,
      date_created: o.date_created,
      billing: o.billing,
      line_items: o.line_items,
      payment_method_title: o.payment_method_title,
    })),
    failedCount: failedOrders.length,
    pendingCount: pendingOrders.length,
  }
}
