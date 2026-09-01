#!/usr/bin/env node
/**
 * Provision per-admin Zanii DIDs for the CTH ledger.
 *
 * Adds `master` (Taona / owner) and `operator` (shared fallback for any other
 * admin_users operator) to ZANII_CTH_KEYS, so each human admin's action history
 * is resolvable at /agent/{did}. `samreen` already exists in prod and is left
 * untouched. Runs entirely locally — it only generates keys and writes a file;
 * it never touches the ledger.
 *
 * MERGE-SAFE: it reads your CURRENT ZANII_CTH_KEYS and only ADDS missing agents.
 * It never drops or rewrites the 4 live agents (vendor-bot/payments/uploads/
 * samreen), so the 6 existing hooks keep working.
 *
 * Usage:
 *   # 1. Make your current prod keys available (either works):
 *   vercel env pull .env.zanii --environment=production   # then: export $(grep ZANII_CTH_KEYS .env.zanii)
 *   #   ...or paste the current JSON:  export ZANII_CTH_KEYS='{"samreen":{...},...}'
 *   #
 *   # 2. (optional) issue from the org owner key instead of self-issuing:
 *   export ZANII_CTH_OWNER_KEY=<owner-private-key-hex>
 *   #
 *   # 3. Run:
 *   node scripts/provision-admin-dids.mjs
 *   #
 *   # 4. Paste the printed value of the written file into Vercel:
 *   #    Settings > Environment Variables > ZANII_CTH_KEYS (Production) > edit.
 *
 * Output: .zanii-cth-keys.json (mode 600, gitignored). Private keys are written
 * to that file ONLY — never printed to the terminal.
 */
import { generateKeypair, createCert, verifyCertSignature, scopesAllow } from '@zanii/core'
import { writeFileSync, readFileSync } from 'node:fs'

// Extract ZANII_CTH_KEYS from a `vercel env pull` dotenv file WITHOUT routing the
// secret through the shell (JSON full of quotes breaks shell escaping). Returns
// the raw JSON string or null.
function keysFromDotenv(path) {
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('ZANII_CTH_KEYS='))
  if (!line) return null
  let v = line.slice('ZANII_CTH_KEYS='.length).trim()
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  return v
}

const ADMINS_TO_ADD = ['master', 'operator'] // samreen already exists in prod
const SCOPES = ['cth.admin.*']               // covers every cth.admin.<action> target
const EXP = '2028-12-31T23:59:59Z'
const OUT = '.zanii-cth-keys.json'
const hex = (u8) => Buffer.from(u8).toString('hex')

// --- current keys (merge target) ------------------------------------------
// Source order: $ZANII_CTH_KEYS, else `--keys-dotenv <vercel-pull-file>`.
let current = {}
const dotenvIdx = process.argv.indexOf('--keys-dotenv')
const dotenvPath = dotenvIdx >= 0 ? process.argv[dotenvIdx + 1] : null
const raw = process.env.ZANII_CTH_KEYS || (dotenvPath ? keysFromDotenv(dotenvPath) : null)
if (raw) {
  try { current = JSON.parse(raw) } catch {
    console.error('ZANII_CTH_KEYS is set but not valid JSON — aborting so nothing is clobbered.')
    process.exit(1)
  }
} else {
  console.warn('⚠  ZANII_CTH_KEYS not in env — writing ONLY the new admin agents.')
  console.warn('   Paste-merge them into the existing Vercel value; do NOT replace it.\n')
}

// --- optional owner key (else self-issue) ---------------------------------
let ownerPriv = null, ownerDid = null
if (process.env.ZANII_CTH_OWNER_KEY) {
  ownerPriv = Buffer.from(process.env.ZANII_CTH_OWNER_KEY.trim(), 'hex')
  // Derive the owner DID from a throwaway sign? No — the owner DID must be the
  // real one. Require it explicitly to avoid a wrong issuer.
  ownerDid = process.env.ZANII_CTH_OWNER_DID?.trim() || null
  if (!ownerDid) {
    console.error('ZANII_CTH_OWNER_KEY set but ZANII_CTH_OWNER_DID missing — need both to issue from the owner.')
    process.exit(1)
  }
}

// --- generate the missing agents ------------------------------------------
const added = []
for (const name of ADMINS_TO_ADD) {
  if (current[name]) { console.log(`• ${name}: already present, skipping`); continue }
  const kp = generateKeypair()
  const issuer = ownerDid || kp.did          // owner-issued or self-issued
  const issuerKey = ownerPriv || kp.privateKey
  const cert = createCert({ issuer, subject: kp.did, scopes: SCOPES, exp: EXP }, issuerKey)

  // Self-check: the cert must verify and cover a representative admin target.
  if (!verifyCertSignature(cert)) throw new Error(`cert for ${name} failed self-verify`)
  if (!scopesAllow(cert.scopes, 'cth.admin.mark_paid')) throw new Error(`cert for ${name} does not cover cth.admin.*`)

  current[name] = { did: kp.did, privateKey: hex(kp.privateKey), cert }
  added.push({ name, did: kp.did, issuer: issuer === kp.did ? 'self' : issuer })
}

if (added.length === 0) { console.log('\nNothing to add — master + operator already exist. No file written.'); process.exit(0) }

writeFileSync(OUT, JSON.stringify(current), { mode: 0o600 })
console.log('\n✓ Wrote merged ZANII_CTH_KEYS to', OUT, '(mode 600, gitignored)')
console.log('  Added:')
for (const a of added) console.log(`    ${a.name.padEnd(9)} ${a.did}   (issuer: ${a.issuer})`)
console.log(`  Total agents in file: ${Object.keys(current).length} [${Object.keys(current).join(', ')}]`)
console.log('\nNext: copy the file contents into Vercel env ZANII_CTH_KEYS (Production), then redeploy.')
console.log('Verify live: drive one master action, then GET https://ledger.zanii.agency/agent/<master-did>')
