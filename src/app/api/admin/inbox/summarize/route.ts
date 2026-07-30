/**
 * POST /api/admin/inbox/summarize
 *
 * On-demand thread summary + suggested replies. Replaces the old useEffect-on-
 * select pattern (Stream-C placeholder) with an explicit operator-triggered
 * call. Caches the response for 10 minutes per thread key so flicking back
 * and forth doesn't re-burn the LLM.
 *
 * Returns:
 *   {
 *     ok: true,
 *     summary: string,          // 2-4 sentence rollup of the thread state
 *     suggested_replies: string[]  // 3 short, clickable canned chips
 *     cached_at: string         // ISO; client uses for "synced N min ago" badge
 *   }
 *
 * Calls Anthropic directly with a tight ops-only system prompt. The festival
 * brain is for vendor / visitor chat and owns FAQ + intent routing, which is
 * the wrong shape for structured operator JSON. NEVER mentions Claude /
 * Anthropic / OpenAI; the system prompt scopes the assistant to an internal
 * ops aide.
 */

import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { wrapUntrusted, UNTRUSTED_CONTENT_RULE } from '@/lib/ai/prompt-safety'
import { hidesEftContent, stripEftMessages, laneScopeFor } from '@/lib/inbox-lane'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface SummarizeBody {
  thread_id: string
  force?: boolean // bypass cache
}

const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { at: number; payload: Record<string, unknown> }>()

const OPS_SYSTEM = `You are an internal ops aide for the Young at Heart Festival admin team.
You are NEVER addressed by vendors or customers; you only help operators triage their inbox.
Output strictly valid JSON with two keys:
  - "summary": a 2-4 sentence plain-text rollup of where the thread stands and what the operator should do next.
  - "suggested_replies": an array of three short reply chips (max 140 chars each), in the operator's voice, plain text, no em-dashes.
Never refer to yourself as an AI, a model, or a vendor. Never mention Claude, Anthropic, OpenAI, or any provider. If the thread is empty, say so in the summary and return an empty suggested_replies array. Always reply with JSON only, no prose around it.

${UNTRUSTED_CONTENT_RULE}`

// Carries the viewer's email: the EFT lane check below needs to know WHO is
// summarising (only the EFT admin may summarise a lane vendor's thread).
async function requireAdmin(): Promise<{ userId: string; email: string | null } | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const admin = createAdminClient()
  const { data } = await admin.from('admin_users').select('id').eq('id', user.id).limit(1)
  if (!data || data.length === 0) return null
  return { userId: user.id, email: user.email ?? null }
}

interface ThreadRow {
  id: string
  thread_key: string
  channel: 'wa' | 'mail'
}

interface NormalisedMsg {
  direction: 'in' | 'out'
  body: string
  created_at: string
}

async function loadMessages(
  supabase: ReturnType<typeof createAdminClient>,
  thread: ThreadRow
): Promise<NormalisedMsg[]> {
  if (thread.channel === 'wa') {
    const { data } = (await supabase
      .from('wa_messages')
      .select('direction, body, created_at')
      .eq('wa_phone', thread.thread_key.replace(/^\+/, ''))
      .order('created_at', { ascending: true })
      .limit(40)) as unknown as { data: Array<{ direction: string; body: string | null; created_at: string }> | null }
    return (data ?? []).map((m) => ({
      direction: m.direction === 'out' ? 'out' : 'in',
      body: m.body ?? '',
      created_at: m.created_at,
    }))
  }
  const { data } = (await supabase
    .from('mail_messages')
    .select('direction, body, received_at')
    .eq('thread_id', thread.id)
    .order('received_at', { ascending: true })
    .limit(40)) as unknown as { data: Array<{ direction: string; body: string | null; received_at: string }> | null }
  return (data ?? []).map((m) => ({
    direction: m.direction === 'outbound' ? 'out' : 'in',
    body: m.body ?? '',
    created_at: m.received_at,
  }))
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    // Try to pluck the first JSON object substring (LLMs sometimes wrap)
    const m = s.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      return JSON.parse(m[0]) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

export async function POST(req: Request) {
  const session = await requireAdmin()
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: SummarizeBody
  try {
    body = (await req.json()) as SummarizeBody
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  if (!body.thread_id) {
    return NextResponse.json({ error: 'thread_id required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  const { data: threadRows } = (await supabase
    .from('wa_threads')
    .select('id, thread_key, channel')
    .eq('id', body.thread_id)
    .limit(1)) as unknown as { data: ThreadRow[] | null }

  if (!threadRows || threadRows.length === 0) {
    return NextResponse.json({ error: 'thread not found' }, { status: 404 })
  }
  const thread = threadRows[0]

  // CONTENT-level (2026-07-26): any admin may summarise any vendor's thread, but
  // the EFT messages are stripped from the transcript BEFORE it reaches the model
  // — a summary is generated FROM the bodies, so filtering after the fact would
  // be too late. The cache key carries the flag: a summary built from the full
  // transcript must never be served to someone who may not see all of it.
  const scope = await laneScopeFor(session.email)
  const outOfScope = thread.channel === 'wa'
    ? scope.blocksPhone(thread.thread_key)
    : scope.blocksEmail(thread.thread_key)
  if (outOfScope) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const hide = hidesEftContent(session.email)
  const cacheKey = `${thread.channel}:${thread.id}${hide ? ':redacted' : ''}`

  if (!body.force) {
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return NextResponse.json({ ok: true, cached: true, ...hit.payload })
    }
  }

  const identity = thread.channel === 'wa' ? { phone: thread.thread_key } : { email: thread.thread_key }
  const msgs = stripEftMessages(await loadMessages(supabase, thread), (m) => m.body, hide, {
    scope,
    identity,
    at: (m) => m.created_at,
  })
  if (msgs.length === 0) {
    const payload = {
      summary: 'No messages yet on this thread.',
      suggested_replies: [],
      cached_at: new Date().toISOString(),
    }
    cache.set(cacheKey, { at: Date.now(), payload })
    return NextResponse.json({ ok: true, cached: false, ...payload })
  }

  const transcript = msgs
    .slice(-20)
    .map(
      (m) =>
        `[${m.direction === 'in' ? 'them' : 'us'} ${m.created_at.slice(0, 16)}] ${m.body.slice(0, 500)}`
    )
    .join('\n')

  // N3: vendor-controlled text is wrapped in delimiters so the model treats
  // it as data, not as instruction. The system prompt explains the contract.
  const user = `Channel: ${thread.channel}
Contact: ${thread.thread_key}

Transcript (oldest first) follows in the untrusted block.
${wrapUntrusted(transcript)}

Return JSON with "summary" and "suggested_replies" (3 short chips).`

  let raw: string
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'summary engine offline' }, { status: 503 })
    }
    const client = new Anthropic({ apiKey })
    const resp = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      max_tokens: 400,
      system: OPS_SYSTEM,
      messages: [{ role: 'user', content: user }],
    })
    const block = resp.content[0]
    raw = block && block.type === 'text' ? block.text : ''
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }

  const parsed = safeJsonParse(raw)
  if (!parsed) {
    return NextResponse.json({
      ok: true,
      cached: false,
      summary: raw.slice(0, 400),
      suggested_replies: [],
      cached_at: new Date().toISOString(),
      parse_warn: true,
    })
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
  const suggestions = Array.isArray(parsed.suggested_replies)
    ? (parsed.suggested_replies as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 3)
        .map((s) => s.replace(/[–—]/g, ',').trim())
        .filter((s) => s.length > 0)
    : []

  const payload = {
    summary: summary.replace(/[–—]/g, ',').trim(),
    suggested_replies: suggestions,
    cached_at: new Date().toISOString(),
  }
  cache.set(cacheKey, { at: Date.now(), payload })
  return NextResponse.json({ ok: true, cached: false, ...payload })
}
