// =============================================================================
// lib/ai/completeness-scorer.ts
//
// Pure scoring function for the bulk-review queue. No I/O, no LLM. The
// queue UI shows the score badge and the missing fields chip; the
// recommendation layer reads the score to nudge approve/info_request.
//
// Rubric (sums to 100 when every field is present):
//   contact_name present           +15
//   business_name present          +15
//   business_description ≥ 40 chars +15
//   product_categories ≥ 1 tag     +10
//   phone matches SA mobile regex  +15
//   email valid                    +10
//   instagram OR facebook OR website (any one) +10
//   special_requirements answered (even empty string) +5
//   preferred_booth_tier set       +5
// =============================================================================

export interface CompletenessInput {
  contact_name?: string | null
  business_name?: string | null
  business_description?: string | null
  product_categories?: string[] | null
  phone?: string | null
  email?: string | null
  instagram?: string | null
  facebook?: string | null
  website?: string | null
  special_requirements?: string | null
  preferred_booth_tier?: string | null
}

export interface CompletenessBreakdown {
  contact: boolean
  business_name: boolean
  business_desc_length_ok: boolean
  categories_present: boolean
  phone_valid_za: boolean
  email_valid: boolean
  has_social_or_web: boolean
  special_requirements_answered: boolean
  booth_tier_set: boolean
  missing: string[]
}

export interface CompletenessResult {
  score: number
  breakdown: CompletenessBreakdown
  missing: string[]
}

// SA mobile: +27 or 0 prefix, then 9 digits where the first is 1-9.
// Example matches: +27821234567, 0821234567, 27821234567.
const SA_MOBILE_RE = /^(\+?27|0)[1-9]\d{8}$/

// Tolerant email: no need to be RFC-perfect, just structurally sane for the
// queue. Tightening can happen in a downstream validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function hasText(v: string | null | undefined, min = 1): boolean {
  if (typeof v !== 'string') return false
  return v.trim().length >= min
}

function normalisedPhone(v: string | null | undefined): string {
  if (typeof v !== 'string') return ''
  return v.replace(/\s+/g, '')
}

// The public /apply form stores socials nested under
// special_requirements.social_media (a JSON string), NOT in the top-level
// instagram/facebook/website columns. So every real applicant would otherwise
// lose the social-completeness points. This reads from the SAME place the form
// writes, accepting special_requirements as a JSON string or an already-parsed
// object, and social_media as a free-text string or a {instagram,facebook,
// website,...} object. Returns true if any social/website value is present.
function hasSocialInSpecialRequirements(special: string | null | undefined): boolean {
  if (special === null || special === undefined) return false
  let parsed: unknown = special
  if (typeof special === 'string') {
    const trimmed = special.trim()
    if (trimmed === '') return false
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return false
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const social = (parsed as Record<string, unknown>).social_media
  if (typeof social === 'string') return social.trim().length > 0
  if (typeof social === 'object' && social !== null) {
    return Object.values(social as Record<string, unknown>).some(
      (v) => typeof v === 'string' && v.trim().length > 0
    )
  }
  return false
}

export function scoreCompleteness(row: CompletenessInput): CompletenessResult {
  const breakdown: CompletenessBreakdown = {
    contact: hasText(row.contact_name),
    business_name: hasText(row.business_name),
    business_desc_length_ok: hasText(row.business_description, 40),
    categories_present: Array.isArray(row.product_categories) && row.product_categories.length > 0,
    phone_valid_za: SA_MOBILE_RE.test(normalisedPhone(row.phone)),
    email_valid: typeof row.email === 'string' && EMAIL_RE.test(row.email.trim()),
    has_social_or_web:
      hasText(row.instagram) ||
      hasText(row.facebook) ||
      hasText(row.website) ||
      hasSocialInSpecialRequirements(row.special_requirements),
    // "answered, even empty string" -> we treat non-null/undefined as answered
    special_requirements_answered: row.special_requirements !== null && row.special_requirements !== undefined,
    booth_tier_set: hasText(row.preferred_booth_tier),
    missing: [],
  }

  let score = 0
  if (breakdown.contact) score += 15
  else breakdown.missing.push('contact_name')
  if (breakdown.business_name) score += 15
  else breakdown.missing.push('business_name')
  if (breakdown.business_desc_length_ok) score += 15
  else breakdown.missing.push('business_description')
  if (breakdown.categories_present) score += 10
  else breakdown.missing.push('product_categories')
  if (breakdown.phone_valid_za) score += 15
  else breakdown.missing.push('phone')
  if (breakdown.email_valid) score += 10
  else breakdown.missing.push('email')
  if (breakdown.has_social_or_web) score += 10
  else breakdown.missing.push('social_or_website')
  if (breakdown.special_requirements_answered) score += 5
  else breakdown.missing.push('special_requirements')
  if (breakdown.booth_tier_set) score += 5
  else breakdown.missing.push('preferred_booth_tier')

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown,
    missing: breakdown.missing,
  }
}
