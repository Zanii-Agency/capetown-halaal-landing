import { createAdminClient } from '@/lib/supabase/admin'

// DDL is blocked on this Supabase project, so portal state lives as a marker
// inside vendor_applications.admin_notes — the same pattern as the ⟦STALL:..⟧
// allocation marker. State is base64-JSON so it never breaks on special chars
// and never collides with the ⟦STALL:..⟧ regex.
const PORTAL_RE = /⟦PORTAL:([A-Za-z0-9+/=]+)⟧/

export interface DocRecord {
  type: string
  path: string          // Storage object path in the vendor-docs bucket
  name: string          // original filename
  status: 'pending' | 'approved' | 'rejected'
  uploaded_at: string
  note?: string
}

/** Roles a vendor may register against a staff badge. Lifted from the
 *  staff-badges-via-fooevents spec (Samreen sign-off 2026-06-12). */
export type StaffRole = 'owner' | 'manager' | 'staff' | 'driver' | 'support'
export const STAFF_ROLES: StaffRole[] = ['owner', 'manager', 'staff', 'driver', 'support']

export interface StaffMember {
  id: string
  name: string
  /** Contact phone for the gate. New default since 2026-06-11. */
  phone?: string
  /** Legacy SA ID number, kept for backwards compatibility with pre-2026-06-11 records. */
  id_number: string
  vehicle_reg: string
  added_at: string
  /** Role on the stall. Defaults to 'staff' when not supplied. */
  role?: StaffRole
  /** WC order id once the FooEvents staff-badge order has been created. */
  wc_order_id?: number
  /** Public WC order number (often === wc_order_id, but FooEvents permits
   *  custom prefixes — keep the canonical string). */
  wc_order_number?: string
  /** FooEvents-generated ticket post id, when available. May be undefined
   *  if the hook lagged beyond our 10s poll — the admin order link still
   *  works as the lookup fallback. */
  fooevents_ticket_id?: string
  /** Admin URL where the ticket PDF can be re-downloaded. */
  ticket_pdf_url?: string
  /** Whether the FooEvents check-in has fired at the gate. Hydrated by the
   *  verifier admin from FooEvents attendee status. */
  checked_in_at?: string
  /** Set when the WC order has been cancelled (admin revoke). */
  revoked_at?: string
}

export interface MenuItem { name: string; price?: string; desc?: string }

export interface VendorProfile {
  tagline?: string
  description?: string
  logo_path?: string             // object path in vendor-assets bucket
  photo_gallery?: string[]       // additional photo paths in vendor-assets bucket
  website?: string
  instagram?: string
  facebook?: string
  menu?: MenuItem[]
  /** Opt-in flag: when true AND the vendor has an allocated stall, the public
   *  sectors page renders the stall code on the vendor's profile. Default
   *  false (privacy-first per CTH-DOCTRINE Law 2). UI toggle lives on
   *  /exhibitor/portal/stand; writer is /api/exhibitor/profile/publish-stall. */
  publish_stall?: boolean
}

export interface PortalState {
  v: number
  payment?: {
    /** 'collected' = TEMPORARY EFT lane interim state: an operator confirmed EFT
     *  money landed, so the VENDOR sees PAID and gets an acknowledgment, but
     *  `paid_at` stays NULL and it is NOT counted in finance totals. The payment
     *  only becomes final `paid` when settled through Yoco (api/admin/eft/settle).
     *  Because 'collected' never sets paid_at, the later Yoco settlement is the
     *  first-and-only paid transition, so revenue can never be double-counted. */
    status?: 'none' | 'deferred' | 'pending' | 'collected' | 'paid' | 'waived'
    /** Cumulative amount PAID so far (Rand), across the first payment plus any
     *  operator-requested top-ups. Outstanding = computeVendorPricing.total - amount. */
    amount?: number
    /** Provider refs already settled, for top-up idempotency (de-dup). */
    refs?: string[]
    due?: string
    reference?: string
    provider_ref?: string   // gateway's own txn id (FNB txnToken), used to validate on return
    paid_at?: string
    proof_path?: string
    /** ISO time the vendor most recently clicked Pay and got a checkout URL.
     *  Used to detect stale 'pending' status (Yoco checkouts time out ~15min). */
    attempted_at?: string
    /** Number of checkout attempts since approval. Lets the UI escalate to
     *  "WhatsApp support" after repeated failures. */
    attempts?: number
    /** Number of attempts the webhook marked failed. */
    failed_attempts?: number
    /** How the payment was taken. 'manual' = the /admin/finance outside-zone
     *  capture flow (its own overwrite, always wins for that flow). 'eft' |
     *  'cash' | 'manual_card' | 'waived' = the specific method an admin picked
     *  on the standard vendor Mark Paid flow (vendors/[id]/mark-paid) — this is
     *  what the invoice line and VendorPaymentsSection "Method" field show. */
    method?: 'yoco' | 'fnb' | 'manual' | 'eft' | 'samreen_eft' | 'cash' | 'manual_card' | 'waived'
    /** Venue zone (venue-zones.ts key) for non-marquee vendors that are
     *  payment-tracked + acknowledged but NOT allocated on the floor plan. */
    zone?: string
    /** Free-text note the operator added when capturing a manual payment. */
    capture_note?: string
    /** TEMPORARY EFT lane (Yoco-outage side-channel, lib/eft.ts). ISO time the
     *  VENDOR uploaded their own EFT proof. This is a PROVISIONAL flag read ONLY
     *  by the vendor-side portal (paygate + portal pages) to show "payment
     *  received, pending confirmation" and unlock the portal. It deliberately
     *  does NOT touch `status`/`paid_at`, so every admin surface still shows the
     *  vendor as unpaid until an operator reconciles via the normal mark-paid.
     *  Never set by confirmPayment(). Writer: /api/exhibitor/eft-proof. */
    eft_submitted_at?: string
    /** TEMPORARY EFT lane. ISO time the vendor last clicked "Show bank details to
     *  pay" on their EFT panel — an intent signal they are about to pay. Used ONLY
     *  to throttle the master-only WhatsApp heads-up (at most once per 12h) so a
     *  vendor re-clicking does not buzz the operator repeatedly. Never touches
     *  status/paid_at. Writer: /api/exhibitor/eft-intent. */
    eft_revealed_at?: string
    /** TEMPORARY EFT lane. ISO time an operator marked EFT money as COLLECTED
     *  (status='collected'). Interim, vendor-visible-as-paid, NOT counted in
     *  finance. Cleared/superseded when the payment is settled via Yoco and
     *  transitions to real `paid`/`paid_at`. Writer: /api/admin/eft/reconcile. */
    eft_collected_at?: string
    /** An operator-agreed postponement, set alongside status='deferred'. `until`
     *  is a plain YYYY-MM-DD date the vendor was told they have to settle by.
     *  Read by isChaseSuppressed() so the payment cron and the manual chase
     *  scripts stop billing a vendor we have promised more time. Writer:
     *  scripts/confirm-arrangement.tsx. */
    arrangement?: {
      until: string; agreed_at?: string; note?: string
      /** A multi-instalment payment PLAN the vendor proposed via WhatsApp (exact
       *  dates + amounts). `until` mirrors the LAST instalment date so the existing
       *  chase suppression already respects the whole plan. plan_status is 'pending'
       *  until the 5-minute auto-approval cron flips it to 'approved' and confirms
       *  to the vendor. Writer: lib/payments/payment-plan.ts. */
      installments?: Array<{ date: string; amount: number }>
      proposed_at?: string
      approved_at?: string
      plan_status?: 'pending' | 'approved'
    }
    /** ACCESSORY (electricity/furniture) EFT sub-ledger for vendors whose STALL
     *  fee is already settled but whose accessories were under-billed by the
     *  pre-2026-08-04 pricing bug. Mirrors the stall two-state so revenue counts
     *  once: `collected_at` = operator confirmed the accessory EFT landed (vendor
     *  sees accessories PAID, NOT counted in finance); `settled_at` = the Yoco
     *  settlement webhook folded `amount` into the cumulative payment.amount via
     *  the top-up path (now counted, exactly once). revealed/submitted mirror the
     *  stall lane's intent/proof stamps. Writers: eft-intent, eft-proof-shared,
     *  admin/eft/reconcile (accessories:true), yoco webhook. */
    acc?: { amount?: number; revealed_at?: string; submitted_at?: string; collected_at?: string; settled_at?: string; attempted_at?: string }
    /** EFT receipt / refund proof files. The file lives in the private
     *  vendor-docs bucket; only the storage path is stored here, the vendor
     *  portal mints a short-lived signed URL server-side (Law 2). kind:
     *  'receipt'|'refund' = operator-uploaded (/api/admin/vendors/[id]/payment-proof);
     *  'eft_submission' = the vendor's own EFT proof (/api/exhibitor/eft-proof). */
    proofs?: Array<{ path: string; kind: 'receipt' | 'refund' | 'eft_submission' | 'eft_accessories'; note?: string; uploaded_at: string }>
    /** PRESENT-TO-OWNER (2026-08-23). The operator showed this EFT-collected
     *  payment to the festival owner as a clean "paid via Yoco" entry (her
     *  request: the interim EFT state makes her accounting harder, she knows
     *  about EFT but wants one solid paid+Yoco view). Set by /api/admin/eft/present,
     *  which reaches the REAL paid-Yoco state via confirmPayment(method:'yoco'),
     *  so the owner-visibility wall is unchanged and the money counts exactly once.
     *  `reference` is the YAH- reference she reconciles against. The EFT evidence
     *  (eft_submitted_at, proofs, ⟦EFT⟧) stays on the record for the EFT admin. */
    presented_eft?: { at: string; reference: string }
    /** Operator-side "settle later" tracking for a presented_eft payment: the
     *  operator marked that they have squared the actual EFT money on their side.
     *  Pure bookkeeping — NO owner effect, NO finance effect (she already sees
     *  paid). Writer: /api/admin/eft/present (reconcile:true). */
    reconciled_at?: string
  }
  docs?: DocRecord[]
  staff?: StaffMember[]
  profile?: VendorProfile
  support?: SupportMessage[]
  passAllowance?: number        // gate passes this vendor is entitled to (set by organisers)
  stage?: 'approved' | 'invoiced' | 'paid' | 'docs' | 'show_ready'
  wa?: {
    phone: string              // E.164, the WhatsApp number they opted in with (may differ from vendor.phone)
    opted_in_at: string        // ISO timestamp
    welcome_sent?: boolean     // did we fire the approved welcome template
  }
  /** Pending phone-change verification. The vendor proposed a new phone in the
   *  portal; we sent a 6-digit OTP via WhatsApp to that number. The new number
   *  is NOT trusted as the vendor's contact until the OTP is confirmed at
   *  /api/exhibitor/wa-optin/verify. Cleared on success or 24h expiry. */
  phone_change_pending?: {
    new_phone: string          // E.164 candidate phone
    code_hash: string          // sha256(code + ':' + applicationId), constant-time compare
    requested_at: string       // ISO timestamp (used for expiry + rate-limit)
    attempts: number           // failed code checks; >=5 invalidates and forces re-request
  }
  /** ISO timestamp the vendor ticked the terms-and-conditions acceptance step in the portal. */
  terms_accepted_at?: string
  /** Quick admin notes with timestamps (Agent 7). */
  quickNotes?: Array<{
    id: string
    text: string
    created_at: string
    author: string | null
  }>
  /** Per-vendor notification channel preferences. Keys are `${event}_${channel}`
   *  (e.g. `stall_allocated_whatsapp`, `document_approved_email`) and are read
   *  VERBATIM by lib/notifications.ts `notifyVendor` to gate outbound sends:
   *  a missing/true value means send, an explicit false suppresses that channel.
   *  Writer: /api/exhibitor/notification-prefs. Keep keys in lockstep with the
   *  NotifyEvent union. */
  notification_preferences?: Record<string, boolean>
  /** Stall SIZE change request submitted by vendor (Agent 12). Changes the
   *  booth tier/dimensions (preferred_booth_tier). Distinct from the POSITION
   *  request below. */
  stallChangeRequest?: {
    requestedTier: string
    currentTier: string
    reason: string
    status: 'pending' | 'approved' | 'rejected'
    createdAt: string
    adminNote?: string
  }
  /** Stall POSITION / location change request. Distinct from stallChangeRequest
   *  (which changes the booth SIZE). A position request is a preference for a
   *  different spot on the floor; the operator allocates by hand on
   *  /admin/vendor-ops, so resolving it never auto-mutates the ⟦STALL:..⟧
   *  marker — same discipline as a tier change. Available pre-allocation.
   *  Writer: /api/exhibitor/stand/move. Setter: /api/admin/stall-changes. */
  stallMoveRequest?: {
    /** Preferred zone hint (TYPE_META key: FT|FS|TS|BS). Optional. */
    preferredZone?: string
    /** What the vendor is asking for (free text). */
    details: string
    /** Allocated stall code at request time, if any. */
    currentStall?: string
    status: 'pending' | 'approved' | 'rejected'
    createdAt: string
    adminNote?: string
  }
  /** Vendor withdrew / was removed by an operator (no longer trading). The DB
   *  status column has a CHECK constraint (no 'withdrawn' value) and DDL is
   *  blocked (Law 8), so a withdrawn vendor is stored as status='rejected' PLUS
   *  this marker — which distinguishes a genuine application rejection from a
   *  vendor who pulled out, and makes the action reversible (un-set + re-approve).
   *  Writer: DELETE /api/admin/vendors/[id]. */
  withdrawn?: {
    at: string                 // ISO timestamp
    by: string | null          // operator email
    reason?: string            // optional note (e.g. "no longer trading")
    freed_stalls?: string[]    // stall codes released back to the floor
  }
  /** ISO timestamp the logo-upload campaign last messaged this vendor. Set by
   *  /api/admin/vendors/logo-campaign so re-runs do not double-message. */
  logo_prompt_sent_at?: string
  /** WhatsApp numbers that verified ownership of this application via email-OTP
   *  step-up (ADR-0005). ADDITIVE: we never overwrite vendor_applications.phone,
   *  so a vendor can self-serve from a second device without corrupting their
   *  on-file contact number. resolveIdentity ALSO matches these via a queryable
   *  ⟦WAV<last9>⟧ marker written into admin_notes alongside this record. */
  verified_wa?: Array<{
    phone: string        // E.164 of the verified WhatsApp number
    bound_at: string     // ISO timestamp of OTP confirmation
  }>
  /** Pending email-OTP step-up for a WhatsApp number that did NOT uniquely
   *  resolve to this vendor. The candidate number is NOT trusted until the code
   *  emailed to the application address is confirmed. Cleared on success/expiry.
   *  Distinct from phone_change_pending (that is a portal-authenticated flow). */
  wa_verify_pending?: {
    wa_phone: string     // E.164 candidate WhatsApp number being bound
    code_hash: string    // sha256(code + ':' + applicationId), constant-time compare
    requested_at: string // ISO timestamp (expiry + rate-limit)
    attempts: number     // failed code checks; >=5 invalidates and forces re-request
  }
}

export interface SupportMessage {
  id: string
  from: 'vendor' | 'admin'
  body: string
  at: string
}

export function parsePortalState(adminNotes?: string | null): PortalState {
  const m = (adminNotes || '').match(PORTAL_RE)
  if (!m) return { v: 1 }
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as PortalState
  } catch {
    return { v: 1 }
  }
}

/** Payment states that mean the money is IN, or formally forgiven. 'collected'
 *  belongs here: an operator confirmed the EFT money landed and the vendor was
 *  already sent a payment acknowledgment, so from the vendor's side they HAVE
 *  paid. `paid_at` stays null only so finance does not count the revenue twice
 *  before Yoco settles (see the `status` doc above). */
const PAID_STATES: ReadonlySet<string> = new Set(['paid', 'waived', 'collected'])

/** True if this vendor has settled (or been waived). */
export function hasPaid(state: PortalState): boolean {
  return !!state.payment?.paid_at || PAID_STATES.has(state.payment?.status || '')
}

/** True if the vendor withdrew their application. Never chase a withdrawn vendor. */
export function isWithdrawn(state: PortalState): boolean {
  return !!state.withdrawn?.at
}

/** The in-force operator-agreed extension for this vendor, or null. An
 *  extension is in force when status is 'deferred' and either no end date was
 *  set (open-ended) or the end date has not passed. `until` is null for an
 *  open-ended arrangement. Unlike isChaseSuppressed, this does NOT silence the
 *  vendor: the cron still sends a gentle, extension-aware reminder that
 *  acknowledges the date and asks them to pay by it (operator, 2026-08-10). */
export function getArrangement(
  state: PortalState,
  now: Date = new Date()
): { until: string | null } | null {
  if (state.payment?.status !== 'deferred') return null
  const until = state.payment?.arrangement?.until
  if (until && now > new Date(`${until}T23:59:59.999Z`)) return null // lapsed
  return { until: until ?? null }
}

/** Record an operator-agreed payment extension: status='deferred' + the date
 *  the vendor must settle by (YYYY-MM-DD). Persists what was previously only
 *  spoken in chat, so every chase reader (cron, batch) honours it. Used by the
 *  backfill and by the bot when it grants more time. */
export async function setArrangement(
  applicationId: string,
  until: string,
  note?: string
): Promise<PortalState> {
  return updatePortalState(applicationId, (s) => ({
    ...s,
    payment: {
      ...(s.payment || {}),
      status: 'deferred',
      arrangement: { until, agreed_at: new Date().toISOString(), ...(note ? { note } : {}) },
    },
  }))
}

/**
 * True if the vendor must NOT be chased for payment right now, either because
 * they have already settled or because an operator agreed a deferral that has
 * not yet lapsed.
 *
 * Exists because every chase reader used to test `status === 'paid'` on its own,
 * which billed vendors on 'collected' (already paid, already acknowledged) and
 * ignored 'deferred' entirely, so a vendor promised more time was chased anyway.
 * One predicate, so a new suppression state only has to be taught once.
 */
export function isChaseSuppressed(state: PortalState, now: Date = new Date()): boolean {
  if (hasPaid(state)) return true
  if (isWithdrawn(state)) return true
  if (state.payment?.status !== 'deferred') return false
  const until = state.payment?.arrangement?.until
  // A deferral with no end date is open-ended. One WITH an end date lapses on
  // that date and the vendor becomes chaseable again: an unbounded skip would be
  // a silent revenue leak, not a courtesy.
  return !until || now <= new Date(`${until}T23:59:59.999Z`)
}

/**
 * Read-only fetch of a vendor's portal state. Scoped by applicationId (the
 * caller is responsible for binding it to a resolved identity). Returns the
 * default empty state if the row or marker is missing.
 */
export async function getPortalState(applicationId: string): Promise<PortalState> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('vendor_applications')
    .select('admin_notes')
    .eq('id', applicationId)
    .single()
  return parsePortalState((data?.admin_notes as string) || '')
}

function encode(state: PortalState): string {
  return '⟦PORTAL:' + Buffer.from(JSON.stringify(state)).toString('base64') + '⟧'
}

/**
 * Pure function: given existing admin_notes and a PortalState, produce the
 * updated admin_notes string with the PORTAL marker replaced/inserted while
 * preserving any human prose and the ⟦STALL:..⟧ allocation marker.
 */
export function updatePortalStateImpl(notes: string, state: PortalState): string {
  state.v = 1
  const rest = (notes || '').replace(PORTAL_RE, '').replace(/\n{3,}/g, '\n\n').trim()
  return rest ? `${rest}\n${encode(state)}` : encode(state)
}

/**
 * Read-modify-write the PORTAL marker on admin_notes, preserving any human
 * prose and the ⟦STALL:..⟧ allocation marker untouched. mutate() receives the
 * current state and returns the next one.
 */
export async function updatePortalState(
  applicationId: string,
  mutate: (s: PortalState) => PortalState
): Promise<PortalState> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('vendor_applications')
    .select('admin_notes')
    .eq('id', applicationId)
    .single()
  const notes = (data?.admin_notes as string) || ''
  const next = mutate(parsePortalState(notes))
  const newNotes = updatePortalStateImpl(notes, next)
  // Idempotency: skip the write when the mutation produced no change. Kills the
  // write-flood / public-flicker a repeated WhatsApp action ("publish my stall"
  // x20) would otherwise cause (ADR-004 skeptic HIGH #7).
  if (newNotes !== notes) {
    await admin.from('vendor_applications').update({ admin_notes: newNotes }).eq('id', applicationId)
  }
  return next
}

/**
 * Read Supabase columns and merge them into the portal state marker on
 * admin_notes. Returns the merged state.
 */
export async function syncPortalState(
  applicationId: string,
  supabase: ReturnType<typeof createAdminClient>
): Promise<PortalState> {
  const { data: app, error } = await supabase
    .from('vendor_applications')
    .select('admin_notes, paid_at, contract_signed_at')
    .eq('id', applicationId)
    .single()

  if (error || !app) throw new Error(`syncPortalState: no row ${applicationId}`)

  // The payment columns (payment_status, payment_amount, payment_due_date,
  // portal_stage) do not exist on vendor_applications. The ⟦PORTAL⟧ marker is
  // the source of truth for payment status/amount/due/stage. The only real
  // column worth merging IN here is paid_at: if the row shows the vendor has
  // paid but the marker has not caught up, reflect that into the marker.
  const state = parsePortalState(app.admin_notes || '')

  if (app.paid_at) {
    state.payment = {
      ...state.payment,
      status: state.payment?.status === 'paid' ? 'paid' : (state.payment?.status || 'paid'),
      paid_at: state.payment?.paid_at || app.paid_at,
    }
    // Advance to 'paid' unless the marker is already at a later stage
    // (keep 'show_ready' if already there, matching the prior behaviour).
    if (state.stage !== 'show_ready' && state.stage !== 'docs') {
      state.stage = 'paid'
    }
  }

  const updated = updatePortalStateImpl(app.admin_notes || '', state)
  await supabase
    .from('vendor_applications')
    .update({ admin_notes: updated })
    .eq('id', applicationId)

  return state
}
