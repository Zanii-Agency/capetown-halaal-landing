// Unified inbox internal notes — private operator notes on a conversation.
// Stored as a ⟦INBOXNOTE:base64(json)⟧ marker on vendor_applications.admin_notes
// (no notes table, DDL blocked, Law 8), preserving the other markers (PORTAL,
// STALL, APPROVED_NOTIFIED). Vendor contacts only — that's the row we can write.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertRole } from '@/lib/admin-rbac'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOTE_RE = /⟦INBOXNOTE:([A-Za-z0-9+/=]+)⟧/

interface Note { at: string; by: string; text: string }

function readNotes(adminNotes: string | null): Note[] {
  const m = (adminNotes || '').match(NOTE_RE)
  if (!m) return []
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as Note[] } catch { return [] }
}
function writeNotes(adminNotes: string | null, notes: Note[]): string {
  const rest = (adminNotes || '').replace(NOTE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
  const marker = '⟦INBOXNOTE:' + Buffer.from(JSON.stringify(notes)).toString('base64') + '⟧'
  return rest ? `${rest}\n${marker}` : marker
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const applicationId = new URL(req.url).searchParams.get('applicationId')
  if (!applicationId) return NextResponse.json({ notes: [], supported: false })
  const { data } = await db.from('vendor_applications').select('admin_notes').eq('id', applicationId).maybeSingle()
  return NextResponse.json({ notes: readNotes(data?.admin_notes ?? null), supported: true })
}

const postSchema = z.object({ applicationId: z.string().uuid(), text: z.string().min(1).max(2000) })

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, email').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Role gate: writing an internal note mutates the application — owner/operator only.
  try {
    await assertRole(user.id, ['owner', 'operator'])
  } catch {
    return NextResponse.json({ error: 'insufficient_role' }, { status: 403 })
  }

  let body: z.infer<typeof postSchema>
  try {
    body = postSchema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    throw e
  }

  const { data: app } = await db.from('vendor_applications').select('admin_notes').eq('id', body.applicationId).maybeSingle()
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const notes = readNotes(app.admin_notes ?? null)
  notes.push({ at: new Date().toISOString(), by: adminUser.email, text: body.text.trim() })
  const next = writeNotes(app.admin_notes ?? null, notes.slice(-50))
  const { error } = await db.from('vendor_applications').update({ admin_notes: next }).eq('id', body.applicationId)
  if (error) return NextResponse.json({ ok: false, message: 'Could not save note.' }, { status: 502 })
  return NextResponse.json({ ok: true, notes })
}
