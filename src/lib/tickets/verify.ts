/**
 * Ticket verification core.
 *
 * Pre-event validator that takes a WC order + the FooEvents per-ticket meta
 * embedded in `_WooCommerceEventsOrderTickets` (or its non-underscored
 * twin) and turns each ticket into a `ticket_verifications` row.
 *
 * Two distinct verification states (caller wires these into the table):
 *   verified_at    -> pre-event, signature OK + holder data present
 *   checked_in_at  -> day-of, scanned at the gate (NOT set here)
 *
 * Law 4: WooCommerce + FooEvents are the source of truth. This file does NOT
 * mint tickets, it only mirrors them into a verification ledger so the gate
 * UI can scan in ~5ms and tell two states apart.
 *
 * Law 3: FooEvents shapes vary across versions. We tolerate JSON, PHP-serialised,
 * keyed objects, and `_` vs non-underscore meta keys. Anything we can't parse is
 * surfaced as a `verification_error` row, never silently dropped.
 */

import type { WCOrder } from '@/lib/woocommerce'

// ─────────────────────────────────────────────────────────────────────────────
// Product map: the 5 ticket products we mirror.
// 9448/9450/9452 = single-day passes, 9454 = weekend, 9487 = staff badge.
// Mirrors STAFF_BADGE_PRODUCT_ID in lib/woocommerce.ts (Law 4 source of truth).
// ─────────────────────────────────────────────────────────────────────────────

export const TICKET_PRODUCT_IDS = [9448, 9450, 9452, 9454, 9487] as const

export type TicketType =
  | 'friday_pass'
  | 'saturday_pass'
  | 'sunday_pass'
  | 'weekend_pass'
  | 'staff_badge'

const PRODUCT_TYPE_MAP: Record<number, TicketType> = {
  9448: 'friday_pass',
  9450: 'saturday_pass',
  9452: 'sunday_pass',
  9454: 'weekend_pass',
  9487: 'staff_badge',
}

const PRODUCT_DATE_MAP: Record<number, string | null> = {
  9448: '2026-12-11',
  9450: '2026-12-12',
  9452: '2026-12-13',
  9454: null, // weekend pass spans all three
  9487: null, // staff badge spans all three
}

// Festival dates the verifier accepts as the holder's `attendance_date`.
export const FESTIVAL_DATES = new Set(['2026-12-11', '2026-12-12', '2026-12-13'])

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WCOrderMetaItem {
  key: string
  value: unknown
}

export interface WCOrderWithMeta extends WCOrder {
  meta_data?: WCOrderMetaItem[]
}

export interface ParsedTicket {
  /** Stable per-ticket id sourced from FooEvents (or order:line synthetic). */
  fooevents_ticket_id: string
  product_id: number | null
  ticket_type: TicketType | null
  holder_first_name: string | null
  holder_last_name: string | null
  holder_email: string | null
  holder_phone: string | null
  attendance_date: string | null // YYYY-MM-DD
  raw: Record<string, unknown>
}

export interface ValidationResult {
  ok: boolean
  /** Comma-joined human-readable reasons. null when ok. */
  error: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver: pull tickets directly from the WP-side mu-plugin endpoint
// ─────────────────────────────────────────────────────────────────────────────

const WP_RESOLVER_ORIGIN = 'https://tickets.youngatheart.co.za'

interface WpResolverTicket {
  order_id: number
  product_id: number
  ticket_index: number
  ticket_id: string
  ticket_hash: string
  first_name: string
  last_name: string
  email: string
  phone: string
  attendance_date: string
  checked_in: boolean
  pdf_url: string
  fallback?: boolean
}

interface WpResolverResponse {
  tickets: WpResolverTicket[]
  count: number
}

/**
 * Hit the WP mu-plugin endpoint to get FooEvents attendee data per order.
 * Returns null on any failure so callers fall back to the local meta-parse path.
 */
/**
 * The WP resolver can return the right NUMBER of tickets with every field
 * empty (seen 2026-11-23: product_id 1, blank ticket_id, for all 2026 orders,
 * because it misreads FooEvents' nested {index: {index: ticket}} meta). Those
 * rows are worse than useless: they overwrite real holder data with blanks.
 * Trust the resolver only when every row is identifiable.
 */
export function resolverTicketsUsable(tickets: ParsedTicket[] | null): tickets is ParsedTicket[] {
  if (!tickets || tickets.length === 0) return false
  const known = new Set<number>(TICKET_PRODUCT_IDS)
  return tickets.every((t) =>
    !t.fooevents_ticket_id.startsWith('synthetic:') ||
    (t.product_id !== null && known.has(t.product_id)),
  )
}

export async function fetchTicketsFromWpResolver(orderId: number): Promise<ParsedTicket[] | null> {
  const bearer = process.env.CTH_WP_RESOLVER_BEARER?.trim()
  if (!bearer) return null
  try {
    const res = await fetch(`${WP_RESOLVER_ORIGIN}/wp-json/cth/v1/tickets-by-order/${orderId}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as WpResolverResponse
    if (!data || !Array.isArray(data.tickets)) return null
    return data.tickets.map((t) => {
      const realId = (t.ticket_id || '').trim()
      const ticketId = realId.length > 0
        ? realId
        : `synthetic:${t.order_id}:${t.product_id}:${t.ticket_index}`
      return {
        fooevents_ticket_id: ticketId,
        product_id: t.product_id || null,
        ticket_type: t.product_id ? PRODUCT_TYPE_MAP[t.product_id] || null : null,
        holder_first_name: t.first_name?.trim() || null,
        holder_last_name: t.last_name?.trim() || null,
        holder_email: t.email?.trim() || null,
        holder_phone: t.phone?.trim() || null,
        attendance_date: toIso(t.attendance_date),
        raw: {
          source: 'wp_resolver',
          fallback: t.fallback === true,
          ticket_hash: t.ticket_hash,
          pdf_url: t.pdf_url,
          checked_in: t.checked_in,
        },
      }
    })
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse: extract per-ticket records from a WC order's meta_data
// ─────────────────────────────────────────────────────────────────────────────

const ORDER_TICKET_KEYS = [
  'WooCommerceEventsOrderTickets',
  '_WooCommerceEventsOrderTickets',
  'WooCommerceEventsTickets',
  '_WooCommerceEventsTickets',
]

function tryJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function toIso(date: string | undefined | null): string | null {
  if (!date) return null
  // FooEvents emits dates in many forms: '11 December 2026', '2026-12-11',
  // '11/12/2026', '2026-12-11 09:00:00'. We canonicalise to YYYY-MM-DD.
  const trimmed = String(date).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    const [, d, m, y] = slash
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const parsed = new Date(trimmed)
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear()
    const m = String(parsed.getUTCMonth() + 1).padStart(2, '0')
    const d = String(parsed.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return null
}

function pickField(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  return null
}

/**
 * Walk a FooEvents OrderTickets blob and yield one ParsedTicket per ticket.
 *
 * FooEvents uses any of:
 *   - array of ticket objects
 *   - object keyed by ticket id with ticket objects as values
 *   - nested {product_id: [{ticket}, {ticket}]} dict
 *
 * Each ticket object has keys like:
 *   WooCommerceEventsAttendeeName, WooCommerceEventsAttendeeLastName,
 *   WooCommerceEventsAttendeeEmail, WooCommerceEventsAttendeeTelephone,
 *   WooCommerceEventsBookingsDateTime, WooCommerceEventsBookingsDate,
 *   WooCommerceEventsTicketID, WooCommerceEventsProductID
 *
 * We're defensive: anything that walks like a ticket object becomes a row.
 */
function walkTicketTree(node: unknown, productHint: number | null, out: ParsedTicket[]): void {
  if (node === null || node === undefined) return
  const parsed = tryJsonParse(node)
  if (Array.isArray(parsed)) {
    for (const item of parsed) walkTicketTree(item, productHint, out)
    return
  }
  if (parsed && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>
    // If this looks like a ticket (has any attendee key), parse it
    const looksLikeTicket =
      'WooCommerceEventsAttendeeName' in rec ||
      'WooCommerceEventsAttendeeEmail' in rec ||
      'WooCommerceEventsTicketID' in rec ||
      'WooCommerceEventsAttendeeFirstName' in rec
    if (looksLikeTicket) {
      const productIdRaw = pickField(rec, ['WooCommerceEventsProductID', 'product_id'])
      const productId = productIdRaw ? Number(productIdRaw) : productHint
      const ticketId =
        pickField(rec, ['WooCommerceEventsTicketID', 'ticket_id', 'id']) ||
        // synthetic fallback so dupes within an order still keyed uniquely
        `synthetic:${productId || 'x'}:${out.length}`
      out.push({
        fooevents_ticket_id: ticketId,
        product_id: productId,
        ticket_type: productId ? PRODUCT_TYPE_MAP[productId] || null : null,
        holder_first_name:
          pickField(rec, ['WooCommerceEventsAttendeeName', 'WooCommerceEventsAttendeeFirstName', 'first_name']),
        holder_last_name:
          pickField(rec, ['WooCommerceEventsAttendeeLastName', 'last_name']),
        holder_email:
          pickField(rec, ['WooCommerceEventsAttendeeEmail', 'email']),
        holder_phone:
          pickField(rec, ['WooCommerceEventsAttendeeTelephone', 'WooCommerceEventsAttendeePhone', 'phone', 'telephone']),
        attendance_date: toIso(
          pickField(rec, [
            'WooCommerceEventsBookingsDate',
            'WooCommerceEventsBookingsDateTime',
            'WooCommerceEventsDate',
            'attendance_date',
          ]) ||
          (productId ? PRODUCT_DATE_MAP[productId] : null) ||
          null,
        ),
        raw: rec,
      })
      return
    }
    // Otherwise it's a container -> recurse into values, carrying a product hint
    for (const [k, v] of Object.entries(rec)) {
      const hint = /^\d+$/.test(k) ? Number(k) : productHint
      walkTicketTree(v, hint, out)
    }
  }
}

export function parseTicketsFromOrder(order: WCOrderWithMeta): ParsedTicket[] {
  const tickets: ParsedTicket[] = []
  const meta = order.meta_data || []

  // Pull any of the order-tickets keys, parse in order, dedupe by ticket id.
  const seen = new Set<string>()
  for (const key of ORDER_TICKET_KEYS) {
    const row = meta.find((m) => m.key === key)
    if (!row || row.value === null || row.value === undefined) continue
    const collected: ParsedTicket[] = []
    walkTicketTree(row.value, null, collected)
    for (const t of collected) {
      if (seen.has(t.fooevents_ticket_id)) continue
      seen.add(t.fooevents_ticket_id)
      tickets.push(t)
    }
  }

  // Fallback path: order has line_items for a known ticket product but no
  // OrderTickets meta yet (FooEvents post-creation hook still running). We
  // still emit one ParsedTicket per line item so the verifier surfaces it as
  // pending. Holder data is sourced from the order's billing block.
  if (tickets.length === 0) {
    for (const item of order.line_items || []) {
      const ticketType = PRODUCT_TYPE_MAP[item.product_id]
      if (!ticketType) continue
      for (let n = 0; n < (item.quantity || 1); n++) {
        const syntheticId = `synthetic:${order.id}:${item.id}:${n}`
        if (seen.has(syntheticId)) continue
        seen.add(syntheticId)
        tickets.push({
          fooevents_ticket_id: syntheticId,
          product_id: item.product_id,
          ticket_type: ticketType,
          holder_first_name: order.billing?.first_name || null,
          holder_last_name: order.billing?.last_name || null,
          holder_email: order.billing?.email || null,
          holder_phone: order.billing?.phone || null,
          attendance_date: PRODUCT_DATE_MAP[item.product_id],
          raw: { source: 'line_item_fallback', line_item_id: item.id },
        })
      }
    }
  }

  return tickets
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate: holder data + festival date + product known
// ─────────────────────────────────────────────────────────────────────────────

export function validateTicket(t: ParsedTicket): ValidationResult {
  const errors: string[] = []

  if (!t.product_id || !PRODUCT_TYPE_MAP[t.product_id]) {
    errors.push('unknown_product_id')
  }
  if (!t.holder_first_name && !t.holder_last_name) {
    errors.push('missing_holder_name')
  }
  if (!t.holder_email && !t.holder_phone) {
    errors.push('missing_contact_channel')
  }
  // Festival-date check: weekend + staff badges don't pin a single date, so
  // attendance_date may be null. Single-day passes MUST land on Dec 11/12/13.
  if (t.product_id && PRODUCT_DATE_MAP[t.product_id]) {
    if (!t.attendance_date) errors.push('missing_attendance_date')
    else if (!FESTIVAL_DATES.has(t.attendance_date)) errors.push('attendance_date_off_cycle')
  }
  // fooevents_ticket_pending is a SOFT signal, not a hard fail: holder data is
  // verifiable; FooEvents will mint the ticket post-creation. The verifier UI
  // surfaces the row as "verified, FooEvents pending" via the warnings field.
  const warnings: string[] = []
  if (t.fooevents_ticket_id.startsWith('synthetic:')) {
    warnings.push('fooevents_ticket_pending')
  }

  if (errors.length === 0) {
    return { ok: true, error: warnings.length ? warnings.join(',') : null }
  }
  return { ok: false, error: [...errors, ...warnings].join(',') }
}
