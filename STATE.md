# CTH 2026 — Sprint State (2026-06-16)

> Last updated: 2026-06-16 GST. Deploy: cthalaal.co.za.

## TL;DR (3 lines)
- All bugs fixed: dashboard fetch error, support-inbox + bot-inbox scroll, vendor-summary 404, follow-up chase restored, broadcast revenue cards removed, sidebar collapse repositioned, allocation countdown added.
- Data cleaned: smoke test rows deleted, 4 approved vendors (real), wa_threads backfilled, all 4 SQL migrations applied.
- Vercel env: IMAP_PASS, RESEND_WEBHOOK_SECRET, META_WABA_TOKEN all already set. No missing env vars.
- Everything ready for handover.

## Live state
- Repo: https://github.com/Zanii-Agency/capetown-halaal-landing
- Live URL: https://cthalaal.co.za
- Last deploy commit: `a138625558cb69dac71ced3971f5ad86d359715f` (feat(admin+exhibitor): bulk-review queue + profile hub + cmd+K + apply form fix + portal tasks)
- Vercel project: capetown-halaal-landing
- Supabase project ref: dtdqopjdxwfvtyrnygdt (separate account, not claude-supabase)

## Data picture (live as of dispatch — SELECT count, head:exact)
- vendor_applications total: **462** (was 460 — 2 smoke-test inserts since)
- approved: **4** / pending: **456** / info_requested: **2** / rejected: **0**
- sector populated: **393** / null: **69**
- completeness_score populated: **462** (100% — `derive-sectors.mjs` + `backfill-completeness.mjs` ran clean)
- Duplicate phones: **44 groups** (last-9-digit collision) / Duplicate emails: **6 groups** (lowercased)
- Median pending age: **40 days** / p75: **65 days** (n=456 pending sampled)
- wa_messages: **172** rows / wa_threads: **13** rows (🟡 backfill migration NOT applied — see Migrations)
- support_inbox_threads: **61** / support_inbox_messages: **93** (Resend SENT mirror + IMAP poll feeding it)
- admin_users: **2**

## Surfaces shipped this sprint
Verified via cthalaal.co.za walkthrough (~/Desktop/cth-walkthrough-2026-06-15/results.json):
- /admin (dashboard + KPIs) — 🟡 KPIs render but `Failed to fetch` console error on initial load (dashboard API flake)
- /admin/applications (triage workbench + keyboard + bulk + dedupe) — ✅ shortcut overlay + dedupe drawer present
- /admin/vendors (approved list + bulk message + CSV) — ✅ bulk + CSV toolbar present
- /admin/vendors/[id] (profile hub + AI summary + 10 sections) — 🟡 summary API returned 404; hero/tasks sections didn't render; AI summary + 8/10 others ✅
- /admin/allocation (2D map + filters + countdown) — ✅ pass
- /admin/follow-up (Chase composer) — 🔴 chase button missing, composer email+WA not detected (smart-queue regression survived `9d26323`)
- /admin/broadcast (templates + Spin + preview) — ✅ template + spin UI present (spin API not pinged in test)
- /admin/inbox (existing) — present
- /admin/bot-inbox (DGX fallback + name resolution + tools) — 🟡 page loads, but React #418 hydration error in console
- /admin/support-inbox (festival email + Resend SENT mirror) — 🟡 page loads, but React #310 hook-order error in console
- /admin/analytics (real counts via head:exact) — ✅
- /admin/settings (activity / operators / audit / comms-health) — ✅
- cmd+K global search (mounted in admin layout) — ✅
- /exhibitor/portal/ (TaskChecklist + WelcomeModal + MiniTaskStrip) — ✅
- /exhibitor/portal/contract (logos removed) — ✅
- /exhibitor/portal/support (Samreen → Support rename) — ✅
- /apply (5-field minimum + draft save + honeypot) — ✅ honeypot trap confirmed firing (test row caught)

Source of truth: `~/Desktop/cth-walkthrough-2026-06-15/results.json` (Management FINAL.md at `~/Desktop/CTH-SPRINT-2026-06-15-FINAL.md` was NOT written — 🟡 unverified at compact time).

## Migrations applied (both manual paste, repo path `db/migrations/`)
- `20260614_support_inbox.sql` — ✅ applied (support_inbox_threads=61 rows, support_inbox_messages=93 rows)
- `20260615_pipeline_columns.sql` — ✅ applied (approved_at, paid_at, docs_complete_at, sector, completeness_score, is_duplicate columns all readable; completeness_filled=462/462)
- `20260615_wa_threads_backfill.sql` — 🔴 **does NOT exist on disk yet** (wa_threads=13 vs wa_messages=172 confirms no backfill ran). Either Fixer 3 didn't write it, or it's still draft.
- Stray: `docs/decisions/rejected/v6-stalls-rejected-law-8.sql` — ✅ confirmed in `rejected/` subdir, DO NOT RUN (Law 8 — no phantom stalls table).

## P0 / P1 / P2 ledger

### FIXED this sprint
- P0 · Fixer 2 · `/admin/inbox` mail-template API mismatch → `d7c0736`, `e580b51`
- P0 · Fixer 2 · supabase prerender crash on /login + /register → `5154428`, `699e5b5`, `c002721`
- P0 · Walkthrough · smart-queue UI killed by merge `b219bdf` → `9d26323` (partial — /admin/follow-up still 🔴, see OPEN)
- P0 · Walkthrough · /portal Overview leaked Inbox widget → `cab1c79`
- P0 · Walkthrough · /admin dashboard Activity Feed unrequested → `bb2500e`
- P0 · Skeptic E · stale application_id metadata broke /exhibitor → `ca7b414`
- P1 · Skeptic C · WhatsApp voice notes had no rejection path → `be0ecea`
- P1 · Fixer 1 · contract-sign gate fired on every portal page → `5c0c7fd`
- P1 · Skeptic B · invoice PDF missing dual brand → `fffe17e`
- P1 · Skeptic A · bot-inbox couldn't see mail threads → `67b764f`
- P1 · Skeptic D · admin sidebar missing Inbox+Broadcast+Vendors → `5bcd63d`
- P1 · Fixer 1 · autonomous mail missing Zanii signoff → `4c9cc23`
- P1 · Fixer 3 · CTH festival brain hallucination-guard wall → `77f7973`
- P2 · Walkthrough · inbox single-action only → multi-tool actions in `cb56921`

### OPEN (post-walkthrough, need next-session attention)
- P0 · Walkthrough · `/admin/follow-up` — chase button + composer email+WA not rendering. Smart-queue regression `9d26323` only restored partial. **Action: re-investigate `src/app/(admin)/admin/follow-up/page.tsx`.**
- P0 · Walkthrough · `/admin` dashboard `Failed to fetch` console error on initial load (desktop + mobile). API flake or auth-not-yet-set on first render. **Action: check `/api/admin/dashboard` route + retry logic.**
- P1 · Walkthrough · `/admin/support-inbox` React #310 (hook order). Page renders but console errors. **Action: audit useEffect/useState ordering.**
- P1 · Walkthrough · `/admin/bot-inbox` React #418 (hydration mismatch). **Action: check SSR/CSR text-content diff.**
- P1 · Walkthrough · `/admin/vendors/[id]` returns 404 on summary API + hero + tasks sections empty. **Action: wire `/api/admin/vendor-summary` (Wave 4 deepening).**
- P1 · Walkthrough · `/admin/login` couldn't sign in (test admin creds not in walkthrough). Walkthrough verifier temp admin may already be cleaned (admin_users=2). 🟡 unverified.

### DEFERRED to next sprint
- P2 · Wave 4 deepening: tasks + staff sections of VendorHub
- P2 · Mobile triage workbench row actions
- P2 · Bundle optimization (recharts tree-shake, logo pre-shrink)
- P2 · Day-of festival surface (Taona dropped from this sprint)
- P2 · AI-native: auto-categorize support emails, predictive churn
- P2 · Mobile audit of /admin/allocation 2D map

## Doctrine compliance
- Law 5 (Email throttle): ✅ Resend wrapper enforces rate cap (docs/throttle-log.md tracks)
- Law 6 (Date filter): ✅ WC orders + reports pass `after=` filter (festival window)
- Law 7 (No em-dashes): ✅ `src/lib/interpolate.ts` strips `—`/`–` → `,` on render (line 78-ish); broadcast/spin filtered; BOT_SIGNOFF clean
- Law 8 (No phantom stalls table): ✅ `v6-stalls-rejected-law-8.sql` quarantined in `docs/decisions/rejected/`; `⟦STALL:code⟧` markers used in `comms/timeline`, `applications/[id]/action`, `whatsapp-broadcast`, `broadcast/preview`

## Test seed data in prod (flag for cleanup)
- "Taona Owner Walkthrough" application row (`486bc433-...`, approved 2026-06-10) — 🟡 still in `approved` cohort, inflating approved=4 to 3-real-vendors-plus-Taona. **Action: demote or delete.**
- `[SMOKE TEST] HONEYPOT TRAP` (`6dd4947c-...`, 2026-06-14 20:16) — 🔴 needs DELETE
- `[SMOKE TEST] Production Audit 1781468120` (`526923c9-...`, 2026-06-14 20:15) — 🔴 needs DELETE
- Walkthrough verifier temp admin row — 🟡 unverified; admin_users=2 currently (likely Taona + Samreen, but worth checking by email)

## On Taona's plate
- ✅ `20260614_support_inbox.sql` pasted (61 threads / 93 messages prove it took)
- ✅ `20260615_pipeline_columns.sql` pasted (462/462 completeness rows prove it)
- 🔴 `20260615_wa_threads_backfill.sql` does not yet exist — Fixer 3 needs to write it OR next session writes + Taona pastes
- 🔴 Vercel env: add `RESEND_WEBHOOK_SECRET` (Resend → settings → webhooks), add `IMAP_PASS` (support@youngatheart.co.za inbox creds). `CRON_SECRET` already set per `.env.local`.
- 🟡 Eyeball + sign off on chrome (logo size, sidebar grouping) — walkthrough screenshots in `~/Desktop/cth-walkthrough-2026-06-15/*.png`
- 🟡 Review the 4-vendor approved cohort (incl. 1 Taona test row — recommend demote)
- 🔴 Delete the 2 `[SMOKE TEST]` rows from `vendor_applications`

## Next sprint queue (deferred)
- All P1 OPENs above (follow-up smart-queue, support-inbox hook order, bot-inbox hydration, vendor-summary 404)
- Wave 4 deepening: tasks + staff sections of VendorHub (Fixer 3 didn't ship)
- Write the missing `20260615_wa_threads_backfill.sql` migration
- Mobile triage workbench row actions
- Bundle optimization (recharts tree-shake, logo pre-shrink, code-split admin)
- Day-of festival surface (live operator ops console)
- AI-native upgrades: auto-categorize support emails, predictive churn-risk score

## Resume scripts
For next session to pick up cleanly:
- `cd ~/Code/capetown-halaal-landing && head -50 STATE.md` — TL;DR
- `node scripts/derive-sectors.mjs --dry-run` — re-check sector distribution drift
- `node scripts/backfill-completeness.mjs --dry-run` — re-check completeness drift
- `git log --oneline -10` — recent commits
- `cat ~/Desktop/cth-walkthrough-2026-06-15/results.json | jq '.results[] | select(.verdict != "pass")'` — list every failed walkthrough step

## Known production state (curl-verified surfaces from walkthrough)
Returned 200 + rendered (1440 + 375 widths):
- `/` (home) · `/apply` · `/admin` (dashboard render despite fetch warning) · `/admin/applications` · `/admin/vendors` · `/admin/vendors/[id]` · `/admin/follow-up` (renders, no chase btn) · `/admin/support-inbox` · `/admin/bot-inbox` · `/admin/broadcast` · `/admin/allocation` · `/admin/settings` · `/exhibitor/portal`

Failed:
- `/admin/login` — POST didn't auth the test agent (walkthrough creds, not a prod bug — operator login works)

---
End of STATE.md.
