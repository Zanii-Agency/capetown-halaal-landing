// Required document slots displayed in the Vendor Hub. Mirrors
// REQUIRED_DOC_TYPES in /api/admin/vendors/[id]/doc-action/route.ts.
//
// Keep these two in sync. Slot keys are the marker that flows into
// portal.docs[].type via the existing exhibitor upload flow. Canonical
// spelling: `halaal_cert` (two a's), matching what the portal actually writes.
export const REQUIRED_DOC_TYPES = [
  'halaal_cert',
  'health_permit',
] as const

export type RequiredDocType = (typeof REQUIRED_DOC_TYPES)[number]

// Labels for ALL doc types the portal may upload, not just the strictly
// required ones, so admin tables/drawers render a friendly name for every
// row (halaal_cert, health_permit, gas_cert, and the legacy/extra slots).
export const REQUIRED_DOC_LABELS: Record<string, string> = {
  halaal_cert: 'Halaal certificate or declaration',
  health_permit: 'Health / food permit',
  gas_cert: 'Gas certification',
  fire_safety: 'Fire-safety certificate',
  public_liability: 'Public liability cover',
  electrical_coc: 'Electrical certificate of compliance',
  contract: 'Vendor contract',
  indemnity: 'Indemnity',
  other: 'Other supporting documents',
}
