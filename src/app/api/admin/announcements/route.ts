import { NextRequest, NextResponse } from 'next/server'
import { listAnnouncements, addAnnouncement } from '@/lib/announcements'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { requireOperator } from '@/lib/admin-rbac'

async function isAuthorized(request: NextRequest): Promise<boolean> {
  // Cron branch (CRON_SECRET bearer) left untouched: machine-to-machine posts.
  // Header-only Bearer (constant-time). `?secret=` query branch removed
  // because it leaks into access logs / browser history / referrers.
  if (verifyCronAuth(request.headers.get('authorization'))) return true
  // Admin branch: posting an announcement is a write, so role-gate to
  // owner/operator (was membership-only).
  const gate = await requireOperator()
  return gate.ok
}

export async function GET() {
  return NextResponse.json({ announcements: await listAnnouncements() })
}

// POST { title, body, pinned } — admin posts a festival-wide announcement.
export async function POST(request: NextRequest) {
  if (!(await isAuthorized(request))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  if (!body.title || !body.body) return NextResponse.json({ error: 'title and body required' }, { status: 400 })
  const item = await addAnnouncement({ title: String(body.title), body: String(body.body), pinned: !!body.pinned, created_by: 'organisers' })
  return NextResponse.json({ success: true, announcement: item })
}
