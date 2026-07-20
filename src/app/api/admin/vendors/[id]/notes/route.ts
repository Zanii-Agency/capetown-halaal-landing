import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalStateImpl, type PortalState } from '@/lib/portal-state'
import { requireOperator } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface QuickNote {
  id: string
  text: string
  created_at: string
  author: string | null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = createAdminClient()
    const { data: adminUser } = await admin
      .from('admin_users')
      .select('id')
      .eq('id', user.id)
      .single()
    if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: app } = await admin
      .from('vendor_applications')
      .select('admin_notes')
      .eq('id', id)
      .single()

    const portal = parsePortalState((app as { admin_notes?: string | null })?.admin_notes || '')
    const notes: QuickNote[] = (portal.quickNotes ?? []).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    return NextResponse.json({ notes })
  } catch (err) {
    console.error('[admin/notes GET] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
    }

    const gate = await requireOperator()
    if (!gate.ok) return gate.response
    const { adminUser } = gate

    const admin = createAdminClient()

    const body = await req.json()
    const text = (body.text as string ?? '').trim()
    if (!text) {
      return NextResponse.json({ error: 'Note text is required' }, { status: 400 })
    }
    if (text.length > 5000) {
      return NextResponse.json({ error: 'Note exceeds 5000 characters' }, { status: 400 })
    }

    const author = adminUser.email

    // Read current portal state, append note
    const { data: app } = await admin
      .from('vendor_applications')
      .select('admin_notes')
      .eq('id', id)
      .single()
    if (!app) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    const notesRaw = (app as { admin_notes?: string | null })?.admin_notes || ''
    const portal = parsePortalState(notesRaw)

    const newNote: QuickNote = {
      id: crypto.randomUUID(),
      text,
      created_at: new Date().toISOString(),
      author,
    }

    portal.quickNotes = [...(portal.quickNotes ?? []), newNote]
    const updatedNotes = updatePortalStateImpl(notesRaw, portal as PortalState)

    const { error: updErr } = await admin
      .from('vendor_applications')
      .update({ admin_notes: updatedNotes })
      .eq('id', id)
    if (updErr) {
      console.error('[admin/notes POST] update error:', updErr.message)
      return NextResponse.json({ error: 'Failed to save note' }, { status: 500 })
    }

    return NextResponse.json({ note: newNote })
  } catch (err) {
    console.error('[admin/notes POST] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
