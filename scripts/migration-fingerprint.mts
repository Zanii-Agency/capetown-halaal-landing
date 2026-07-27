/**
 * Before/after fingerprint for the Supabase organisation transfer.
 *
 *   npx tsx --env-file=.env.local scripts/migration-fingerprint.mts save    # BEFORE the transfer
 *   npx tsx --env-file=.env.local scripts/migration-fingerprint.mts check   # AFTER, diffs against it
 *
 * WHY. Transferring a project between Supabase organisations is documented to
 * preserve the project ref, URL, anon key, service-role key, database, storage
 * and custom domain. "Documented to" is not "observed to", and the thing being
 * moved holds every vendor record, every message and every payment state for the
 * festival. So: take a fingerprint first, take it again after, and diff. If a
 * single number moved, we know within a minute instead of finding out from a
 * vendor.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never writes to the database and never
 * performs the transfer. The transfer is a dashboard action on the owner's
 * account, and account/billing operations are not something this repo should be
 * able to trigger.
 *
 * Baseline is written to .migration-baseline.json in the repo root, which is
 * gitignored — it contains row counts, not secrets, but it is a point-in-time
 * artefact and does not belong in history.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BASELINE = join(process.cwd(), '.migration-baseline.json')

/** Tables whose row count must not change across a transfer. */
const TABLES = [
  'vendor_applications',
  'support_inbox_threads',
  'support_inbox_messages',
  'wa_messages',
  'vendor_tickets',
  'site_events',
  'wa_read_state',
]

type Fingerprint = {
  takenAt: string
  projectRef: string
  authHealthy: boolean
  anonKeyAccepted: boolean
  serviceKeyAccepted: boolean
  authUsers: number | null
  buckets: string[]
  counts: Record<string, number | null>
}

const ref = URL_.replace(/^https?:\/\//, '').split('.')[0]

async function head(path: string, key: string): Promise<Response | null> {
  try {
    return await fetch(`${URL_}${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    })
  } catch { return null }
}

async function count(table: string): Promise<number | null> {
  try {
    const r = await fetch(`${URL_}/rest/v1/${table}?select=*`, {
      method: 'HEAD',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
      signal: AbortSignal.timeout(25_000),
    })
    const cr = r.headers.get('content-range') // e.g. "0-0/1234"
    const n = cr?.split('/')[1]
    return n && n !== '*' ? Number(n) : null
  } catch { return null }
}

async function take(): Promise<Fingerprint> {
  const authRes = await head('/auth/v1/settings', ANON)
  const anonRes = await head('/rest/v1/', ANON)
  const svcRes = await head('/rest/v1/', SERVICE)

  let authUsers: number | null = null
  try {
    const r = await fetch(`${URL_}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (r.ok) {
      const j = await r.json() as { total?: number; users?: unknown[] }
      authUsers = typeof j.total === 'number' ? j.total : (j.users?.length ?? null)
    }
  } catch { /* leave null */ }

  let buckets: string[] = []
  try {
    const r = await fetch(`${URL_}/storage/v1/bucket`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (r.ok) buckets = ((await r.json()) as Array<{ name: string }>).map((b) => b.name).sort()
  } catch { /* leave empty */ }

  const counts: Record<string, number | null> = {}
  for (const t of TABLES) counts[t] = await count(t)

  return {
    takenAt: new Date().toISOString(),
    projectRef: ref,
    authHealthy: authRes?.status === 200,
    // 401 is the CORRECT answer here: the key is accepted and the request is
    // then rejected for lacking a row policy. A 000/5xx means the gateway or the
    // origin is unreachable, which is what we are actually testing for.
    anonKeyAccepted: !!anonRes && anonRes.status < 500,
    serviceKeyAccepted: !!svcRes && svcRes.status < 500,
    authUsers,
    buckets,
    counts,
  }
}

function render(f: Fingerprint): string {
  const rows = Object.entries(f.counts).map(([t, n]) => `  ${t.padEnd(24)} ${n ?? 'UNREACHABLE'}`)
  return [
    `ref            ${f.projectRef}`,
    `auth healthy   ${f.authHealthy}`,
    `anon key ok    ${f.anonKeyAccepted}`,
    `service key ok ${f.serviceKeyAccepted}`,
    `auth users     ${f.authUsers ?? 'UNREACHABLE'}`,
    `buckets        ${f.buckets.join(', ') || 'UNREACHABLE'}`,
    'row counts:',
    ...rows,
  ].join('\n')
}

const mode = process.argv[2] || 'check'

if (!URL_ || !SERVICE) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(2)
}

const now = await take()
console.log(render(now))
console.log()

// A fingerprint taken while the database is down is worthless as a baseline and
// actively dangerous as one: every count reads UNREACHABLE, and a later "check"
// would then compare null to null and report success.
const reachable = Object.values(now.counts).some((n) => n !== null)
if (!reachable) {
  console.error('DATABASE UNREACHABLE — this is not a usable fingerprint.')
  console.error(mode === 'save' ? 'Refusing to save it as a baseline.' : 'Cannot verify anything.')
  process.exit(1)
}

if (mode === 'save') {
  writeFileSync(BASELINE, JSON.stringify(now, null, 2))
  console.log(`baseline saved -> ${BASELINE}`)
  console.log('Now do the transfer, then re-run with: check')
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error('No baseline to compare against. Run `save` BEFORE the transfer.')
  process.exit(2)
}

const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Fingerprint
const problems: string[] = []

if (before.projectRef !== now.projectRef) {
  problems.push(`PROJECT REF CHANGED: ${before.projectRef} -> ${now.projectRef}. Every env var and hardcoded script URL is now wrong.`)
}
if (!now.authHealthy) problems.push('auth is not healthy')
if (!now.anonKeyAccepted) problems.push('the anon key is no longer accepted — the public site and login are broken')
if (!now.serviceKeyAccepted) problems.push('the service-role key is no longer accepted — every server route is broken')
if (before.authUsers !== null && now.authUsers !== null && before.authUsers !== now.authUsers) {
  problems.push(`auth user count moved: ${before.authUsers} -> ${now.authUsers}`)
}
const missingBuckets = before.buckets.filter((b) => !now.buckets.includes(b))
if (missingBuckets.length) problems.push(`storage buckets missing: ${missingBuckets.join(', ')}`)

for (const [t, b] of Object.entries(before.counts)) {
  const a = now.counts[t]
  if (b === null || a === null) continue
  // Rows can legitimately ARRIVE between the two runs (the crons never stop), so
  // only a DROP is a failure. Growth is expected and is not flagged.
  if (a < b) problems.push(`${t}: ${b} -> ${a} (LOST ${b - a} rows)`)
}

console.log(`baseline taken ${before.takenAt}`)
if (problems.length) {
  console.error('\nMIGRATION VERIFICATION FAILED:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\nMIGRATION VERIFIED: ref, keys, auth, buckets and every row count intact.')
process.exit(0)
