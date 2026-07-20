import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, requireOperator } from '@/lib/admin-rbac'

// Multi-tool inbox actions: snooze · assign-to-me · mark-done · reopen.
// Touches wa_threads (the unified inbox spine from migration v11).
// Per Taona Message 12: "multiple tools required" on the inbox surface.

interface ActionBody {
  threadKey: string                      // E.164 phone for wa, lower-cased email for mail
  channel: 'wa' | 'mail'
  action: 'snooze' | 'assign_me' | 'done' | 'reopen' | 'unassign' | 'tag' | 'link_vendor' | 'link_ticket'
  snoozeHours?: number                   // only used when action === 'snooze'
  tag?: 'payment' | 'load-in' | 'badges' | 'contract' | 'refund' | 'general' | null
  vendorApplicationId?: string | null
  ticketBuyerEmail?: string | null
}

const ALLOWED_TAGS = new Set(['payment', 'load-in', 'badges', 'contract', 'refund', 'general'])

export async function POST(req: Request) {
  // Mutates wa_threads (status, assignee, tags, links). Owner/operator only.
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const userId = gate.user.id

  let body: ActionBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { threadKey, channel, action, snoozeHours } = body
  if (!threadKey || !channel || !action) {
    return NextResponse.json({ error: 'threadKey, channel, action required' }, { status: 400 })
  }
  if (!['wa', 'mail'].includes(channel)) {
    return NextResponse.json({ error: 'channel must be wa or mail' }, { status: 400 })
  }

  const admin = createAdminClient()

  const update: Record<string, unknown> = {}
  switch (action) {
    case 'snooze': {
      const hours = Number(snoozeHours) > 0 ? Number(snoozeHours) : 4
      update.status = 'snoozed'
      update.snoozed_until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
      break
    }
    case 'assign_me':
      update.assignee_id = userId
      break
    case 'unassign':
      update.assignee_id = null
      break
    case 'done':
      update.status = 'done'
      update.last_handled_at = new Date().toISOString()
      break
    case 'reopen':
      update.status = 'open'
      update.snoozed_until = null
      break
    case 'tag': {
      const t = body.tag
      if (t !== null && t !== undefined && !ALLOWED_TAGS.has(t)) {
        return NextResponse.json({ error: `tag must be one of ${[...ALLOWED_TAGS].join(',')} or null` }, { status: 400 })
      }
      update.tag = t || null
      break
    }
    case 'link_vendor':
      update.vendor_application_id = body.vendorApplicationId || null
      break
    case 'link_ticket':
      update.ticket_buyer_email = body.ticketBuyerEmail || null
      break
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  // Upsert to handle threads that haven't been touched by the trigger yet.
  const { data, error } = await admin
    .from('wa_threads')
    .upsert(
      { channel, thread_key: threadKey, ...update },
      { onConflict: 'channel,thread_key' }
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, thread: data })
}

export async function GET(req: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const channel = url.searchParams.get('channel') || 'wa'
  const threadKey = url.searchParams.get('threadKey') || ''
  if (!threadKey) return NextResponse.json({ thread: null })

  const admin = createAdminClient()
  const { data } = await admin
    .from('wa_threads')
    .select('*')
    .eq('channel', channel)
    .eq('thread_key', threadKey)
    .maybeSingle()
  return NextResponse.json({ thread: data ?? null })
}
