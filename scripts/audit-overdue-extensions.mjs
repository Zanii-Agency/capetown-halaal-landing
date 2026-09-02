#!/usr/bin/env node
// Audit: check chats/admin notes/events for the 27 overdue vendors to find
// anyone who was given an extension to 31 August 2026 (or later).
//
// Usage:
//   node scripts/audit-overdue-extensions.mjs

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const envPath = path.join(repo, '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/i)
  if (!m) continue
  let v = m[2].trim().replace(/^["']|["']$/g, '')
  if (!process.env[m[1]]) process.env[m[1]] = v
}

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
async function rest(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

const EXTENSION_RE = /\b(extension|extend|extended|arrangement|deferr?ed?|postpone|more time|moretime|31\s*(st)?\s*(aug|august)|aug(ust)?\s*31)\b/i
const FINAL_DATE_RE = /\b(2026\s*[-/]?\s*08\s*[-/]?\s*31|31\s*(aug|august)\s*2026)\b/i

const today = new Date()
const daysBetween = (a, b) => Math.floor((b - a) / 86400000)

const PORTAL_RE = /⟦PORTAL:([A-Za-z0-9+/=]+)⟧/
function parseState(notes) {
  const m = String(notes || '').match(PORTAL_RE)
  if (!m) return {}
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) } catch { return {} }
}

function hasPaid(st, row) {
  const settled = new Set(['paid', 'waived', 'collected'])
  return !!row.paid_at || settled.has(st.payment?.status || '')
}

function isChaseSuppressed(st) {
  if (hasPaid(st, {})) return true
  if (st.payment?.status !== 'deferred') return false
  const until = st.payment?.arrangement?.until
  return !until || today <= new Date(`${until}T23:59:59.999Z`)
}

function hasEftMarker(notes) { return /⟦EFT⟧/.test(String(notes || '')) }

function computeDue(row) {
  if (row.reviewed_at) {
    const d = new Date(row.reviewed_at)
    d.setDate(d.getDate() + 30)
    return d
  }
  return null
}

const sel = 'id,business_name,contact_name,email,phone,admin_notes,reviewed_at,paid_at,status'
const apps = await rest(`vendor_applications?status=eq.approved&select=${sel}&limit=1000`)

const overdue = apps.filter((a) => {
  const st = parseState(a.admin_notes)
  if (hasPaid(st, a)) return false
  if (isChaseSuppressed(st)) return false
  if (hasEftMarker(a.admin_notes)) return false
  const due = computeDue(a)
  if (!due) return false
  const daysRemaining = daysBetween(today, due)
  return daysRemaining < 0
})

console.log(`Found ${overdue.length} overdue vendors to audit.\n`)

const flagged = []

for (const a of overdue) {
  const hits = []

  // 1. Admin notes (human prose, stripped of markers).
  const prose = String(a.admin_notes || '')
    .replace(/⟦STALL:[^⟧]+⟧/g, '')
    .replace(/⟦PORTAL:[^⟧]+⟧/g, '')
    .replace(/⟦DOCS:[^⟧]+⟧/g, '')
    .replace(/⟦CONTRACT_SIGNED⟧/g, '')
    .replace(/⟦PAID⟧/g, '')
    .replace(/⟦EFT⟧/g, '')
    .replace(/⟦NOEFT⟧/g, '')
    .replace(/⟦OWNERVIS⟧/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (EXTENSION_RE.test(prose) || FINAL_DATE_RE.test(prose)) {
    hits.push({ source: 'admin_notes', snippet: prose.slice(0, 400) })
  }

  // 2. vendor_application_events.
  try {
    const events = await rest(`vendor_application_events?application_id=eq.${a.id}&select=event_type,note,after_value,created_at`)
    for (const e of events) {
      const text = `${e.event_type || ''} ${e.note || ''} ${JSON.stringify(e.after_value || {})}`
      if (EXTENSION_RE.test(text) || FINAL_DATE_RE.test(text)) {
        hits.push({ source: 'vendor_application_events', snippet: text.slice(0, 400), at: e.created_at })
      }
    }
  } catch (err) { /* swallow */ }

  // 3. WhatsApp messages by last-9 phone.
  const digits = String(a.phone || '').replace(/\D/g, '')
  const last9 = digits.slice(-9)
  if (last9.length >= 9) {
    try {
      const msgs = await rest(`wa_messages?wa_phone=like.*${last9}&select=direction,body,created_at`)
      for (const m of msgs) {
        const text = `${m.body || ''}`
        if (EXTENSION_RE.test(text) || FINAL_DATE_RE.test(text)) {
          hits.push({ source: 'wa_messages', snippet: text.slice(0, 400), at: m.created_at, direction: m.direction })
        }
      }
    } catch (err) { /* swallow */ }
  }

  // 4. Support inbox email messages by email.
  const email = String(a.email || '').trim().toLowerCase()
  if (email) {
    try {
      const threads = await rest(`support_inbox_threads?peer_email=ilike.${encodeURIComponent(email)}&select=id`)
      if (threads.length) {
        const ids = threads.map((t) => t.id).join(',')
        const msgs = await rest(`support_inbox_messages?thread_id=in.(${ids})&select=body_text,direction,received_at`)
        for (const m of msgs) {
          const text = `${m.body_text || ''}`
          if (EXTENSION_RE.test(text) || FINAL_DATE_RE.test(text)) {
            hits.push({ source: 'support_inbox_messages', snippet: text.slice(0, 400), at: m.received_at, direction: m.direction })
          }
        }
      }
    } catch (err) { /* swallow */ }
  }

  // 5. mail_messages.
  if (email) {
    try {
      const msgs = await rest(`mail_messages?to_addr=ilike.${encodeURIComponent(email)}&select=body_text,subject,created_at`)
      for (const m of msgs) {
        const text = `${m.subject || ''} ${m.body_text || ''}`
        if (EXTENSION_RE.test(text) || FINAL_DATE_RE.test(text)) {
          hits.push({ source: 'mail_messages', snippet: text.slice(0, 400), at: m.created_at })
        }
      }
    } catch (err) { /* swallow */ }
  }

  if (hits.length) {
    flagged.push({ vendor: a, hits })
  }
}

if (!flagged.length) {
  console.log('No extension mentions found for any overdue vendor in chats, notes, events, or mail.')
} else {
  console.log(`\n⚠️  FLAGGED VENDORS (${flagged.length}): possible extension / 31 Aug mention\n`)
  for (const f of flagged) {
    const a = f.vendor
    const due = computeDue(a)
    const daysOver = -daysBetween(today, due)
    console.log(`--- ${a.business_name || '(no name)'}  ${a.email}  ${a.phone}  ${daysOver}d overdue ---`)
    for (const h of f.hits) {
      console.log(`  [${h.source}${h.direction ? ` / ${h.direction}` : ''}${h.at ? ` / ${h.at.slice(0, 10)}` : ''}]`)
      console.log(`    ${h.snippet.replace(/\n/g, ' ').slice(0, 300)}`)
    }
    console.log('')
  }
}
