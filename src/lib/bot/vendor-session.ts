// Vendor session + verification spine (ADR-0005, spec 010 Phase A).
//
// resolveVendorSession(waPhone) turns an inbound WhatsApp number into a typed,
// authenticated session that the tool executor scopes every vendor action to.
// This is the multi-tenant isolation boundary: the vendorId a tool acts on comes
// ONLY from here, never from the model's arguments or the user's text.
//
// Verification ladder:
//   - phone resolves to exactly one vendor  -> verified   (tools scoped to vendorId)
//   - phone resolves to zero                -> unknown     (only get_event_info)
//   - phone resolves to more than one       -> ambiguous   (only get_event_info)
// Unknown/ambiguous numbers step up via email-OTP (startVendorVerification /
// confirmVendorVerification), reusing the sha256 + constant-time + TTL + attempt-
// cap pattern from wa-optin/verify. Binding is ADDITIVE — see ADR-0005.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { resolveIdentity } from '@/lib/bot/identity'
import { createAdminClient } from '@/lib/supabase/admin'
import { withoutMerged } from '@/lib/merge'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { sendEmail } from '@/lib/email/resend'

export type VendorSessionStatus = 'verified' | 'ambiguous' | 'unknown'

export interface VendorSession {
  status: VendorSessionStatus
  waPhone: string                 // E.164 of the sender (the credential)
  /** Set ONLY when status === 'verified'. The single application this number owns.
   *  Every scoped tool reads THIS, never a model-supplied id. */
  vendorId?: string
  /** Convenience copy of the resolved vendor (verified only). */
  vendor?: NonNullable<Awaited<ReturnType<typeof resolveIdentity>>['vendor']>
  /** Distinct business names on this number when ambiguous, for the step-up prompt. */
  candidates?: string[]
}

const OTP_TTL_MINUTES = 15
const OTP_MAX_ATTEMPTS = 5

function last9(e164: string): string {
  return e164.replace(/\D/g, '').slice(-9)
}

function hashOtp(code: string, applicationId: string): string {
  return createHash('sha256').update(`${code}:${applicationId}`).digest('hex')
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/**
 * Resolve an inbound WhatsApp number to a typed vendor session. Verified iff the
 * number resolves to EXACTLY one application (including via an additive ⟦WAV⟧
 * marker from a prior email-OTP step-up). >1 application = ambiguous; 0 = unknown.
 */
export async function resolveVendorSession(waPhone: string): Promise<VendorSession> {
  const id = await resolveIdentity(waPhone)
  if (id.role !== 'vendor' || !id.vendor) {
    return { status: 'unknown', waPhone }
  }
  // Ambiguous: the number carries more than one application. We must NOT guess
  // which vendorId to scope to, so no vendor tool is callable until the vendor
  // steps up and binds one. (Same guard as vendor-brain's action disambiguation,
  // lifted to the session layer.)
  if ((id.vendor.applicationCount ?? 1) > 1) {
    return {
      status: 'ambiguous',
      waPhone,
      candidates: id.vendor.otherBusinesses ?? [id.vendor.business_name],
    }
  }
  return { status: 'verified', waPhone, vendorId: id.vendor.id, vendor: id.vendor }
}

export interface StartVerificationResult {
  ok: boolean
  reason?: 'no_application_for_email' | 'email_multiple' | 'send_failed'
  applicationId?: string
  maskedEmail?: string
  /** Test-only: the plaintext code, returned ONLY when opts.returnCodeForTest is
   *  set by an eval. NEVER set in the WhatsApp path. */
  code?: string
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@')
  if (!domain) return email
  const head = user.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`
}

/**
 * Begin email-OTP step-up for a WhatsApp number that did not uniquely resolve to
 * a vendor. The vendor supplies the email on their application; we send a 6-digit
 * code there and park a pending challenge keyed to the candidate number. Binding
 * happens only on confirmVendorVerification.
 */
export async function startVendorVerification(
  waPhone: string,
  email: string,
  opts: { returnCodeForTest?: boolean } = {},
): Promise<StartVerificationResult> {
  const db = createAdminClient()
  const clean = (email || '').trim().toLowerCase()
  const { data: apps } = await db
    .from('vendor_applications')
    .select('id, email, status, admin_notes')
    .ilike('email', clean)
  // Merged duplicates are not a second application. THIS is the line that told
  // A&H Homeware "I can't verify you" on 2026-07-26: they had applied twice, so
  // their email matched two rows, and a fully approved and PAID vendor was sent
  // away to prove themselves. Once the duplicate carries ⟦MERGED:..⟧ exactly one
  // row survives and the lookup is unambiguous again.
  const rows = withoutMerged(apps as Array<{ admin_notes?: string | null }>) as unknown as Array<{ id: string; email: string; status: string }>
  if (rows.length === 0) return { ok: false, reason: 'no_application_for_email' }
  // Still >1 means a genuinely unmerged cluster. Prefer the APPROVED one rather
  // than refusing outright: refusing is what cost us the vendor's trust, and an
  // approved application is unambiguously the one they mean.
  const approved = rows.filter((r) => r.status === 'approved')
  if (rows.length > 1 && approved.length !== 1) return { ok: false, reason: 'email_multiple' }
  if (rows.length > 1) rows.splice(0, rows.length, approved[0])

  const applicationId = rows[0].id
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const code_hash = hashOtp(code, applicationId)
  const l9 = last9(waPhone)

  await updatePortalState(applicationId, (s) => ({
    ...s,
    wa_verify_pending: { wa_phone: waPhone, code_hash, requested_at: new Date().toISOString(), attempts: 0 },
  }))
  // Queryable plaintext marker so confirm can find the application by the
  // candidate number (portal_state is opaque base64). Doctrine Law 8 pattern.
  await ensureMarker(applicationId, `WAVP${l9}`)

  if (!opts.returnCodeForTest) {
    try {
      await sendEmail({
        to: rows[0].email,
        subject: 'Your Young at Heart vendor verification code',
        text: `Your verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes. If you did not request this, ignore this email.`,
      })
    } catch (e) {
      console.error('[vendor-session] OTP email send failed:', (e as Error).message)
      return { ok: false, reason: 'send_failed' }
    }
  }
  return { ok: true, applicationId, maskedEmail: maskEmail(rows[0].email), ...(opts.returnCodeForTest ? { code } : {}) }
}

export interface ConfirmVerificationResult {
  ok: boolean
  reason?: 'no_pending' | 'expired' | 'too_many_attempts' | 'wrong_code'
  vendorId?: string
  remaining?: number
}

/**
 * Confirm an email-OTP step-up. On success, ADDITIVELY bind the candidate number
 * to the vendor (verified_wa entry + ⟦WAV⟧ marker) WITHOUT touching phone. The
 * number then resolves to this vendor on the next inbound.
 */
export async function confirmVendorVerification(waPhone: string, codeRaw: string): Promise<ConfirmVerificationResult> {
  const db = createAdminClient()
  const l9 = last9(waPhone)
  const code = String(codeRaw || '').replace(/\D/g, '').slice(0, 6)
  if (code.length !== 6) return { ok: false, reason: 'wrong_code', remaining: OTP_MAX_ATTEMPTS }

  const { data: apps } = await db
    .from('vendor_applications')
    .select('id, admin_notes')
    .like('admin_notes', `%WAVP${l9}%`)
  const rows = (apps || []) as Array<{ id: string; admin_notes: string | null }>
  // Find the row whose pending actually targets this exact number (marker is
  // last9-keyed; the JSON holds the full E.164).
  const match = rows.find((r) => parsePortalState(r.admin_notes).wa_verify_pending?.wa_phone === waPhone)
  if (!match) return { ok: false, reason: 'no_pending' }

  const pending = parsePortalState(match.admin_notes).wa_verify_pending!
  const ageMs = Date.now() - new Date(pending.requested_at).getTime()
  if (!Number.isFinite(ageMs) || ageMs > OTP_TTL_MINUTES * 60 * 1000) {
    await clearPending(match.id, l9)
    return { ok: false, reason: 'expired' }
  }
  if ((pending.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    await clearPending(match.id, l9)
    return { ok: false, reason: 'too_many_attempts' }
  }
  if (!constantTimeEqualHex(hashOtp(code, match.id), pending.code_hash)) {
    await updatePortalState(match.id, (s) => ({
      ...s,
      wa_verify_pending: s.wa_verify_pending
        ? { ...s.wa_verify_pending, attempts: (s.wa_verify_pending.attempts || 0) + 1 }
        : undefined,
    }))
    return { ok: false, reason: 'wrong_code', remaining: Math.max(0, OTP_MAX_ATTEMPTS - ((pending.attempts || 0) + 1)) }
  }

  // SUCCESS: additive bind. Add verified_wa entry, clear pending JSON, then fix
  // plaintext markers (drop WAVP, add WAV). Never overwrites .phone.
  await updatePortalState(match.id, (s) => {
    const existing = (s.verified_wa || []).filter((v) => v.phone !== waPhone)
    return {
      ...s,
      wa_verify_pending: undefined,
      verified_wa: [...existing, { phone: waPhone, bound_at: new Date().toISOString() }],
    }
  })
  await swapMarker(match.id, `WAVP${l9}`, `WAV${l9}`)
  return { ok: true, vendorId: match.id }
}

// --- plaintext admin_notes marker helpers (Law 8: no DDL, queryable markers) ---

async function ensureMarker(applicationId: string, token: string): Promise<void> {
  const db = createAdminClient()
  const { data } = await db.from('vendor_applications').select('admin_notes').eq('id', applicationId).single()
  const notes = (data?.admin_notes as string) || ''
  if (notes.includes(`⟦${token}⟧`)) return
  const next = notes ? `${notes}\n⟦${token}⟧` : `⟦${token}⟧`
  await db.from('vendor_applications').update({ admin_notes: next }).eq('id', applicationId)
}

async function clearPending(applicationId: string, l9: string): Promise<void> {
  await updatePortalState(applicationId, (s) => ({ ...s, wa_verify_pending: undefined }))
  await removeMarker(applicationId, `WAVP${l9}`)
}

async function removeMarker(applicationId: string, token: string): Promise<void> {
  const db = createAdminClient()
  const { data } = await db.from('vendor_applications').select('admin_notes').eq('id', applicationId).single()
  const notes = (data?.admin_notes as string) || ''
  const next = notes.replace(`⟦${token}⟧`, '').replace(/\n{3,}/g, '\n\n').trim()
  if (next !== notes) await db.from('vendor_applications').update({ admin_notes: next }).eq('id', applicationId)
}

async function swapMarker(applicationId: string, dropToken: string, addToken: string): Promise<void> {
  const db = createAdminClient()
  const { data } = await db.from('vendor_applications').select('admin_notes').eq('id', applicationId).single()
  let notes = (data?.admin_notes as string) || ''
  notes = notes.replace(`⟦${dropToken}⟧`, '')
  if (!notes.includes(`⟦${addToken}⟧`)) notes = `${notes}\n⟦${addToken}⟧`
  notes = notes.replace(/\n{3,}/g, '\n\n').trim()
  await db.from('vendor_applications').update({ admin_notes: notes }).eq('id', applicationId)
}
