/**
 * Everything we can send a vendor, in one registry.
 *
 * Taona, 2026-07-27: "add a library function that has everything the bot or
 * human might need to send to a vendor including documents per vendor etc."
 *
 * WHY THIS IS MORE THAN A CONVENIENCE. The bot has been offering things it
 * cannot deliver. It told a vendor "Want me to also send you your contract to
 * sign?" and `send_contract` returns a STRING, never a file. It said "your
 * banking details are already available" about a page it had never read. The
 * offer and the delivery lived in different places, so the offer could drift
 * from anything real.
 *
 * With one registry the bot can only offer what `availableFor` says exists, and
 * anything offered is one `build` call from actually going out. The
 * "promises something and never sends it" class stops being a bug you fix and
 * becomes a state you cannot express.
 *
 * The human composer reads the same list, so an operator and the bot are never
 * working from different ideas of what a vendor can be sent.
 *
 * NOT HERE: staff badges. deliverBadge is per PERSON and needs a WooCommerce
 * order id per badge (badge-pdf.ts:21, the QR payload), so it does not fit a
 * per-vendor shape. It stays on its own path rather than being bent into this
 * one.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { vendorFacingPricing } from '@/lib/payments/vendor-pricing'
import { paymentReference } from '@/lib/payments'
import { renderInvoicePdf } from '@/lib/payments/invoice-pdf'

const PORTAL = 'https://cthalaal.co.za/exhibitor/login'

export interface SendableItem {
  key: string
  label: string
  /** One line the operator sees in the picker, and the bot sees in its tool. */
  description: string
  kind: 'document' | 'link'
}

export interface BuiltSendable {
  kind: 'document' | 'link'
  caption: string
  /** kind: 'document' */
  filename?: string
  mimeType?: string
  bytes?: Buffer
  /** kind: 'link' */
  url?: string
}

interface VendorRow {
  id: string
  business_name: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  status: string | null
  admin_notes: string | null
  preferred_booth_tier: string | null
  special_requirements: unknown
  contract_signed_at: string | null
  contract_pdf_path: string | null
}

const SELECT =
  'id, business_name, contact_name, email, phone, status, admin_notes, preferred_booth_tier, special_requirements, contract_signed_at, contract_pdf_path'

async function vendorRow(applicationId: string): Promise<VendorRow | null> {
  const { data } = await createAdminClient()
    .from('vendor_applications').select(SELECT).eq('id', applicationId).maybeSingle()
  return (data as VendorRow) ?? null
}

const slug = (s: string | null) =>
  (s || 'vendor').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'vendor'

// ---------------------------------------------------------------------------
// The registry. `available` is what stops the bot promising fiction.
// ---------------------------------------------------------------------------

interface Definition extends SendableItem {
  available: (v: VendorRow) => boolean
  build: (v: VendorRow) => Promise<BuiltSendable | null>
}

const DEFINITIONS: Definition[] = [
  {
    key: 'invoice',
    label: 'Invoice (PDF)',
    description: "The vendor's stall fee invoice, with their reference and current payment status.",
    kind: 'document',
    // Needs a tier to price. Without one computeVendorPricing throws and the
    // old tool would have "sent" nothing while saying it had.
    available: (v) => !!v.preferred_booth_tier,
    build: async (v) => {
      const state = parsePortalState(v.admin_notes || '')
      let amount = state.payment?.amount ?? 0
      if (!amount) {
        try {
          amount = vendorFacingPricing({
            id: v.id,
            preferred_booth_tier: v.preferred_booth_tier as string,
            special_requirements: v.special_requirements,
            admin_notes: v.admin_notes,
          }).total
        } catch { return null }
      }
      const bytes = await renderInvoicePdf({
        applicationId: v.id,
        adminNotes: v.admin_notes,
        businessName: v.business_name || '',
        contactName: v.contact_name || '',
        email: v.email || '',
        phone: v.phone || undefined,
        amount,
        status: state.payment?.status || 'none',
        reference: state.payment?.reference || paymentReference(v.id),
        providerRef: state.payment?.provider_ref || '',
        method: state.payment?.method,
        preferredBoothTier: v.preferred_booth_tier || '',
        specialRequirements: v.special_requirements,
      })
      if (!bytes) return null
      return {
        kind: 'document',
        bytes,
        filename: `CTH-Invoice-${slug(v.business_name)}.pdf`,
        mimeType: 'application/pdf',
        caption: 'Your Cape Town Halaal Festival invoice.',
      }
    },
  },
  {
    key: 'contract',
    label: 'Signed contract (PDF)',
    description: 'Their countersigned contract. Only exists once they have signed.',
    kind: 'document',
    available: (v) => !!v.contract_signed_at && !!v.contract_pdf_path,
    build: async (v) => {
      const { data, error } = await createAdminClient()
        .storage.from('vendor-docs').download(v.contract_pdf_path as string)
      if (error || !data) return null
      const bytes = Buffer.from(await data.arrayBuffer())
      return {
        kind: 'document',
        bytes,
        filename: `CTH-Contract-${slug(v.business_name)}.pdf`,
        mimeType: 'application/pdf',
        caption: 'Your signed Cape Town Halaal Festival contract.',
      }
    },
  },
  {
    key: 'contract_link',
    label: 'Contract to sign (link)',
    description: 'Portal link to review and sign, for a vendor who has not signed yet.',
    kind: 'link',
    available: (v) => !v.contract_signed_at,
    build: async () => ({
      kind: 'link',
      url: PORTAL,
      caption: `Your contract is waiting in your portal. Log in at ${PORTAL} and open Contract to read and sign it.`,
    }),
  },
  {
    key: 'payments',
    label: 'Payments page (link)',
    description: 'Where they pay and upload proof. Never quote figures or details, the page is the source.',
    kind: 'link',
    available: () => true,
    build: async () => ({
      kind: 'link',
      url: PORTAL,
      caption: `Everything for your stall fee is in your portal. Log in at ${PORTAL} and open Payments, and it is all there ready for you.`,
    }),
  },
  {
    key: 'portal',
    label: 'Portal login (link)',
    description: 'The exhibitor portal itself.',
    kind: 'link',
    available: () => true,
    build: async () => ({
      kind: 'link',
      url: PORTAL,
      caption: `You can manage everything for your stall in your portal: ${PORTAL}`,
    }),
  },
  {
    key: 'logo_upload',
    label: 'Logo upload (link)',
    description: 'Where they add or change the logo shown on the public vendor list.',
    kind: 'link',
    available: () => true,
    build: async () => ({
      kind: 'link',
      url: PORTAL,
      caption: `You can upload or change your logo in your portal at ${PORTAL}, under Profile.`,
    }),
  },
]

/** Documents this VENDOR uploaded, offered back to them. Dynamic, so they are
 *  built from the row rather than declared in the registry above. */
function ownDocumentItems(v: VendorRow): SendableItem[] {
  const docs = parsePortalState(v.admin_notes || '').docs || []
  return docs.map((d, i) => ({
    key: `doc:${i}`,
    label: `${d.type || 'Document'} (their upload)`,
    description: `${d.name || 'Uploaded document'}, sent back to the vendor.`,
    kind: 'document' as const,
  }))
}

async function buildOwnDocument(v: VendorRow, index: number): Promise<BuiltSendable | null> {
  const docs = parsePortalState(v.admin_notes || '').docs || []
  const doc = docs[index]
  if (!doc?.path) return null
  const { data, error } = await createAdminClient().storage.from('vendor-docs').download(doc.path)
  if (error || !data) return null
  return {
    kind: 'document',
    bytes: Buffer.from(await data.arrayBuffer()),
    filename: doc.name || `document-${index + 1}`,
    mimeType: (data as Blob).type || 'application/octet-stream',
    caption: `Here is the ${doc.type || 'document'} you uploaded.`,
  }
}

/**
 * Pure availability, exported so the rule the bot depends on is testable without
 * Supabase. This is the guarantee: a key absent from here can never be offered,
 * and a key present here has a build path.
 */
export function availableKeysFor(v: {
  preferred_booth_tier?: string | null
  contract_signed_at?: string | null
  contract_pdf_path?: string | null
}): string[] {
  return DEFINITIONS.filter((d) => d.available(v as VendorRow)).map((d) => d.key)
}

/** What can be sent to THIS vendor right now. */
export async function listSendables(applicationId: string): Promise<SendableItem[]> {
  const v = await vendorRow(applicationId)
  if (!v) return []
  const base = DEFINITIONS.filter((d) => d.available(v)).map(({ key, label, description, kind }) =>
    ({ key, label, description, kind }))
  return [...base, ...ownDocumentItems(v)]
}

/**
 * Build one item. Returns null when it cannot be produced, and the CALLER must
 * treat null as "say nothing went out" rather than claiming success: the whole
 * point of this module is that a promise and a delivery cannot diverge.
 */
export async function buildSendable(applicationId: string, key: string): Promise<BuiltSendable | null> {
  const v = await vendorRow(applicationId)
  if (!v) return null
  if (key.startsWith('doc:')) {
    const i = Number(key.slice(4))
    return Number.isInteger(i) && i >= 0 ? buildOwnDocument(v, i) : null
  }
  const def = DEFINITIONS.find((d) => d.key === key)
  if (!def || !def.available(v)) return null
  try {
    return await def.build(v)
  } catch (e) {
    console.error(`[send-library] ${key} failed for ${applicationId}:`, (e as Error).message)
    return null
  }
}

/** Keys only, for the bot's tool description so it cannot invent one. */
export async function sendableKeys(applicationId: string): Promise<string[]> {
  return (await listSendables(applicationId)).map((i) => i.key)
}
