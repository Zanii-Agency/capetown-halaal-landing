/**
 * Best-effort Zanii ledger receipts for CTH agent actions.
 *
 * Every instrumented action becomes a signed, hash-chained receipt on
 * ledger.zanii.agency under a per-function agent DID (vendor-bot / payments /
 * uploads / samreen). The ledger stores only a SALTED HASH of the payload, so
 * vendor PII never leaves our systems (Law 2). Fail-open by contract: a ledger
 * outage, missing keys, or a bad payload never blocks or throws into a send.
 *
 * Config (server env only, never client):
 *   ZANII_CTH_INGEST  a zk_live_... ingest key (write scope)
 *   ZANII_CTH_KEYS    JSON { "<agent>": { did, privateKey, cert } }
 * When either is absent (local/preview), every call is a silent no-op.
 */
import type { ZaniiAgent as ZaniiAgentT } from '@zanii/sdk'

const SERVER = 'https://ledger.zanii.agency'

// Automated function DIDs (vendor-bot/payments/uploads) + per-human admin DIDs.
// samreen exists today; master (Taona/owner) and operator (shared fallback) are
// provisioned by scripts/provision-admin-dids.mjs into ZANII_CTH_KEYS. Until then
// master/operator receipts are silent no-ops (fail-open), samreen's work now.
export type CthAgent =
  | 'vendor-bot'
  | 'payments'
  | 'uploads'
  | 'samreen'
  | 'master'
  | 'operator'

type AgentKey = { did: string; privateKey: string; cert: unknown }

let cache: Map<CthAgent, ZaniiAgentT | null> | null = null

function loadKeys(): Record<string, AgentKey> | null {
  const raw = process.env.ZANII_CTH_KEYS
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, AgentKey>
  } catch {
    return null
  }
}

async function agentFor(name: CthAgent): Promise<ZaniiAgentT | null> {
  if (!cache) cache = new Map()
  if (cache.has(name)) return cache.get(name) ?? null
  const ingest = process.env.ZANII_CTH_INGEST
  const k = loadKeys()?.[name]
  if (!ingest || !k) {
    cache.set(name, null)
    return null
  }
  const { ZaniiAgent } = await import('@zanii/sdk')
  const agent = new ZaniiAgent({
    serverUrl: SERVER,
    agentDid: k.did,
    agentPrivateKey: Buffer.from(k.privateKey, 'hex'),
    delegation: [k.cert as never],
    apiKey: ingest,
  })
  cache.set(name, agent)
  return agent
}

/**
 * Record one action as a ledger receipt and flush it (serverless-safe).
 * Best-effort: never throws. Returns the receipt hash, or null if unconfigured
 * or the ledger was unreachable.
 */
export async function recordLedger(
  agent: CthAgent,
  target: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  try {
    const a = await agentFor(agent)
    if (!a) return null
    const { hash } = await a.record({ target, payload })
    await a.flush()
    return hash
  } catch (e) {
    console.warn('[zanii-ledger] record failed:', (e as Error).message)
    return null
  }
}

// --- Per-admin action receipts ---------------------------------------------
//
// Every human admin acts under their OWN did:key so their action history is
// resolvable at /agent/{did}. The acting human is resolved from the session the
// route already holds (email + role), and is ALSO embedded in the salted-hashed
// payload, so "who did what" stays provable even when the shared `operator` DID
// signs. Only a fingerprint of the payload ever leaves our systems (Law 2).

export type AdminActor = { email?: string | null; role?: string | null }

// Known humans get their own DID. Extend as admins are added + keyed into
// ZANII_CTH_KEYS. Anyone else falls through to role, then the shared operator DID.
const ADMIN_DID_BY_EMAIL: Record<string, CthAgent> = {
  'capetownhalaal@gmail.com': 'samreen', // Samreen Kumandan (festival owner)
}

/** Which admin DID signs an action, resolved from the acting human. */
export function adminAgentFor(actor: AdminActor): CthAgent {
  const email = (actor.email || '').toLowerCase().trim()
  if (email && ADMIN_DID_BY_EMAIL[email]) return ADMIN_DID_BY_EMAIL[email]
  const role = (actor.role || '').toLowerCase().trim()
  if (role === 'owner' || role === 'master') return 'master'
  return 'operator'
}

/**
 * Record one ADMIN action as a per-admin, hash-chained ledger receipt.
 * Best-effort: never throws, never blocks the action (see recordLedger).
 * `target` defaults to `cth.admin.<action>` (one scope, cth.admin.*, covers all).
 */
export async function recordAdminAction(input: {
  actor: AdminActor
  action: string
  vendorId?: string | null
  applicationId?: string | null
  target?: string
  payload?: Record<string, unknown>
}): Promise<string | null> {
  const target = input.target || `cth.admin.${input.action}`
  return recordLedger(adminAgentFor(input.actor), target, {
    actor: { email: input.actor.email || null, role: input.actor.role || null },
    action: input.action,
    vendorId: input.vendorId ?? null,
    applicationId: input.applicationId ?? null,
    at: new Date().toISOString(),
    ...(input.payload || {}),
  })
}
