// MASTER brain: Taona's operations assistant over WhatsApp.
//
// Runs ONLY for the master role (his own number). It answers his free-form
// questions about vendors and the pipeline using the master tool registry, which
// reads across all vendors. The authorization wall is executeMasterTool (it
// refuses any non-master caller), NOT this prompt. READ + DRAFT ONLY: the brain
// can look things up and write a suggested reply in its text, but it has no tool
// that sends a message to a vendor or mutates data, so it can never fire a send
// or a payment. Sending stays on Taona's explicit SEND / swipe path.

import Anthropic from '@anthropic-ai/sdk'
import type { BotAdmin } from '@/lib/bot/admins'
import { MASTER_TOOL_DEFS, executeMasterTool } from '@/lib/bot/tools/master-registry'

const MODEL = process.env.CTH_AGENT_MODEL || 'claude-sonnet-5'
const MAX_TOOL_ROUNDS = 5

// Default ON: this brain is read-only and master-gated, so it ships live behind a
// kill switch rather than a soak gate. Set CTH_MASTER_BRAIN=off to disable.
export function masterBrainEnabled(): boolean {
  const v = (process.env.CTH_MASTER_BRAIN || '').toLowerCase()
  return v !== 'off' && v !== '0' && v !== 'false'
}

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null

function systemPrompt(admin: BotAdmin): string {
  const first = admin.name.split(/\s+/)[0]
  return [
    `You are the operations assistant for ${first}, the organiser of the Young at Heart Festival (Cape Town Halaal) 2026. You are talking to ${first} himself over WhatsApp, so you may look up ANY vendor's details and the whole pipeline with your tools and answer him directly and completely. He runs the festival, nothing is hidden from him.`,
    '',
    'HOW YOU WORK:',
    '- Use find_vendors for any question about a specific vendor or a few of them (is X approved, what does Y owe, has Z paid, find the Turkish stall). Use pipeline_numbers for counts and summaries. Use vendor_conversation before you draft a reply to a vendor, so the draft fits what was actually said.',
    '- Use eft_lane_activity whenever he asks who OPENED or revealed the bank details, who is about to pay, who uploaded a proof, or what is happening on the EFT / Master lane. That tool has the reveal and proof timestamps, so if he asks who opened them recently or last night, call it and read the times, do not say you cannot track opens.',
    '- Answer the specific thing he asked, briefly. This is WhatsApp: 1 to 5 short sentences or a tight list, not an essay. Lead with the answer, then the detail he needs.',
    '- Never invent a number, price, status, or date. If a tool did not give it to you, say you do not have it and offer to check.',
    '',
    'DRAFTING REPLIES:',
    `- When ${first} asks you to reply to a vendor or "tell them" something, WRITE the draft reply for him to read, prefixed with "Draft:". Do NOT claim you sent it. You cannot send to a vendor yourself. After the draft, tell him to reply SEND (or swipe-reply on the vendor's card) to actually send it.`,
    '- Match the warm, respectful tone the festival uses with its mostly Cape Muslim vendors (Wa alaikum assalam, jazakallah) when you draft a vendor-facing reply.',
    '',
    'STYLE: Never use a long dash (em dash or en dash) as a sentence break. Use commas, periods, or colons instead. Be a calm, sharp operator who gets him the answer fast.',
  ].join('\n')
}

export interface MasterAgentResult { message: string; toolsUsed: string[] }

/**
 * Run the master tool-calling loop for one inbound message from Taona. Returns
 * the final text. Returns null when disabled or no LLM client, so the caller
 * falls back to the existing canned admin reply.
 */
export async function runMasterAgent(
  admin: BotAdmin,
  message: string,
  ctx: { history?: Array<{ role: 'user' | 'assistant'; content: string }> } = {},
): Promise<MasterAgentResult | null> {
  if (!masterBrainEnabled() || !client) return null
  if (admin.role !== 'master') return null // belt-and-suspenders; the tool wall also checks

  const toolsUsed: string[] = []
  const messages: Anthropic.MessageParam[] = [
    ...(ctx.history ?? []).slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: message },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      thinking: { type: 'disabled' },
      system: systemPrompt(admin),
      tools: MASTER_TOOL_DEFS as unknown as Anthropic.Tool[],
      messages,
    })

    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('').trim()
      return { message: text || 'Say that another way and I will pull it up.', toolsUsed }
    }

    messages.push({ role: 'assistant', content: res.content })
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue
      const outcome = await executeMasterTool(admin.role, block.name, block.input)
      toolsUsed.push(block.name)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return { message: 'That took a few steps. Ask me again in a simpler way and I will get it.', toolsUsed }
}
