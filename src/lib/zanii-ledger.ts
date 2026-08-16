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

export type CthAgent = 'vendor-bot' | 'payments' | 'uploads' | 'samreen'

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
