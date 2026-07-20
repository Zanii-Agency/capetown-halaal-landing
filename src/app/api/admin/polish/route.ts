import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { requireOperator } from '@/lib/admin-rbac'

const client = new Anthropic()

const SYSTEM = `You standardise broadcast announcements for the Young at Heart Festival exhibitor/vendor team.
Rewrite the message so it is clear, correctly spelled and punctuated, professional but warm, and ready to send to exhibitors.
Keep all facts (dates, times, instructions) exactly as given. Do not invent details. Keep it concise.
Return only the rewritten announcement, no preamble.`

export async function POST(req: NextRequest) {
  try {
    // Role-gated: AI polish burns Anthropic budget, operator tool.
    const gate = await requireOperator()
    if (!gate.ok) return gate.response

    const { text } = await req.json()
    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Text required' }, { status: 400 })
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'AI not configured' }, { status: 503 })
    }

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
    })
    const out = response.content[0].type === 'text' ? response.content[0].text : ''
    return NextResponse.json({ text: out })
  } catch (error) {
    console.error('Polish error:', error)
    return NextResponse.json({ error: 'Failed to polish text' }, { status: 500 })
  }
}
