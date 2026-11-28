// Per-category required-doc lookup. Replaces the hardcoded
// REQUIRED_DOCS list that used to live in src/app/exhibitor/portal/page.tsx.
//
// Source of truth: Samreen's category-level compliance brief (2026-06-08).
// - Public liability + Electrical CoC are covered by the organisers, vendors
//   do NOT upload these. They are intentionally absent from every list.
// - Halaal certificate / declaration is optional everywhere it is listed.
// - Health permit (City of Cape Town food trading permit) is mandatory for
//   anything that handles food.
// - Gas certification is mandatory for food trucks (gas is on by default in
//   that build), optional for marquee food stalls (only if they cook with gas).
// - Modest fashion / beauty / health-pharmacy / travel / home / finance /
//   business categories carry no compliance docs at the festival level.

export type DocType =
  | 'halaal_cert'
  | 'health_permit'
  | 'gas_cert'
  | 'public_liability'
  | 'electrical_coc'
  | 'fire_safety'
  | 'indemnity'
  | 'vendor_contract'
  | 'contract'
  | 'other'

// Tier slug fragments that mean "food truck". The portal stores the full slug
// (e.g. food-truck-4.5m) in vendor_applications.preferred_booth_tier.
const FOOD_TRUCK_HINT = /^food-truck/i

// Categories are the labels users pick in /apply (ITEM_CATEGORIES).
// We normalise them to lowercase before the lookup to absorb prior data
// (some legacy rows have "food & beverage" / "Food and Beverage" / etc).
const CATEGORY_RULES: Array<{ match: (cat: string) => boolean; docs: DocType[] }> = [
  // Food & beverage: halaal + health permit. Gas is conditional and surfaced
  // by the DocumentsManager UI itself, not gated as required here.
  { match: (c) => /food|beverage|bever|drink|catering/.test(c), docs: ['halaal_cert', 'health_permit'] },
  // Modest fashion + Beauty + Wellness + Health/Pharmacy: no festival-level
  // compliance docs required. Public liability is on the organisers.
  { match: (c) => /modest|fashion|beauty|wellness|health.*pharm|pharmacy/.test(c), docs: [] },
  // Travel + Home + Finance + Business categories: none.
  { match: (c) => /travel|tourism|home|living|finance|services|business|trade/.test(c), docs: [] },
]

/**
 * Resolve the list of doc types a vendor MUST upload before show-day, given
 * their product categories and stall tier. Food trucks always include gas
 * cert on top of food docs (gas is the default heat source in a truck).
 *
 * Empty list = nothing required at the festival level (good standing by
 * default — typical for fashion/beauty/services vendors).
 */
export function getRequiredDocs(opts: {
  productCategories?: string[] | null
  boothTier?: string | null
  /** vendor_applications.admin_notes: admin-added ⟦REQDOC:..⟧ extras merge in. */
  admin_notes?: string | null
}): DocType[] {
  const cats = (opts.productCategories || [])
    .filter(Boolean)
    .map((c) => String(c).toLowerCase().trim())

  const set = new Set<DocType>()
  for (const cat of cats) {
    for (const rule of CATEGORY_RULES) {
      if (rule.match(cat)) {
        for (const d of rule.docs) set.add(d)
        break
      }
    }
  }

  // Food trucks: gas is mandatory regardless of how the category was labelled.
  const tier = (opts.boothTier || '').toLowerCase()
  if (FOOD_TRUCK_HINT.test(tier)) {
    set.add('halaal_cert')
    set.add('health_permit')
    set.add('gas_cert')
  }

  for (const d of extraRequiredDocs(opts.admin_notes)) set.add(d)

  return Array.from(set)
}

// Per-vendor extras an admin added after a chat (e.g. gas cert for a stall
// that turned out to cook with gas). Stored as ⟦REQDOC:<type>⟧ markers on
// admin_notes (DDL is blocked, Law 8). Only types the portal upload route
// accepts, so the vendor can always actually upload what we ask for.
export const EXTRA_DOC_TYPES = [
  'halaal_cert', 'health_permit', 'gas_cert', 'fire_safety', 'public_liability',
  'electrical_coc', 'contract', 'indemnity', 'other',
] as const satisfies readonly DocType[]
const REQDOC_RE = /⟦REQDOC:([a-z_]+)⟧/g

export function extraRequiredDocs(adminNotes: string | null | undefined): DocType[] {
  const out = new Set<DocType>()
  for (const m of (adminNotes || '').matchAll(REQDOC_RE)) {
    if ((EXTRA_DOC_TYPES as readonly string[]).includes(m[1])) out.add(m[1] as DocType)
  }
  return Array.from(out)
}

/** Add or remove one ⟦REQDOC:..⟧ marker, leaving every other marker and prose intact. */
export function withExtraRequiredDoc(adminNotes: string | null | undefined, type: string, on: boolean): string {
  const marker = `⟦REQDOC:${type}⟧`
  const base = (adminNotes || '').split(marker).join('').replace(/[ \t]{2,}/g, ' ').trim()
  return on ? `${base}${base ? '\n' : ''}${marker}` : base
}

/**
 * Friendly label for a doc type. Used by the Overview tile when the required
 * list is empty (we still want a positive copy line, not "0/0").
 */
export const DOC_LABEL: Record<DocType, string> = {
  halaal_cert: 'Halaal certificate or declaration',
  health_permit: 'Health permit',
  gas_cert: 'Gas certification',
  public_liability: 'Public liability insurance',
  electrical_coc: 'Electrical certificate of compliance',
  fire_safety: 'Fire-safety certificate',
  indemnity: 'Indemnity',
  vendor_contract: 'Vendor contract',
  contract: 'Vendor contract',
  other: 'Other supporting documents',
}
