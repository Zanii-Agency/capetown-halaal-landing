// =============================================================================
// lib/ai/sector-classifier.ts
//
// Sector classification. Deterministic regex map first (see sector-map.ts).
// If regex confidence < 0.7, fall back to Anthropic Haiku for a single-row
// call. Haiku client wiring mirrors the existing pattern in
// src/app/api/admin/inbox/summarize/route.ts and broadcast/spin/route.ts.
//
// Returns up to N suggestions with confidence in [0,1]. Never throws on
// LLM failure: degrades to regex-only or 'unknown' (see ANTI-HALLUCINATION
// rule 1 in the slice brief).
// =============================================================================

import Anthropic from '@anthropic-ai/sdk'
import { SECTORS, type Sector, haystackFromRow, matchSectors } from './sector-map'

export interface SectorSuggestion {
  value: Sector | 'unknown'
  confidence: number
}

export interface ClassifyInput {
  business_name?: string | null
  business_description?: string | null
  product_categories?: string[] | null
}

// Tuned so a single weight-3 hit lands at ~0.6 and two weight-3 hits land
// at ~0.86 (which clears the 0.7 cutoff and skips Haiku).
function scoreToConfidence(score: number): number {
  if (score <= 0) return 0
  // 1 - exp(-score/3) is monotonic, asymptotic to 1, never exceeds 1.
  return Math.min(1, 1 - Math.exp(-score / 3))
}

function regexSuggestions(haystack: string, limit = 3): SectorSuggestion[] {
  const matches = matchSectors(haystack)
  if (matches.length === 0) return []
  return matches.slice(0, limit).map((m) => ({
    value: m.sector,
    confidence: scoreToConfidence(m.score),
  }))
}

const HAIKU_SYSTEM = `You classify South African halaal-market vendor applications into one of these sectors:
- "Food & Beverage"
- "Fashion & Modest Wear"
- "Beauty & Wellness"
- "Health & Pharmacy"
- "Business & Trade"
- "Home & Living"
- "Travel & Tourism"
- "Advertising"

Read the business name, description, and category list. Output strictly JSON in the shape:
{"suggestions":[{"value":"<sector exactly as listed>","confidence":<0..1 float>}]}
Return up to 3 suggestions, highest confidence first. If you cannot map the vendor to any sector with at least 0.4 confidence, return {"suggestions":[{"value":"unknown","confidence":0}]}.
Never invent new sector names. Never include prose. Use commas, periods, colons, no em-dashes.`

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    const m = s.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      return JSON.parse(m[0]) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

function isSector(v: unknown): v is Sector {
  return typeof v === 'string' && (SECTORS as readonly string[]).includes(v)
}

async function haikuClassify(row: ClassifyInput): Promise<SectorSuggestion[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  const client = new Anthropic({ apiKey })
  const userMsg = `Business name: ${row.business_name ?? ''}
Description: ${row.business_description ?? ''}
Categories: ${(row.product_categories ?? []).join(', ')}

Return JSON only.`
  try {
    const resp = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      max_tokens: 250,
      system: HAIKU_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    })
    const raw = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const parsed = safeJsonParse(raw)
    if (!parsed || !Array.isArray(parsed.suggestions)) return null
    const out: SectorSuggestion[] = []
    for (const s of parsed.suggestions as unknown[]) {
      if (!s || typeof s !== 'object') continue
      const cand = s as { value?: unknown; confidence?: unknown }
      const conf = typeof cand.confidence === 'number' ? Math.max(0, Math.min(1, cand.confidence)) : 0
      if (cand.value === 'unknown') {
        out.push({ value: 'unknown', confidence: 0 })
      } else if (isSector(cand.value)) {
        out.push({ value: cand.value, confidence: conf })
      }
    }
    return out.length > 0 ? out.slice(0, 3) : null
  } catch {
    return null
  }
}

/**
 * Classify one row. Always runs regex first. Haiku fires only when regex
 * top confidence < 0.7. On Haiku failure or missing key, returns regex
 * suggestions (or [{value:'unknown', confidence:0}] if nothing matched).
 */
export async function classifySector(row: ClassifyInput): Promise<SectorSuggestion[]> {
  const haystack = haystackFromRow(row)
  const regex = regexSuggestions(haystack)
  const topConf = regex[0]?.confidence ?? 0
  if (topConf >= 0.7) return regex

  const llm = await haikuClassify(row)
  if (llm && llm.length > 0) return llm
  if (regex.length > 0) return regex
  return [{ value: 'unknown', confidence: 0 }]
}
