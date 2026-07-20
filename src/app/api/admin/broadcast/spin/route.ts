// =============================================================================
// /api/admin/broadcast/spin
//
// Rewrites a broadcast template body into three fresh variants while keeping
// the merge-tag placeholders intact. Used by the broadcast composer's "Spin"
// button so an admin can pick a fresher phrasing without losing variable
// substitution.
//
// Provider: Anthropic Claude (already wired in this repo via
// @anthropic-ai/sdk — see /api/admin/polish for the same pattern). Falls
// back to a 503 if ANTHROPIC_API_KEY is missing.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { requireOperator } from '@/lib/admin-rbac'
import { stripEmDashes } from '@/lib/festival-brain/system-prompt'

export const maxDuration = 60

const client = new Anthropic()

// Preserves doctrine law 7 (no em-dashes) and the brand voice norms used
// across CTH outbound surfaces.
const SYSTEM = `You rewrite vendor broadcast announcements for the Young at Heart Festival exhibitor team.

You produce three distinct rewrites of the SAME message. Each rewrite must:
- preserve every merge tag verbatim, including {{first_name}}, {{business_name}}, {{stall_code}}, {{stall_tier}}, {{amount_due}}, {{due_date}}, {{custom_message}}, and any other {{...}} placeholder you see
- keep the same intent and every concrete fact (dates, amounts, instructions, CTAs)
- never invent new facts or new merge tags
- never use em-dashes or en-dashes as sentence breaks; use commas, periods, colons
- stay clear, warm, professional, ready to send

Return strictly JSON in the shape: {"variants": ["...", "...", "..."]}. No preamble, no markdown.`

interface SpinBody {
  text: string
  template_key?: string
}

export async function POST(req: NextRequest) {
  // Role-gated: AI spin burns Anthropic budget and is an operator tool.
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  let body: SpinBody
  try {
    body = await req.json() as SpinBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.text || typeof body.text !== 'string' || body.text.trim().length === 0) {
    return NextResponse.json({ error: 'text required' }, { status: 400 })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 503 })
  }

  try {
    const userMsg =
      `Rewrite the following broadcast message into three distinct variants. ` +
      `Preserve every {{...}} placeholder verbatim.\n\n` +
      `Template key (for context): ${body.template_key || 'unknown'}\n\n` +
      `--- BEGIN MESSAGE ---\n${body.text}\n--- END MESSAGE ---`

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    })

    const raw = response.content[0]?.type === 'text' ? response.content[0].text : ''
    // Post-generation em-dash filter (CTH-DOCTRINE law 7). The system prompt
    // already asks the model not to use them, but we never trust LLM output.
    const variants = parseVariants(raw).map((v) => stripEmDashes(v))
    if (variants.length === 0) {
      return NextResponse.json({ error: 'No variants produced', raw }, { status: 502 })
    }

    return NextResponse.json({ variants })
  } catch (e) {
    console.error('Spin error:', e)
    return NextResponse.json({ error: 'Failed to spin text' }, { status: 500 })
  }
}

function parseVariants(raw: string): string[] {
  // Try strict JSON first.
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.variants)) {
      return parsed.variants.filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
    }
  } catch {
    // Fall through to lenient extraction.
  }
  // Lenient: find the first JSON object inside the response.
  const m = raw.match(/\{[\s\S]*"variants"[\s\S]*\}/)
  if (m) {
    try {
      const parsed = JSON.parse(m[0])
      if (Array.isArray(parsed?.variants)) {
        return parsed.variants.filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
      }
    } catch {
      // Last-resort: split by triple-newline markers.
    }
  }
  return []
}
