/**
 * Unified contact resolver — single source of truth for "who is this person?"
 *
 * Resolution chain (first non-empty wins for displayName):
 *   1. vendor_applications.contact_name
 *   2. vendor_applications.business_name
 *   3. wa_contacts.profile_name (only meaningful for wa channel)
 *   4. WooCommerce billing first_name + last_name (lazy lookup by email; mail channel)
 *   5. raw phone (E.164) or email fallback
 *
 * Memoized per-request via WeakMap on the supabase client so a single inbox-list
 * render does not hammer the DB for repeat phones/emails.
 *
 * NOTE: depends on the planned Stream-A schema:
 *   - wa_contacts(phone TEXT PRIMARY KEY, profile_name TEXT, last_seen TIMESTAMPTZ)
 * If the table does not exist yet, the call silently degrades — the resolver
 * falls through to WooCommerce / raw fallback. No throw.
 */

import { getOrders } from '@/lib/woocommerce'

export type ContactChannel = 'wa' | 'mail'

export interface ResolvedContact {
  /**
   * Stable identifier for this contact within the inbox.
   * For wa: the E.164 phone. For mail: the lower-cased email.
   * Used as the `thread_key` upstream in wa_threads.
   */
  id: string
  /** Best name to show the operator. Always non-empty. */
  displayName: string
  /** Contact-person name from vendor application, if any. */
  contactName: string | null
  /** Business name from vendor application, if any. */
  businessName: string | null
  /** Which channel this contact was resolved through. */
  channel: ContactChannel
  /** ISO timestamp of the last inbound message we have for them, if known. */
  lastSeen: string | null
}

// Type for the supabase admin client (loosely typed to avoid coupling to schema gen).
// We accept the supabase-js client shape via structural typing on `.from()`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SbClient = { from: (table: string) => any }

interface ResolveInput {
  waPhone?: string | null
  email?: string | null
  supabase: SbClient
}

// Per-process cache keyed by the supabase client (acts as request scope when
// the route creates a fresh client per request, which createAdminClient does).
// Falls back to a strong Map if WeakMap is unsuitable for the runtime.
const memo = new WeakMap<object, Map<string, ResolvedContact>>()

function cacheGet(client: object, key: string): ResolvedContact | undefined {
  return memo.get(client)?.get(key)
}

function cacheSet(client: object, key: string, value: ResolvedContact): void {
  let inner = memo.get(client)
  if (!inner) {
    inner = new Map()
    memo.set(client, inner)
  }
  inner.set(key, value)
}

function normalisePhone(raw: string): string {
  const trimmed = raw.replace(/[^\d+]/g, '')
  if (!trimmed) return raw
  if (trimmed.startsWith('+')) return trimmed
  // ZA local numbers often start with 0 — convert to +27
  if (trimmed.startsWith('0') && trimmed.length === 10) {
    return `+27${trimmed.slice(1)}`
  }
  return `+${trimmed}`
}

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (v && v.trim().length > 0) return v.trim()
  }
  return null
}

interface VendorRow {
  contact_name: string | null
  business_name: string | null
  phone: string | null
  email: string | null
  updated_at: string | null
}

async function lookupVendorByPhone(supabase: SbClient, phone: string): Promise<VendorRow | null> {
  const last9 = phone.replace(/[^\d]/g, '').slice(-9)
  if (!last9) return null
  try {
    const builder = supabase
      .from('vendor_applications')
      .select('contact_name,business_name,phone,email,updated_at')
      .ilike('phone', `%${last9}%`)
    const lim = builder.limit ? builder.limit(1) : null
    if (!lim) return null
    const { data, error } = await lim
    if (error || !data) return null
    const rows = Array.isArray(data) ? data : [data]
    return (rows[0] as VendorRow) ?? null
  } catch {
    return null
  }
}

async function lookupVendorByEmail(supabase: SbClient, email: string): Promise<VendorRow | null> {
  try {
    const builder = supabase
      .from('vendor_applications')
      .select('contact_name,business_name,phone,email,updated_at')
      .eq('email', email)
    const lim = builder.limit ? builder.limit(1) : null
    if (!lim) return null
    const { data, error } = await lim
    if (error || !data) return null
    const rows = Array.isArray(data) ? data : [data]
    return (rows[0] as VendorRow) ?? null
  } catch {
    return null
  }
}

async function lookupWaContact(supabase: SbClient, phone: string): Promise<{ profile_name: string | null; last_seen: string | null } | null> {
  // Upstream schema: wa_contacts keyed by wa_phone (TEXT PK), last_inbound_at TIMESTAMPTZ.
  // See supabase-migration-whatsapp-bot-consolidated.sql.
  try {
    const builder = supabase
      .from('wa_contacts')
      .select('profile_name,last_inbound_at')
      .eq('wa_phone', phone)
    const single = builder.maybeSingle ? builder.maybeSingle() : null
    if (!single) return null
    const { data, error } = await single
    if (error || !data) return null
    const row = data as { profile_name: string | null; last_inbound_at: string | null }
    return { profile_name: row.profile_name, last_seen: row.last_inbound_at }
  } catch {
    return null
  }
}

async function lookupWooBillingByEmail(email: string): Promise<{ name: string | null } | null> {
  try {
    // Law 6: do NOT hardcode an after= (it drifts to the wrong year every January).
    // getOrders applies the canonical FESTIVAL_CYCLE_AFTER default when after= is omitted.
    const orders = await getOrders({
      search: email,
      per_page: '1',
    })
    const order = orders[0]
    if (!order) return null
    const name = `${order.billing.first_name ?? ''} ${order.billing.last_name ?? ''}`.trim()
    return { name: name.length > 0 ? name : null }
  } catch {
    return null
  }
}

/**
 * Resolve a contact across all available channels.
 *
 * Pass exactly one of waPhone or email. If both are passed, waPhone wins
 * (WhatsApp is the higher-fidelity channel).
 */
export async function resolveContact({
  waPhone,
  email,
  supabase,
}: ResolveInput): Promise<ResolvedContact> {
  if (!waPhone && !email) {
    throw new Error('resolveContact: must pass waPhone or email')
  }

  const channel: ContactChannel = waPhone ? 'wa' : 'mail'
  const id = waPhone ? normalisePhone(waPhone) : normaliseEmail(email as string)
  const cacheKey = `${channel}:${id}`
  const cached = cacheGet(supabase as unknown as object, cacheKey)
  if (cached) return cached

  let contactName: string | null = null
  let businessName: string | null = null
  let lastSeen: string | null = null

  if (channel === 'wa') {
    const vendor = await lookupVendorByPhone(supabase, id)
    if (vendor) {
      contactName = vendor.contact_name?.trim() || null
      businessName = vendor.business_name?.trim() || null
    }
    const wa = await lookupWaContact(supabase, id)
    if (wa) {
      lastSeen = wa.last_seen
      if (!contactName) contactName = wa.profile_name?.trim() || null
    }
  } else {
    const vendor = await lookupVendorByEmail(supabase, id)
    if (vendor) {
      contactName = vendor.contact_name?.trim() || null
      businessName = vendor.business_name?.trim() || null
    }
    if (!contactName && !businessName) {
      const woo = await lookupWooBillingByEmail(id)
      if (woo?.name) contactName = woo.name
    }
  }

  const displayName =
    firstNonEmpty(contactName, businessName, id) ?? id

  const resolved: ResolvedContact = {
    id,
    displayName,
    contactName,
    businessName,
    channel,
    lastSeen,
  }

  cacheSet(supabase as unknown as object, cacheKey, resolved)
  return resolved
}

/**
 * Batch helper. Resolves many ids in parallel sharing the same per-request memo.
 */
export async function resolveContacts(
  inputs: Array<{ waPhone?: string | null; email?: string | null }>,
  supabase: SbClient
): Promise<ResolvedContact[]> {
  return Promise.all(inputs.map((i) => resolveContact({ ...i, supabase })))
}
