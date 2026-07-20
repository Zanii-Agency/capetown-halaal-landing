import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/vendor-doc?path=<vendor-docs-relative-path>
// Streams the bytes of any object in the vendor-docs bucket back through this
// same-origin route so the admin doc-preview iframe (DocumentsClient drawer,
// Vendor360 preview) can render it inline. We sign a short-lived URL over the
// storage path, fetch it server-side, and pipe the bytes. We do NOT redirect:
// a 302 to the cross-origin Supabase host makes the iframe load a cross-origin
// page that Chrome blocks ("This page has been blocked"). Admin-only.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const path = (req.nextUrl.searchParams.get('path') || '').trim()
  if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 })
  // Defensive: reject path traversal attempts.
  if (path.includes('..') || path.startsWith('/')) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 })
  }

  const { data, error } = await admin.storage.from('vendor-docs').createSignedUrl(path, 300)
  if (error || !data?.signedUrl) return NextResponse.json({ error: 'Could not generate link' }, { status: 500 })

  const upstream = await fetch(data.signedUrl)
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'Could not fetch document' }, { status: 502 })
  }
  const upstreamType = upstream.headers.get('content-type') || 'application/octet-stream'
  const filename = (path.split('/').pop() || 'document').replace(/[^a-zA-Z0-9._-]/g, '_')

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstreamType,
      'Content-Disposition': `inline; filename="${filename}"`,
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': 'private, max-age=60',
    },
  })
}
