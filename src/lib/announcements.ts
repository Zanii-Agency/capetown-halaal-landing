import { createAdminClient } from '@/lib/supabase/admin'

// Announcements are festival-wide (not per-vendor), so with DDL blocked they
// live as a JSON object in the private vendor-docs bucket, read server-side via
// the service role. No table required.
const BUCKET = 'vendor-docs'
const PATH = '_system/announcements.json'

export interface Announcement {
  id: string
  title: string
  body: string
  pinned: boolean
  created_at: string
  created_by?: string
}

export async function listAnnouncements(): Promise<Announcement[]> {
  const admin = createAdminClient()
  const { data, error } = await admin.storage.from(BUCKET).download(PATH)
  if (error || !data) return []
  try {
    const arr = JSON.parse(await data.text()) as Announcement[]
    return arr.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at))
  } catch {
    return []
  }
}

export async function addAnnouncement(input: { title: string; body: string; pinned?: boolean; created_by?: string }): Promise<Announcement> {
  const current = await listAnnouncements()
  const item: Announcement = {
    id: `${Date.now()}`,
    title: input.title.slice(0, 160),
    body: input.body.slice(0, 4000),
    pinned: !!input.pinned,
    created_at: new Date().toISOString(),
    created_by: input.created_by,
  }
  const next = [item, ...current].slice(0, 200)
  const admin = createAdminClient()
  // The upload result carries the real failure. Without checking { error } a
  // failed write reports success and the announcement silently vanishes. Match
  // the exhibitor upload paths: capture the error, log it, and surface it so the
  // caller never tells the operator "saved" on a write that did not land.
  const { error } = await admin.storage.from(BUCKET).upload(PATH, Buffer.from(JSON.stringify(next)), {
    contentType: 'application/json', upsert: true,
  })
  if (error) {
    console.error('[announcements] addAnnouncement upload failed:', error.message)
    throw new Error(`Failed to store announcement: ${error.message}`)
  }
  return item
}
