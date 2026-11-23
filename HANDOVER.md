# Cape Town Halaal 2026 — Handover Document

**Date:** 2026-06-16  
**Repo:** github.com/Zanii-Agency/capetown-halaal-landing (branch: `final-deploy`)  
**Live:** cthalaal.co.za  
**Vercel project:** capetown-halaal-landing (sinans-projects-6aa720e0)  
**Supabase project:** dtdqopjdxwfvtyrnygdt  
**Ticket store:** tickets.youngatheart.co.za (WordPress/WooCommerce/FooEvents)

---

## Who to give this to

The person(s) taking over admin portal ops and vendor portal maintenance. They need:
- GitHub access to Zanii-Agency/capetown-halaal-landing
- Vercel access (deploy permissions)
- Supabase dashboard access (read + SQL editor)
- WordPress admin access for tickets.youngatheart.co.za
- Meta Business Suite access for the WhatsApp bot

---

## Current state

**All known bugs are fixed.** Scroll containment, dashboard fetch errors, vendor summary 404s, chase button, broadcast layout, sidebar collapse — all resolved.

**All data cleaned.** Smoke test rows deleted (was inflating counts). WA threads backfilled. All 4 SQL migrations applied. All Vercel env vars set.

**All audits closed.** Activity feed moved, allocation countdown added, exhibitor nav/logo fixed, support inbox identity filter + collapsible threads deployed.

---

## What still needs work (deferred)

These were intentionally deferred from the sprint. No urgency, but should be on the roadmap:

1. **Wave 4 deepening** — tasks + staff sections of VendorHub (`/admin/vendors/[id]` is live but tasks/staff tabs are placeholder)
2. **Mobile triage workbench** — row actions on `/admin/applications` mobile view
3. **Day-of festival surface** — live operator ops console for the December event
4. **Auto-categorize support emails** — AI tag suggestions for `/admin/support-inbox`
5. **Predictive churn risk** — score vendors by engagement drop-off
6. **Bundle optimization** — tree-shake recharts, pre-shrink logo assets

---

## Ongoing ops (person taking over should know)

- **462 vendor applications** pending (median age: 40+ days) — needs daily triage. Bulk approve/reject via `/admin/applications` with keyboard shortcuts (j/k/a/r).
- **WhatsApp bot** — 48 inbound conversations, 130 delivered replies, 33 failed sends (2 non-opted-in numbers: +971501168462 UAE, +27723803393 SA). Meta blocks broadcasts to unsubscribed numbers. Bot defers unknown questions to support@youngatheart.co.za. Rate limit: 10 req / 10 min per IP. Check health at `/admin/settings/comms-health` or daily digests at `~/work-logs/cth-bot-digest-*.md`.
- **Support inbox** fetches mail from `support@youngatheart.co.za` via IMAP cron (every 2 min). Replies go through Resend.
- **Tickets** are WooCommerce/FooEvents (NOT stored in Supabase). Ticket counts read from WC API at render time.
- **Deploy** is manual: `git push && vercel --prod`. Auto-deploy from GitHub is not wired — Vercel webhook doesn't trigger on push.
- **CRON_SECRET** in Vercel env protects cron endpoints. All crons are configured in vercel.json.
- **No em-dashes** in any vendor-facing copy (Law 7). The `interpolate.ts` filter strips them on render.

---

## Doctrine (8 laws — read these before any change)

1. Deploy through `vercel --prod` only. Ignore netlify.toml.
2. Vendor PII never leaks to public pages.
3. Do not fork FooEvents — layer on top through WC reads.
4. WooCommerce is ticket source of truth. No duplicated ticket counts.
5. Email batches use maxMessages:20, Resend preferred, GoDaddy SMTP fallback.
6. Every WooCommerce orders.list call must pass `after=` date filter.
7. No em-dashes in vendor-facing copy.
8. Stall allocations stored as `⟦STALL:code⟧` markers on admin_notes. No phantom stalls table.

---

## Quick reference

| Task | Command |
|------|---------|
| Deploy | `git push && vercel --prod` |
| Run TS check | `npx tsc --noEmit` |
| Check health | browse to `cthalaal.co.za/admin/settings/comms-health` |
| View cron logs | Vercel dashboard → Functions → /api/cron/* |
| Check WA bot | `node eval/festival-brain-eval.mjs` |
| Backfill emails | `node scripts/backfill-support-html.mjs` |

---

## Credentials (stored in macOS Keychain)

- `cth-wp-sftp` — WordPress SFTP for tickets.youngatheart.co.za
- `cth-fe-checkin` — FooEvents Check-in app login
- `cth-godaddy-smtp` — GoDaddy email (support@youngatheart.co.za)
- `claude-fooevents-license` — FooEvents Bundle license key
- Supabase dashboard — access via email invite
- Vercel — access via email invite
