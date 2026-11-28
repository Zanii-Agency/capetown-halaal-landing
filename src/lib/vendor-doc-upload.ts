// Direct-to-storage document uploads (vendor portal + admin on-behalf).
//
// Vercel caps a function REQUEST BODY at ~4.5MB, so a multipart upload through
// our API could never exceed ~4MB (2026-10-07: Abdusamee asked for 10MB). Fix:
// the API only mints a one-time signed upload URL; the browser PUTs the file
// straight to Supabase Storage; then a small JSON "commit" call records it on
// the ⟦PORTAL⟧ docs list. The body never passes through Vercel.

import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, type DocRecord } from '@/lib/portal-state'

export const DOC_BUCKET = 'vendor-docs'
export const DOC_MAX_BYTES = 10 * 1024 * 1024
// Canonical doc-type keys. Must match portal.docs[].type and the admin
// required-set in doc-action/route.ts + admin/vendors/[id]/doc-types.ts.
export const DOC_TYPES = ['halaal_cert', 'health_permit', 'gas_cert', 'fire_safety', 'public_liability', 'electrical_coc', 'contract', 'indemnity', 'other']

/** Mint a signed upload URL for `${applicationId}/${docType}-<ts>.<ext>`. */
export async function signDocUpload(applicationId: string, docType: string, fileName: string) {
  const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const path = `${applicationId}/${docType}-${Date.now()}.${ext}`
  const { data, error } = await createAdminClient().storage.from(DOC_BUCKET).createSignedUploadUrl(path)
  if (error || !data) throw new Error(error?.message || 'could not sign upload')
  return { path, token: data.token }
}

/** Verify the uploaded object (owned path, exists, <=10MB) and record it,
 *  replacing any prior doc of the same type. Returns null if the object is bad. */
export async function commitDocUpload(opts: {
  applicationId: string
  docType: string
  path: string
  name: string
  status: DocRecord['status']
  note?: string
}): Promise<DocRecord | null> {
  const { applicationId, docType, path } = opts
  const prefix = `${applicationId}/`
  if (!path.startsWith(prefix) || path.includes('..')) return null
  const file = path.slice(prefix.length)
  if (!file.startsWith(`${docType}-`)) return null
  const admin = createAdminClient()
  const { data } = await admin.storage.from(DOC_BUCKET).list(applicationId, { search: file, limit: 5 })
  const obj = data?.find((o) => o.name === file)
  const size = Number((obj?.metadata as { size?: number } | null)?.size ?? -1)
  if (!obj || size < 0) return null
  if (size > DOC_MAX_BYTES) {
    await admin.storage.from(DOC_BUCKET).remove([path])
    return null
  }
  const record: DocRecord = {
    type: docType,
    path,
    name: opts.name.slice(0, 200) || file,
    status: opts.status,
    uploaded_at: new Date().toISOString(),
    ...(opts.note ? { note: opts.note } : {}),
  }
  await updatePortalState(applicationId, (s) => ({
    ...s,
    docs: [...(s.docs || []).filter((d) => d.type !== docType), record],
  }))
  return record
}
