// Vendor application "extras" live as a JSON string in
// vendor_applications.special_requirements, written by the apply form
// (src/app/apply/page.tsx). This is the single safe reader for both the admin
// vendors list and the Excel export, so the two never drift.
//
// The form already pre-formats the fields Samreen needs:
//  - stall_type is the RAW human label (e.g. "MARQUEE Full Space - 3m x 3m
//    (R5500) - 3 entry bands included"), not the tier slug.
//  - electrical_appliances is a ready-made string (e.g. "2x Double Fryer
//    (R1600), 1x Coffee Machine (R750)").

export interface VendorExtras {
  tradedBefore: string      // "Yes" / "No" / free text
  social: string            // instagram handle / social links
  stallType: string         // raw stall-type label as chosen on the form
  stallPrice: number | null
  appliances: string        // pre-formatted appliance list ("" when none)
  applianceDetails: string  // vendor's own free-text appliance notes
  usesGas: string           // "Yes" / "No" / free text
  totalEstimate: number | null
}

const EMPTY: VendorExtras = {
  tradedBefore: '', social: '', stallType: '', stallPrice: null,
  appliances: '', applianceDetails: '', usesGas: '', totalEstimate: null,
}

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null
}

/**
 * Parse special_requirements safely. Handles null, plain-text (legacy rows that
 * stored a free-text note instead of JSON), and malformed JSON without throwing.
 */
export function parseVendorExtras(specialRequirements: string | null | undefined): VendorExtras {
  if (!specialRequirements || !specialRequirements.trim()) return { ...EMPTY }
  let j: Record<string, unknown>
  try {
    const parsed = JSON.parse(specialRequirements)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Legacy free-text note: surface it as appliance details so it isn't lost.
      return { ...EMPTY, applianceDetails: String(specialRequirements).trim() }
    }
    j = parsed as Record<string, unknown>
  } catch {
    return { ...EMPTY, applianceDetails: String(specialRequirements).trim() }
  }
  const str = (k: string) => (j[k] == null ? '' : String(j[k]).trim())
  return {
    tradedBefore: str('traded_before'),
    social: str('social_media'),
    stallType: str('stall_type'),
    stallPrice: num(j['stall_price']),
    appliances: str('electrical_appliances'),
    applianceDetails: str('appliance_details'),
    usesGas: str('uses_gas'),
    totalEstimate: num(j['total_estimate']),
  }
}
