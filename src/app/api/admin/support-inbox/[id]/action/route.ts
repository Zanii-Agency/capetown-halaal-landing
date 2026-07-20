/**
 * POST /api/admin/support-inbox/[id]/action
 *
 * Header tools: assign · tag · snooze · resolve · reopen · link-vendor · link-ticket.
 * Body shape:
 *   { action: 'assign',        assigneeId: string | null }
 *   { action: 'tag',           tag: 'payment' | 'load-in' | 'badges' | 'contract' | 'refund' | 'general' | null }
 *   { action: 'snooze',        snoozeHours: number } // 4 = 4h, 24 = 1d, 0 = next-morning
 *   { action: 'resolve' }
 *   { action: 'reopen' }
 *   { action: 'link_vendor',   vendorApplicationId: string | null }
 *   { action: 'link_ticket',   ticketBuyerEmail: string | null }
 *
 * Returns the updated row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ALLOWED_TAGS = new Set(['payment', 'load-in', 'badges', 'contract', 'refund', 'general'])

interface ActionBody {
  action: 'assign' | 'tag' | 'snooze' | 'resolve' | 'reopen' | 'link_vendor' | 'link_ticket'
  assigneeId?: string | null
  tag?: string | null
  snoozeHours?: number
  vendorApplicationId?: string | null
  ticketBuyerEmail?: string | null
}

function nextMorningIso(): string {
  const now = new Date()
  const next = new Date(now)
  next.setHours(8, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next.toISOString()
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  const db = createAdminClient()

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'thread id required' }, { status: 400 })

  let body: ActionBody
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }

  const update: Record<string, unknown> = {}
  switch (body.action) {
    case 'assign':
      update.assignee_id = body.assigneeId || null
      break
    case 'tag': {
      const t = body.tag
      if (t !== null && t !== undefined && !ALLOWED_TAGS.has(t)) {
        return NextResponse.json({ error: `tag must be one of ${[...ALLOWED_TAGS].join(',')} or null` }, { status: 400 })
      }
      update.tag = t || null
      break
    }
    case 'snooze': {
      const hours = Number(body.snoozeHours)
      update.status = 'snoozed'
      if (hours === 0 || Number.isNaN(hours)) update.snoozed_until = nextMorningIso()
      else update.snoozed_until = new Date(Date.now() + hours * 3600 * 1000).toISOString()
      break
    }
    case 'resolve':
      update.status = 'resolved'
      update.last_handled_at = new Date().toISOString()
      update.unread_count = 0
      break
    case 'reopen':
      update.status = 'open'
      update.snoozed_until = null
      break
    case 'link_vendor':
      update.vendor_application_id = body.vendorApplicationId || null
      break
    case 'link_ticket':
      update.ticket_buyer_id = body.ticketBuyerEmail || null
      break
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  const { data, error } = await db
    .from('support_inbox_threads')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, thread: data })
}
