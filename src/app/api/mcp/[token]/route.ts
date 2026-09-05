/**
 * POST /api/mcp/<token>  — a remote MCP server (Streamable HTTP, stateless JSON)
 * for claude.ai / Claude Desktop / Cowork "custom connectors".
 *
 * The token names ONE admin_users row (see @/lib/admin-actor). Every tool call
 * runs the EXISTING admin route handler under that actor, so RBAC and the
 * master-lane / EFT wall apply exactly as they do to that person's browser
 * session. Nothing here re-implements a wall, and no /api/admin/eft* route is
 * reachable: the tool table below is the whole surface.
 *
 * zanii-codef: hand-rolled JSON-RPC (initialize / tools/list / tools/call /
 * ping). No sessions, no SSE, no batching. Swap for mcp-handler if a client
 * ever needs resumable streams.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runWithActor, verifyAdminApiToken, type AdminActor } from '@/lib/admin-actor'

import { GET as inboxList } from '@/app/api/admin/inbox/unified/route'
import { GET as inboxMessages } from '@/app/api/admin/inbox/unified/messages/route'
import { POST as inboxReply } from '@/app/api/admin/inbox/unified/reply/route'
import { POST as inboxStatus } from '@/app/api/admin/inbox/unified/status/route'
import { GET as search } from '@/app/api/admin/search/route'
import { GET as applicationsList } from '@/app/api/admin/applications/route'
import { GET as vendorFull } from '@/app/api/admin/vendors/[id]/full/route'
import { GET as supportThreads } from '@/app/api/admin/support/route'
import { POST as supportReply } from '@/app/api/admin/support/[id]/reply/route'
import { POST as chase } from '@/app/api/admin/chase/route'
import { GET as stats } from '@/app/api/admin/stats/route'
import { GET as finance } from '@/app/api/admin/finance/route'
import { POST as eftProofConfirm } from '@/app/api/admin/eft-proofs/confirm/route'
import { loadPaidVendors } from '@/lib/payments/paid-vendors'
import { loadEftProofs } from '@/lib/payments/eft-proofs-list'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Json = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>

function req(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, unknown> }): NextRequest {
  const url = new URL(path, 'http://mcp.internal')
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

async function call(handler: Handler, request: NextRequest, params: Record<string, string> = {}) {
  const res = await handler(request, { params: Promise.resolve(params) })
  const text = await res.text()
  let data: unknown = text
  try { data = JSON.parse(text) } catch { /* non-JSON body stays a string */ }
  return { status: res.status, data }
}

const str = (d = '') => ({ type: 'string', description: d })
const int = (d = '') => ({ type: 'integer', description: d })

// name -> { description, inputSchema, run }. The whole reachable surface.
const TOOLS: Record<string, { description: string; inputSchema: Json; run: (a: Json) => Promise<{ status: number; data: unknown }> }> = {
  inbox_list: {
    description: 'List inbox conversations (WhatsApp + email) with unread counts. Filter by channel or search text. Returns the newest first.',
    inputSchema: { type: 'object', properties: { channel: { type: 'string', enum: ['all', 'whatsapp', 'email'] }, q: str('search text: name, business, phone, email'), limit: int('max conversations, default 50') } },
    run: async (a) => {
      const r = await call(inboxList, req('/api/admin/inbox/unified', { query: { channel: a.channel, q: a.q } }))
      if (r.status === 200 && r.data && typeof r.data === 'object' && Array.isArray((r.data as Json).contacts)) {
        const d = r.data as Json
        const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500)
        return { status: 200, data: { ...d, contacts: (d.contacts as unknown[]).slice(0, limit) } }
      }
      return r
    },
  },
  inbox_messages: {
    description: 'Read one conversation. Give the phone (WhatsApp) or email address from inbox_list. Use `before` (ISO date) to page back.',
    inputSchema: { type: 'object', properties: { phone: str(), email: str(), before: str('ISO timestamp') } },
    run: (a) => call(inboxMessages, req('/api/admin/inbox/unified/messages', { query: { phone: a.phone, email: a.email, before: a.before } })),
  },
  inbox_reply: {
    description: 'Send a reply in a conversation. channel=whatsapp needs phone; channel=email needs email (subject optional). Sends immediately, so confirm the wording with the operator first.',
    inputSchema: { type: 'object', required: ['channel', 'text'], properties: { channel: { type: 'string', enum: ['whatsapp', 'email'] }, phone: str(), email: str(), subject: str(), text: str('message body, max 4000 chars') } },
    run: (a) => call(inboxReply, req('/api/admin/inbox/unified/reply', { method: 'POST', body: { channel: a.channel, phone: a.phone, email: a.email, subject: a.subject, text: a.text, mode: 'text' } })),
  },
  inbox_status: {
    description: 'Mark a conversation read/unread, done/reopen, snooze, or tag. Identify it by phone, email or applicationId.',
    inputSchema: { type: 'object', required: ['action'], properties: { action: str('read | unread | done | reopen | snooze | tag | assign'), phone: str(), email: str(), applicationId: str('vendor application uuid'), snoozeUntil: str('ISO datetime'), tag: str() } },
    run: (a) => call(inboxStatus, req('/api/admin/inbox/unified/status', { method: 'POST', body: a })),
  },
  search: {
    description: 'Find vendors, buyers and threads by name, business, phone or email (min 2 chars). Returns ids to use with other tools.',
    inputSchema: { type: 'object', required: ['q'], properties: { q: str() } },
    run: (a) => call(search, req('/api/admin/search', { query: { q: a.q } })),
  },
  applications_list: {
    description: 'List vendor applications. status: pending | approved | rejected | all. Supports search, sector, tier, order (oldest | newest | completeness), limit/offset.',
    inputSchema: { type: 'object', properties: { status: str('default pending'), search: str(), sector: str(), tier: str(), order: str(), limit: int('default 50'), offset: int() } },
    run: (a) => call(applicationsList, req('/api/admin/applications', { query: { status: a.status, search: a.search, sector: a.sector, tier: a.tier, order: a.order, limit: a.limit ?? 50, offset: a.offset } })),
  },
  vendor_full: {
    description: 'Everything about one vendor application: details, stall, documents, portal state incl. payment (status, amount, method, paid_at, proofs), messages, audit events. Needs the application id (from search or applications_list).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str('vendor application uuid') } },
    run: (a) => call(vendorFull, req(`/api/admin/vendors/${a.id}/full`), { id: String(a.id) }),
  },
  support_threads: {
    description: 'List vendor portal support threads (questions vendors asked from inside their portal).',
    inputSchema: { type: 'object', properties: {} },
    run: () => call(supportThreads, req('/api/admin/support')),
  },
  support_reply: {
    description: 'Reply to a vendor portal support thread. id = the vendor application id. Sends immediately.',
    inputSchema: { type: 'object', required: ['id', 'body'], properties: { id: str('vendor application uuid'), body: str('reply text, max 2000 chars') } },
    run: (a) => call(supportReply, req(`/api/admin/support/${a.id}/reply`, { method: 'POST', body: { body: a.body } }), { id: String(a.id) }),
  },
  followup_send: {
    description: 'Send a follow-up to one or many vendors by WhatsApp and/or email. ALWAYS run with dry_run=true first and show the operator the preview; only then send with dry_run=false. recipients come from applications_list (id, name, business_name, email, phone). Provide wa_body and/or email_subject+email_body, or a template_key.',
    inputSchema: { type: 'object', required: ['recipients'], properties: { recipients: { type: 'array', items: { type: 'object', properties: { id: str(), name: str(), business_name: str(), email: str(), phone: str(), stall: str() } } }, channel: { type: 'string', enum: ['wa', 'mail', 'both'] }, wa_body: str(), email_subject: str(), email_body: str(), template_key: str(), dry_run: { type: 'boolean', description: 'default true' } } },
    run: (a) => call(chase, req('/api/admin/chase', { method: 'POST', body: { ...a, dry_run: a.dry_run !== false } })),
  },
  stats: {
    description: 'Dashboard numbers: tickets sold, vendor revenue, active applications, page views.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call(stats, req('/api/admin/stats')),
  },
  finance_summary: {
    description: 'The Finance page: per-vendor payment status (paid | pending | deferred | none), amounts, due dates, overdue flags, and headline totals (paid count, pending, overdue, revenue). Headline revenue counts card (Yoco) settled money; use paid_vendors for the roster that also lists EFT confirmations and proofs. Optional payment filter (paid | unpaid).',
    inputSchema: { type: 'object', properties: { payment: str('paid | unpaid') } },
    run: (a) => call(finance, req('/api/admin/finance', { query: { payment: a.payment } })),
  },
  paid_vendors: {
    description: 'The Paid Vendors page: every vendor with money in, with payState = Paid (settled by card or confirmed EFT) | EFT received | Proof pending (vendor uploaded an EFT proof, waiting for the operator to confirm). Per row: method, paidOn, stall price, accessories total/owing/state, totalPaid. Totals: paidTotal (confirmed money only) and accOwingTotal. Use this for "who has paid", "what does X still owe", "how much have we collected".',
    inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['all', 'confirmed', 'pending'], description: 'default all' }, q: str('filter by vendor or contact name') } },
    run: async (a) => {
      const d = await loadPaidVendors()
      const q = String(a.q ?? '').trim().toLowerCase()
      let rows = a.state === 'confirmed' ? d.confirmedRows : a.state === 'pending' ? d.pendingRows : d.rows
      if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.contact ?? '').toLowerCase().includes(q))
      return { status: 200, data: { rows, counts: { paid: d.confirmedRows.length, proofPending: d.pendingRows.length }, paidTotal: d.paidTotal, accOwingTotal: d.accOwingTotal } }
    },
  },
  eft_proofs: {
    description: 'The EFT Proofs page: vendors who uploaded proof of an EFT payment, newest first. Per row: reference (as printed on the proof itself, null when the proof shows none), expectedReference (the one we asked the vendor to use), amount, uploadedAt (when the vendor sent the proof), paid (true once confirmed), proofUrl (opens the uploaded proof, valid 1 hour), note. Totals: totalAmount and paidAmount. Use before confirming a proof.',
    inputSchema: { type: 'object', properties: { unconfirmed_only: { type: 'boolean', description: 'default false' } } },
    run: async (a) => {
      const d = await loadEftProofs()
      const rows = a.unconfirmed_only ? d.rows.filter((r) => !r.paid) : d.rows
      return { status: 200, data: { eftActive: d.ownerEftActive, rows, totalAmount: d.totalAmount, paidAmount: d.paidAmount } }
    },
  },
  eft_proof_confirm: {
    description: 'Confirm an EFT proof: marks the vendor PAID and sends them the payment-received message. Irreversible. Before calling: show the operator the vendor name, reference and amount from eft_proofs and get an explicit yes for THAT vendor. Never call it for a vendor whose proof the operator has not seen.',
    inputSchema: { type: 'object', required: ['applicationId'], properties: { applicationId: str('vendor application uuid from eft_proofs') } },
    run: (a) => call(eftProofConfirm, req('/api/admin/eft-proofs/confirm', { method: 'POST', body: { applicationId: a.applicationId } })),
  },
}

async function actorForToken(token: string): Promise<AdminActor | null> {
  const userId = verifyAdminApiToken(token)
  if (!userId) return null
  const { data } = await createAdminClient().from('admin_users').select('id, email, role').eq('id', userId).maybeSingle()
  if (!data) return null
  const role = (data as { role?: string }).role
  return { id: data.id as string, email: ((data as { email?: string | null }).email ?? '').toLowerCase() || null, role: role === 'owner' || role === 'operator' ? role : 'viewer' }
}

const rpc = (id: unknown, body: Json) => NextResponse.json({ jsonrpc: '2.0', id: id ?? null, ...body })
const rpcError = (id: unknown, code: number, message: string, status = 200) =>
  NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status })

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const actor = await actorForToken(token)
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let msg: Json
  try { msg = (await request.json()) as Json } catch { return rpcError(null, -32700, 'parse error', 400) }
  if (Array.isArray(msg)) return rpcError(null, -32600, 'batch requests not supported', 400)

  const { id, method, params: p } = msg as { id?: unknown; method?: string; params?: Json }
  if (typeof method !== 'string') return rpcError(id, -32600, 'invalid request', 400)

  // Notifications carry no id and expect no body.
  if (method.startsWith('notifications/')) return new NextResponse(null, { status: 202 })

  switch (method) {
    case 'initialize':
      return rpc(id, { result: { protocolVersion: (p?.protocolVersion as string) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cth-festival-ops', version: '1.0.0' }, instructions: `You are connected to the Young at Heart Festival admin portal as ${actor.email}. Before any tool that sends a message (inbox_reply, support_reply, followup_send), show the exact text to the operator and get a yes. followup_send must be previewed with dry_run=true first. eft_proof_confirm marks a vendor paid: show name, reference and amount first and get a yes for that vendor. Payment vocabulary: Paid = money settled (card via Yoco, or an EFT the operator confirmed); Proof pending = the vendor uploaded an EFT proof that still needs confirming; none = nothing received; pending/deferred = agreed to pay later. The Finance page headline counts card settlements; the Paid Vendors page is the full roster of money in. Amounts are in South African Rand.` } })
    case 'ping':
      return rpc(id, { result: {} })
    case 'tools/list':
      return rpc(id, { result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } })
    case 'tools/call': {
      const name = String(p?.name ?? '')
      const tool = TOOLS[name]
      if (!tool) return rpc(id, { result: { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] } })
      const args = (p?.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Json
      try {
        const r = await runWithActor(actor, () => tool.run(args))
        console.log(`[mcp] ${actor.email} ${name} -> ${r.status}`)
        return rpc(id, { result: { isError: r.status >= 400, content: [{ type: 'text', text: JSON.stringify(r.data) }] } })
      } catch (e) {
        console.error(`[mcp] ${actor.email} ${name} threw`, e)
        return rpc(id, { result: { isError: true, content: [{ type: 'text', text: 'tool failed' }] } })
      }
    }
    default:
      return rpcError(id, -32601, 'method not found')
  }
}

// Stateless server: no SSE stream to open, no session to delete.
export function GET() { return new NextResponse(null, { status: 405 }) }
export function DELETE() { return new NextResponse(null, { status: 405 }) }
