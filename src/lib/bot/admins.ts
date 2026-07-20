// Hardcoded admin allowlist for the festival WhatsApp bot.
// Two roles today: 'master' (Taona — full control) and 'festival_owner' (Samreen
// — site/content/policy decisions). Admin inbound messages SKIP the festival
// LLM so the bot never tries to answer them as a customer.
//
// Phone format: E.164 with leading '+'. Match is by exact string after
// normalising both sides via toE164() in src/lib/whatsapp.ts.

export type AdminRole = 'master' | 'festival_owner'

export interface BotAdmin {
  phone: string // E.164, includes '+'
  role: AdminRole
  name: string
  email?: string
}

export const BOT_ADMINS: BotAdmin[] = [
  {
    phone: '+971501168462',
    role: 'master',
    name: 'Taona',
    // No email backstop: festival ops mail must never route to an agency
    // address. Taona gets master alerts on WhatsApp + the admin portal; the
    // festival owner (below) receives the email copy at her own address.
  },
  {
    phone: '+27723803393',
    role: 'festival_owner',
    name: 'Samreen Kumandan',
    email: 'capetownhalaal@gmail.com',
  },
]

export function findAdmin(e164: string): BotAdmin | null {
  const norm = (e164 || '').trim()
  return BOT_ADMINS.find((a) => a.phone === norm) || null
}

// --- Developer-role routing (master doctrine: dev:true) ---
// Taona's number is encoded as a `developer` in every bot. When the inbound
// sender isDevNumber, the webhook reroutes through the brain so Taona can test
// it, but SKIPS persistence (no real vendor thread/data is created) and the
// bot's reply is prefixed with `[DEV]`. This keeps dev test traffic out of the
// unified vendor inbox entirely.
//
// Dev numbers come from the DEV_WHATSAPP env ONLY (comma-separated E.164 list),
// a dedicated test handset. We deliberately do NOT hardcode Taona's number here:
// +971501168462 is the MASTER ADMIN, and admin commands (stats, approvals,
// swipe-reply) must keep working from it. Admin always wins over dev (the webhook
// gates dev on !findAdmin), and with DEV_WHATSAPP unset, dev mode is dormant so
// the live bot is unchanged until a separate test number is configured.
const DEV_NUMBERS: string[] = []

function envDevNumbers(): string[] {
  return (process.env.DEV_WHATSAPP || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function isDevNumber(e164: string): boolean {
  const norm = (e164 || '').trim()
  if (!norm) return false
  return DEV_NUMBERS.includes(norm) || envDevNumbers().includes(norm)
}

export function isAdmin(e164: string): boolean {
  return findAdmin(e164) !== null
}

export function adminPhones(): string[] {
  return BOT_ADMINS.map((a) => a.phone)
}
