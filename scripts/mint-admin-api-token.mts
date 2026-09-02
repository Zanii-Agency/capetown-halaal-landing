/**
 * Mint the Claude-connector token for one admin (see src/lib/admin-actor.ts).
 *
 *   node --env-file=.env.local --import tsx scripts/mint-admin-api-token.mts <email> [base-url]
 *
 * Prints the connector URL ONCE. It is a password: hand it over on a private
 * channel, never paste it in a chat log. The same email always yields the same
 * token until ADMIN_API_TOKEN_SECRET rotates, so re-run to "recover" it.
 * Needs the SAME ADMIN_API_TOKEN_SECRET the target deployment uses.
 */
import { createClient } from '@supabase/supabase-js'
import { mintAdminApiToken } from '@/lib/admin-actor'

const email = (process.argv[2] || '').toLowerCase().trim()
const base = (process.argv[3] || 'https://cthalaal.co.za').replace(/\/$/, '')
if (!email) { console.error('usage: <email> [base-url]'); process.exit(2) }

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const { data } = await db.from('admin_users').select('id, email, role').ilike('email', email).maybeSingle()
if (!data) { console.error(`no admin_users row for ${email}`); process.exit(1) }

console.log(`${base}/api/mcp/${mintAdminApiToken(data.id as string)}`)
console.error(`(actor ${data.email}, role ${data.role})`)
