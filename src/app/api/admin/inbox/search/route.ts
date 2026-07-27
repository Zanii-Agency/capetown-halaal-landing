/**
 * Server-side ILIKE search across wa_messages.body, support_inbox_messages.body_text, and
 * vendor_applications.business_name. Returns up to 30 matching threads.
 *
 * GET /api/admin/inbox/search?q=...
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveContact } from '@/lib/contacts/resolve'
import { hidesEftContent, laneScopeFor } from '@/lib/inbox-lane'
import { mentionsEft } from '@/lib/eft'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface Hit {
  thread_id: string
  channel: 'wa' | 'mail'
  thread_key: string
  displayName: string
  snippet: string
  matched_in: 'message' | 'business'
}

// Returns the viewer's email, not just a boolean: the EFT lane filter below needs
// to know WHO is searching (only the EFT admin sees lane vendors' messages).
async function requireAdmin(): Promise<{ ok: boolean; email: string | null }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, email: null }
  const admin = createAdminClient()
  const { data } = await admin
    .from('admin_users')
    .select('id')
    .eq('id', user.id)
    .limit(1)
  return { ok: !!(data && data.length > 0), email: user.email ?? null }
}

function snippet(text: string, q: string): string {
  if (!text) return ''
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text.slice(0, 120)
  const start = Math.max(0, idx - 40)
  const end = Math.min(text.length, idx + q.length + 80)
  return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '')
}

export async function GET(req: Request) {
  const viewer = await requireAdmin()
  if (!viewer.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const q = (url.searchParams.get('q') || '').trim()
  if (q.length < 2) {
    return NextResponse.json({ hits: [] })
  }

  const supabase = createAdminClient()
  const like = `%${q}%`
  const hits: Hit[] = []
  const seen = new Set<string>()
  // TWO layers (2026-07-26): a hit belonging to a vendor the owner does not own
  // is dropped, and so is any hit whose body talks about EFT.
  const scope = await laneScopeFor(viewer.email)
  const hide = hidesEftContent(viewer.email)

  // wa_messages — upstream schema has no thread_id; we group by wa_phone
  // and look up the wa_threads row by (channel='wa', thread_key=wa_phone).
  try {
    const { data } = (await supabase
      .from('wa_messages')
      .select('id, body, wa_phone, created_at')
      .ilike('body', like)
      .order('created_at', { ascending: false })
      .limit(20)) as unknown as {
      data: Array<{ id: string; body: string; wa_phone: string; created_at: string }> | null
    }
    for (const row of data ?? []) {
      if (scope.blocksPhone(row.wa_phone) || (hide && mentionsEft(row.body))) continue
      const tk = `wa:${row.wa_phone}`
      if (seen.has(tk)) continue
      const { data: thread } = (await supabase
        .from('wa_threads')
        .select('id')
        .eq('channel', 'wa')
        .eq('thread_key', row.wa_phone)
        .limit(1)) as unknown as { data: Array<{ id: string }> | null }
      if (!thread || thread.length === 0) continue
      seen.add(tk)
      const resolved = await resolveContact({ waPhone: row.wa_phone, supabase })
      hits.push({
        thread_id: thread[0].id,
        channel: 'wa',
        thread_key: row.wa_phone,
        displayName: resolved.displayName,
        snippet: snippet(row.body, q),
        matched_in: 'message',
      })
    }
  } catch {
    /* wa_messages may not exist yet */
  }

  // support_inbox_messages.
  //
  // This read `mail_messages`, which holds ZERO rows on this project: the live
  // email tables are support_inbox_threads / support_inbox_messages. So email
  // bodies were never searchable by anything, and the silent catch below meant
  // it never once complained. (The endpoint was also orphaned, with no caller in
  // either inbox, so nobody found out.)
  try {
    const { data } = (await supabase
      .from('support_inbox_messages')
      .select('thread_id, body_text, from_address, subject')
      .ilike('body_text', like)
      .order('created_at', { ascending: false })
      .limit(20)) as unknown as {
      data: Array<{
        thread_id: string
        body_text: string
        from_address: string
        subject: string
      }> | null
    }
    for (const raw of data ?? []) {
      const row = { ...raw, body: raw.body_text || '' }
      if (scope.blocksEmail(row.from_address) || (hide && (mentionsEft(row.body) || mentionsEft(row.subject)))) continue
      if (!row.thread_id || seen.has(`mail:${row.thread_id}`)) continue
      seen.add(`mail:${row.thread_id}`)
      const resolved = await resolveContact({ email: row.from_address, supabase })
      hits.push({
        thread_id: row.thread_id,
        channel: 'mail',
        thread_key: row.from_address,
        displayName: resolved.displayName,
        snippet: row.subject || snippet(row.body, q),
        matched_in: 'message',
      })
    }
  } catch (e) {
    // Loud now. A silent catch is exactly how a search against an empty table
    // went unnoticed.
    console.error('[inbox/search] email search failed:', (e as Error).message)
  }

  // vendor_applications.business_name
  try {
    const { data } = (await supabase
      .from('vendor_applications')
      .select('id, business_name, email, phone')
      .ilike('business_name', like)
      .limit(10)) as unknown as {
      data: Array<{ id: string; business_name: string; email: string; phone: string }> | null
    }
    for (const row of data ?? []) {
      if (scope.blocks({ applicationId: row.id, email: row.email, phone: row.phone })) continue
      // Try wa first, then mail
      const channels: Array<{ channel: 'wa' | 'mail'; key: string }> = []
      if (row.phone) channels.push({ channel: 'wa', key: row.phone })
      if (row.email) channels.push({ channel: 'mail', key: row.email.toLowerCase() })
      for (const c of channels) {
        const tk = `${c.channel}:${c.key}`
        if (seen.has(tk)) continue
        // Look up thread id
        const { data: thread } = (await supabase
          .from('wa_threads')
          .select('id')
          .eq('channel', c.channel)
          .eq('thread_key', c.key)
          .limit(1)) as unknown as { data: Array<{ id: string }> | null }
        if (!thread || thread.length === 0) continue
        seen.add(tk)
        hits.push({
          thread_id: thread[0].id,
          channel: c.channel,
          thread_key: c.key,
          displayName: row.business_name,
          snippet: row.business_name,
          matched_in: 'business',
        })
      }
    }
  } catch {
    /* swallow */
  }

  return NextResponse.json({ hits: hits.slice(0, 30) })
}
