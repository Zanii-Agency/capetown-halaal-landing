// Admin-gated media proxy for the unified inbox. Incoming WhatsApp media is
// stored as a Meta media id on wa_messages.metadata.media.id (the wamid CANNOT
// retrieve bytes). The browser can't call the Graph API directly (it needs the
// server-only WHATSAPP_TOKEN and the bytes are token-gated), so we proxy:
//   1. Look up the wa_messages row by its DB id, read metadata.media.id.
//   2. Ask Graph for the short-lived media URL, then fetch the bytes with the
//      bearer token, and stream them back same-origin so an <img src> works.
// Gated to admin_users only so vendor media never leaks to the public.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseAttachmentMarker, EMAIL_ATTACHMENTS_BUCKET } from '@/lib/email/attachments'
import { hidesEftContent, laneScopeFor } from '@/lib/inbox-lane'
import { mentionsEft } from '@/lib/eft'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const GRAPH = 'https://graph.facebook.com/v21.0'
const WA_TOKEN = process.env.WHATSAPP_TOKEN || ''

interface MediaMeta { id?: string; mime_type?: string; filename?: string; caption?: string; storage_path?: string }

const WA_MEDIA_BUCKET = 'vendor-docs'

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params

  // ---- admin gate ----
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Email attachment: id is "mail:<support_inbox_messages row id>:<index>" —
  // a real email can carry several attachments, so the row id alone isn't
  // enough to pick one. Attachment metadata lives in the body_text marker
  // (no JSONB column on this table, DDL blocked — see attachments.ts).
  const mailMatch = id.match(/^mail:([^:]+):(\d+)$/)
  if (mailMatch) {
    const [, mailRowId, indexStr] = mailMatch
    const { data: row } = await db
      .from('support_inbox_messages')
      .select('body_text, subject, from_address, to_address')
      .eq('id', mailRowId)
      .maybeSingle()
    // CONTENT-level (2026-07-26). Attachment BYTES cannot be inspected, so the
    // parent message decides: if the email that carried this file talks about EFT
    // (subject or body), the file is EFT content and is withheld. That is the same
    // test the message itself gets, applied one level up — a proof of payment
    // arrives attached to a mail that says so.
    const scope = await laneScopeFor(user.email)
    if (
      scope.blocksEmail(row?.from_address) ||
      scope.blocksEmail(row?.to_address) ||
      (hidesEftContent(user.email) && mentionsEft(`${row?.subject || ''}\n${row?.body_text || ''}`))
    ) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const { attachments } = parseAttachmentMarker(row?.body_text)
    const att = attachments[Number(indexStr)]
    if (!att) return NextResponse.json({ error: 'no_media' }, { status: 404 })
    const { data: blob, error: dlErr } = await db.storage.from(EMAIL_ATTACHMENTS_BUCKET).download(att.path)
    if (dlErr || !blob) {
      console.error('[inbox-media] email attachment download failed:', dlErr?.message)
      return NextResponse.json({ error: 'storage_fetch_failed' }, { status: 502 })
    }
    const headers = new Headers({
      'Content-Type': att.mimeType,
      'Cache-Control': 'private, max-age=300',
      'Content-Disposition': `inline; filename="${att.filename.replace(/["\r\n]/g, '')}"`,
    })
    const arrayBuf = await blob.arrayBuffer()
    return new NextResponse(arrayBuf, { status: 200, headers })
  }

  // The `id` param is the wa_messages row id (UUID). Strip any "wa:" prefix the
  // unified thread uses for its synthetic message ids.
  const rowId = id.replace(/^wa:/, '')
  const { data: row } = await db
    .from('wa_messages')
    .select('metadata, wa_phone, body')
    .eq('id', rowId)
    .maybeSingle()
  const media = (row?.metadata as { media?: MediaMeta } | null)?.media
  // CONTENT-level, same as the mail branch: the caption/body that came with the
  // media decides. Also withhold anything stored under an eft-proof path — a
  // vendor's uploaded proof carries no caption to test.
  const waScope = await laneScopeFor(user.email)
  if (
    waScope.blocksPhone(row?.wa_phone as string | null) ||
    (hidesEftContent(user.email) &&
      (mentionsEft(row?.body as string | null) ||
        mentionsEft(media?.caption) ||
        /eft-proof/i.test(media?.storage_path || '')))
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!media?.id && !media?.storage_path) return NextResponse.json({ error: 'no_media' }, { status: 404 })

  // B6: Prefer Storage. When the inbound media was copied into the private
  // vendor-docs bucket at receipt (metadata.media.storage_path), serve those
  // bytes directly — same-origin, no Meta fetch, no ~1h media-id expiry. Only
  // legacy rows (captured before B6, or where the receipt-time copy failed)
  // have no storage_path and fall through to the Meta media-id fetch below.
  if (media.storage_path) {
    const { data: blob, error: dlErr } = await db.storage
      .from(WA_MEDIA_BUCKET)
      .download(media.storage_path)
    if (!dlErr && blob) {
      const contentType = media.mime_type || blob.type || 'application/octet-stream'
      const headers = new Headers({
        'Content-Type': contentType,
        // Private cache only — admin-gated, vendor PII (Doctrine Law 2).
        'Cache-Control': 'private, max-age=300',
      })
      if (media.filename) {
        headers.set('Content-Disposition', `inline; filename="${media.filename.replace(/["\r\n]/g, '')}"`)
      }
      const arrayBuf = await blob.arrayBuffer()
      return new NextResponse(arrayBuf, { status: 200, headers })
    }
    // Storage download failed (object pruned / transient) — fall through to Meta
    // only if we still have a media id, otherwise report the failure.
    console.error('[inbox-media] storage download failed:', dlErr?.message)
    if (!media.id) return NextResponse.json({ error: 'storage_fetch_failed' }, { status: 502 })
  }

  if (!media.id) return NextResponse.json({ error: 'no_media' }, { status: 404 })

  if (!WA_TOKEN) return NextResponse.json({ error: 'whatsapp_not_configured' }, { status: 503 })

  try {
    // 1) Resolve the media id -> short-lived download URL.
    const metaRes = await fetch(`${GRAPH}/${media.id}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    })
    if (!metaRes.ok) {
      return NextResponse.json({ error: 'media_lookup_failed', status: metaRes.status }, { status: 502 })
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string }
    if (!meta.url) return NextResponse.json({ error: 'media_url_missing' }, { status: 502 })

    // 2) Fetch the bytes (token-gated — must send the bearer here too).
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } })
    if (!binRes.ok || !binRes.body) {
      return NextResponse.json({ error: 'media_fetch_failed', status: binRes.status }, { status: 502 })
    }

    const contentType = meta.mime_type || media.mime_type || binRes.headers.get('content-type') || 'application/octet-stream'
    const headers = new Headers({
      'Content-Type': contentType,
      // Private cache only — admin-gated, vendor PII (Doctrine Law 2).
      'Cache-Control': 'private, max-age=300',
    })
    if (media.filename) {
      headers.set('Content-Disposition', `inline; filename="${media.filename.replace(/["\r\n]/g, '')}"`)
    }
    return new NextResponse(binRes.body, { status: 200, headers })
  } catch (e) {
    return NextResponse.json({ error: 'proxy_error', detail: (e as Error).message }, { status: 502 })
  }
}
