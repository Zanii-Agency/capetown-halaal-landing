// Unified inbox AI actions — powers the six assist cards in the master inbox.
//
// Each action loads the contact's real thread (WhatsApp by phone + email by
// peer_email, no wa_threads) and runs a single grounded Anthropic call. The key
// is the funded prod key (KT #320). Output is text the client either drops into
// the composer (reply/follow-up/tone/attachments) or shows in a result strip
// (summary/status). Everything is grounded in the thread + festival hard facts,
// and we strip em-dashes (CTH-DOCTRINE law 7) on the way out.

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import { stripEmDashes } from '@/lib/festival-brain/system-prompt'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null

const ACTIONS = [
  'smart_reply',
  'tone_adjust',
  'follow_up',
  'summarize',
  'attachments',
  'status_update',
] as const
type Action = (typeof ACTIONS)[number]

const bodySchema = z.object({
  action: z.enum(ACTIONS),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(160).optional(),
  draft: z.string().max(4000).optional(),
})

interface Turn { role: 'vendor' | 'team'; channel: 'whatsapp' | 'email'; text: string; at: string }

const HARD_FACTS = `FESTIVAL FACTS (use only these, never invent):
- Young at Heart Festival (Cape Town Halaal), 11 to 13 December 2026, Youngsfield Military Base, Wetton Road, Claremont, Cape Town.
- Tickets R30/day, R60 weekend pass, children under 3 free. Buy + apply at cthalaal.co.za. Vendor apply: cthalaal.co.za/apply. Exhibitor portal: cthalaal.co.za/exhibitor/login.
- All food on site is strictly halaal. Free parking on site. Contact: support@youngatheart.co.za.
- Vendor flow: apply, approval takes a few working days, pay stall fee by card in the portal, stall allocated closer to the festival.`

const STYLE = `STYLE: warm, plain, concise. 2 to 4 sentences. No em-dashes or en-dashes, use commas/periods/colons. Never say AI assistant, Claude, OpenAI, Anthropic. You are the Young at Heart festival team. Do not invent prices, stall numbers, dates, or banking details. If you do not know, defer to support@youngatheart.co.za.`

async function loadThread(db: ReturnType<typeof createAdminClient>, phone?: string, email?: string): Promise<Turn[]> {
  const turns: Turn[] = []
  if (phone) {
    const noPlus = phone.replace(/^\+/, '')
    const { data } = await db
      .from('wa_messages')
      .select('direction, body, created_at, template_name')
      .or(`wa_phone.eq.+${noPlus},wa_phone.eq.${noPlus}`)
      .order('created_at', { ascending: true })
      .limit(60)
    for (const m of (data || []) as Array<{ direction: string; body: string | null; created_at: string; template_name: string | null }>) {
      const text = (m.body || '').trim()
      if (!text || /^\s*\[[A-Z_]+\]/.test(text) || /HUMAN_HANDOVER/.test(text) || /^\s*🛎/u.test(text)) continue
      turns.push({ role: m.direction === 'in' ? 'vendor' : 'team', channel: 'whatsapp', text, at: m.created_at })
    }
  }
  if (email) {
    const { data: threads } = await db.from('support_inbox_threads').select('id').ilike('peer_email', email)
    const ids = (threads || []).map((t: { id: string }) => t.id)
    if (ids.length) {
      const { data } = await db
        .from('support_inbox_messages')
        .select('direction, body_text, subject, received_at')
        .in('thread_id', ids)
        .order('received_at', { ascending: true })
        .limit(60)
      for (const m of (data || []) as Array<{ direction: string; body_text: string | null; subject: string | null; received_at: string }>) {
        const text = (m.body_text || m.subject || '').trim()
        if (!text) continue
        turns.push({ role: m.direction === 'in' ? 'vendor' : 'team', channel: 'email', text, at: m.received_at })
      }
    }
  }
  turns.sort((a, b) => +new Date(a.at) - +new Date(b.at))
  return turns.slice(-30)
}

function transcript(turns: Turn[]): string {
  if (!turns.length) return '(no prior messages)'
  return turns.map((t) => `${t.role === 'vendor' ? 'THEM' : 'US'} (${t.channel}): ${t.text}`).join('\n')
}

function lastInbound(turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'vendor') return turns[i].text
  return null
}

function promptFor(action: Action, turns: Turn[], draft: string): { system: string; user: string } | { error: string } {
  const convo = transcript(turns)
  const base = `${HARD_FACTS}\n\n${STYLE}`
  switch (action) {
    case 'smart_reply': {
      const inbound = lastInbound(turns)
      if (!inbound) return { error: 'No incoming message to reply to yet.' }
      return { system: `You are the Young at Heart festival team replying to a vendor or guest on the same channel. Write the reply only, no preamble.\n\n${base}`, user: `CONVERSATION:\n${convo}\n\nWrite the best reply to their latest message.` }
    }
    case 'tone_adjust': {
      if (!draft.trim()) return { error: 'Type a draft reply first, then adjust its tone.' }
      return { system: `You rewrite a draft reply to be warmer and clearer while keeping the meaning and all facts. Output the rewritten reply only.\n\n${base}`, user: `DRAFT:\n${draft}\n\nRewrite it warmer, clearer, and a touch more professional. Keep it short.` }
    }
    case 'follow_up':
      return { system: `You write a short proactive follow-up to move this conversation forward (e.g. nudge to apply, pay, send a halaal certificate, or confirm details). Output the message only.\n\n${base}`, user: `CONVERSATION:\n${convo}\n\nWrite a helpful follow-up nudge appropriate to where this conversation stands.` }
    case 'summarize':
      return { system: `You summarise a support conversation for a festival operator. Output 1 to 2 sentences: who they are, what they want, and what is outstanding. No greeting.\n\n${STYLE}`, user: `CONVERSATION:\n${convo}\n\nSummarise it.` }
    case 'attachments':
      return { system: `You suggest which festival links or documents the team should send next, with one short reason each. Only use these real links: cthalaal.co.za/apply (vendor application), cthalaal.co.za/exhibitor/login (exhibitor portal), cthalaal.co.za (tickets and info), support@youngatheart.co.za (contact). Output a short bullet list.\n\n${STYLE}`, user: `CONVERSATION:\n${convo}\n\nWhat should we send them next?` }
    case 'status_update':
      return { system: `You advise the operator on the right next status for this conversation: RESOLVE (done, nothing outstanding), SNOOZE (waiting on them or a date), or OPEN (needs a reply now). Output the one-word recommendation in caps, then one short sentence why.\n\n${STYLE}`, user: `CONVERSATION:\n${convo}\n\nRecommend RESOLVE, SNOOZE, or OPEN and why.` }
  }
}

export async function POST(req: NextRequest) {
  // RBAC: owner/operator only. This route burns LLM budget and reads full
  // vendor PII (WhatsApp + email transcripts), so a viewer-role admin must
  // not run it. requireOperator preserves 401-before-403 semantics.
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const db = createAdminClient()

  if (!client) return NextResponse.json({ error: 'AI is not configured right now.' }, { status: 503 })

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    throw e
  }
  if (!body.phone && !body.email) return NextResponse.json({ error: 'phone or email required' }, { status: 400 })

  const turns = await loadThread(db, body.phone, body.email)
  const prompt = promptFor(body.action, turns, body.draft || '')
  if ('error' in prompt) return NextResponse.json({ ok: false, message: prompt.error }, { status: 200 })

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 320,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    })
    const text = res.content[0]?.type === 'text' ? res.content[0].text : ''
    const clean = stripEmDashes(text).trim()
    // reply/follow-up/tone/attachments fill the composer; summary/status show in a strip.
    const fillsComposer = ['smart_reply', 'tone_adjust', 'follow_up'].includes(body.action)
    return NextResponse.json({ ok: true, action: body.action, text: clean, fillsComposer })
  } catch (err) {
    console.error('[inbox/ai] error', err)
    return NextResponse.json({ ok: false, message: 'AI could not respond just now. Try again.' }, { status: 502 })
  }
}
