/**
 * Admin ACTOR context for non-browser callers (the /api/mcp channel).
 *
 * Every admin route derives "who is looking" from the cookie session client
 * (`@/lib/supabase/server` createClient -> auth.getUser). The master-lane / EFT
 * confidentiality wall keys on that viewer's email (isEftAdmin, laneScopeFor,
 * hidesEftContent). A machine caller has no cookie, so we put the resolved
 * admin_users row in an AsyncLocalStorage and let createClient() read it FIRST.
 * The 100+ routes and the wall itself stay untouched: a token caller is exactly
 * the same viewer as the same person logged in through the browser.
 *
 * Token = cth_<base64url(userId)>.<hmac_sha256(secret, userId)>. Stateless on
 * purpose, no table, no migration. Revoke one person by deleting their
 * admin_users row; revoke everyone by rotating ADMIN_API_TOKEN_SECRET.
 * zanii-codef: no per-token revocation / last_used. Add an admin_api_tokens
 * table when there are more than a handful of holders.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AdminRole } from '@/lib/admin-rbac'

export interface AdminActor {
  id: string
  email: string | null
  role: AdminRole
}

const als = new AsyncLocalStorage<AdminActor>()

export function runWithActor<T>(actor: AdminActor, fn: () => Promise<T>): Promise<T> {
  return als.run(actor, fn)
}

export function getActor(): AdminActor | null {
  return als.getStore() ?? null
}

const PREFIX = 'cth_'

function secret(): string | null {
  const s = process.env.ADMIN_API_TOKEN_SECRET || ''
  // Fail closed: a short/missing secret means NO token is ever valid.
  return s.length >= 32 ? s : null
}

function sign(userId: string, key: string): string {
  return createHmac('sha256', key).update(userId).digest('base64url')
}

export function mintAdminApiToken(userId: string): string {
  const key = secret()
  if (!key) throw new Error('ADMIN_API_TOKEN_SECRET unset or shorter than 32 chars')
  return `${PREFIX}${Buffer.from(userId, 'utf8').toString('base64url')}.${sign(userId, key)}`
}

/** Returns the admin_users id the token was minted for, or null. Never throws. */
export function verifyAdminApiToken(token: string | null | undefined): string | null {
  const key = secret()
  if (!key || !token || !token.startsWith(PREFIX)) return null
  const [idPart, sigPart] = token.slice(PREFIX.length).split('.')
  if (!idPart || !sigPart) return null
  let userId: string
  try {
    userId = Buffer.from(idPart, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null
  const expected = Buffer.from(sign(userId, key))
  const given = Buffer.from(sigPart)
  if (expected.length !== given.length) return null
  return timingSafeEqual(expected, given) ? userId : null
}
