/**
 * Shared verifier engine used by:
 *   - GET  /api/cron/ticket-verifier        (auto_cron, every 6h)
 *   - POST /api/admin/tickets/verify        (admin_manual, single-ticket re-verify)
 *
 * Single chokepoint so the two callers can't drift. Idempotent on
 * (wc_order_id, fooevents_ticket_id) via upsert.
 *
 * Law 4: WooCommerce is the source of truth. We mirror, we never mint.
 * Law 6: Every WC call goes through getOrders/getOrder, which carries `after=`.
 */

import { getOrders } from '@/lib/woocommerce'
import {
  parseTicketsFromOrder,
  validateTicket,
  fetchTicketsFromWpResolver,
  TICKET_PRODUCT_IDS,
  type ParsedTicket,
  type WCOrderWithMeta,
} from '@/lib/tickets/verify'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Try the WP resolver first; fall back to local meta-parse if the resolver
 * is unavailable, errors, or returns zero tickets. Resolver path picks up
 * real FooEvents ticket IDs that aren't reachable through the WC REST meta blob.
 */
async function resolveOrderTickets(order: WCOrderWithMeta): Promise<ParsedTicket[]> {
  const wp = await fetchTicketsFromWpResolver(order.id)
  if (wp && wp.length > 0) return wp
  return parseTicketsFromOrder(order)
}

export interface VerifyRunSummary {
  scannedOrders: number
  rowsUpserted: number
  verifiedCount: number
  erroredCount: number
  durationMs: number
  errors: Array<{ wc_order_id: number; error: string }>
}

/**
 * Pull all ticket-product WC orders since the festival cycle start, parse
 * tickets per order, upsert one row per ticket into `ticket_verifications`.
 *
 * `method` is the verified_method value written when validation passes.
 */
export async function runFullVerification(
  db: SupabaseClient,
  method: 'auto_cron' | 'admin_manual' = 'auto_cron',
  actorEmail: string | null = null,
): Promise<VerifyRunSummary> {
  const startedAt = Date.now()
  const summary: VerifyRunSummary = {
    scannedOrders: 0,
    rowsUpserted: 0,
    verifiedCount: 0,
    erroredCount: 0,
    durationMs: 0,
    errors: [],
  }

  // Pull every order with a known ticket product in this cycle.
  // `getOrders` already carries the `after=` filter (Law 6).
  // WC's `product=` filter only takes a single id, so we fetch by status
  // and product-filter in-memory. status=any to include processing+on-hold
  // tickets too (FooEvents fires generation on completed only, but pending
  // ones still belong in the ledger as `verification_error=pending_payment`).
  const orders = (await getOrders({
    status: 'completed,processing,on-hold',
    per_page: '100',
  })) as WCOrderWithMeta[]

  const ticketProductSet = new Set<number>(TICKET_PRODUCT_IDS)
  const eligible = orders.filter((o) =>
    (o.line_items || []).some((li) => ticketProductSet.has(li.product_id)),
  )
  summary.scannedOrders = eligible.length

  for (const order of eligible) {
    try {
      const tickets = await resolveOrderTickets(order)
      for (const ticket of tickets) {
        await upsertTicketRow(db, order, ticket, method, actorEmail, summary)
      }
    } catch (e) {
      summary.errors.push({ wc_order_id: order.id, error: (e as Error).message })
    }
  }

  summary.durationMs = Date.now() - startedAt
  return summary
}

/**
 * Re-verify a single WC order (and optionally a single ticket within it).
 * Used by the admin "Re-verify this ticket" button.
 */
export async function runSingleOrderVerification(
  db: SupabaseClient,
  wcOrderId: number,
  fooeventsTicketId: string | null,
  method: 'admin_manual',
  actorEmail: string | null,
): Promise<VerifyRunSummary> {
  const startedAt = Date.now()
  const summary: VerifyRunSummary = {
    scannedOrders: 0,
    rowsUpserted: 0,
    verifiedCount: 0,
    erroredCount: 0,
    durationMs: 0,
    errors: [],
  }

  // Re-pull just this order via getOrders + include={id} so the after= filter
  // doesn't drop it on the floor (Law 6 still applies; include= overrides).
  const matched = (await getOrders({ include: String(wcOrderId) })) as WCOrderWithMeta[]
  const order = matched.find((o) => o.id === wcOrderId)
  if (!order) {
    throw new Error(`wc_order_${wcOrderId}_not_found`)
  }
  summary.scannedOrders = 1

  const tickets = await resolveOrderTickets(order)
  const target = fooeventsTicketId
    ? tickets.filter((t) => t.fooevents_ticket_id === fooeventsTicketId)
    : tickets
  if (target.length === 0) {
    throw new Error(`ticket_${fooeventsTicketId ?? '*'}_not_found_on_order_${wcOrderId}`)
  }
  for (const ticket of target) {
    await upsertTicketRow(db, order, ticket, method, actorEmail, summary)
  }

  summary.durationMs = Date.now() - startedAt
  return summary
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

interface OrderMetaItem { key: string; value: unknown }

function readOrderMetaString(order: WCOrderWithMeta, key: string): string | null {
  const meta: OrderMetaItem[] = order.meta_data || []
  const row = meta.find((m) => m.key === key)
  if (!row || row.value === null || row.value === undefined) return null
  const s = String(row.value).trim()
  return s.length > 0 ? s : null
}

async function upsertTicketRow(
  db: SupabaseClient,
  order: WCOrderWithMeta,
  ticket: ParsedTicket,
  method: 'auto_cron' | 'admin_manual',
  actorEmail: string | null,
  summary: VerifyRunSummary,
): Promise<void> {
  const validation = validateTicket(ticket)

  // Staff badges: link to vendor_applications via the meta key set by
  // createStaffBadgeOrder in lib/woocommerce.ts.
  let vendorApplicationId: string | null = null
  let stallCode: string | null = null
  if (ticket.product_id === 9487) {
    vendorApplicationId = readOrderMetaString(order, 'vendor_application_id')
    stallCode = readOrderMetaString(order, 'stall_code')
  }

  const row: Record<string, unknown> = {
    wc_order_id: order.id,
    fooevents_ticket_id: ticket.fooevents_ticket_id,
    ticket_type: ticket.ticket_type,
    product_id: ticket.product_id,
    holder_first_name: ticket.holder_first_name,
    holder_last_name: ticket.holder_last_name,
    holder_email: ticket.holder_email,
    holder_phone: ticket.holder_phone,
    attendance_date: ticket.attendance_date,
    vendor_application_id: vendorApplicationId,
    stall_code: stallCode,
    verification_error: validation.error,
    raw_meta: ticket.raw,
    updated_at: new Date().toISOString(),
  }

  if (validation.ok) {
    row.verified_at = new Date().toISOString()
    row.verified_method = method
    row.verified_by_email = actorEmail
    summary.verifiedCount++
  } else {
    summary.erroredCount++
    // On failure we DO NOT overwrite existing verified_at: a transient error
    // shouldn't downgrade a previously-passing verification. We carry the
    // existing values forward by looking the row up first.
    const { data: existing } = await db
      .from('ticket_verifications')
      .select('verified_at, verified_method, verified_by_email')
      .eq('wc_order_id', order.id)
      .eq('fooevents_ticket_id', ticket.fooevents_ticket_id)
      .maybeSingle()
    if (existing) {
      row.verified_at = existing.verified_at
      row.verified_method = existing.verified_method
      row.verified_by_email = existing.verified_by_email
    }
  }

  const onConflict = 'wc_order_id,fooevents_ticket_id'
  const { error } = await db
    .from('ticket_verifications')
    .upsert(row, { onConflict })
  if (error) {
    summary.errors.push({ wc_order_id: order.id, error: error.message })
    return
  }
  summary.rowsUpserted++
}
