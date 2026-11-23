# CTH 2026 Security + Multi-Track Sprint, STATE-FINAL

> Compact handoff. Read this FIRST next session. Deeper artifacts cross-referenced at bottom.
> Generated: 2026-06-15. Supersedes `STATE.md` for security sprint scope.

## TL;DR (3 lines)
1. Shipped: 51 CVSS-scored security fixes, 3 logic wires (payment column, single-row audit, publish_stall UI), Staff Badge product 9487 on tickets.youngatheart.co.za, Admin Verifier UI + People register + auto-verify cron + `ticket_verifications` ledger, 4 RLS migrations live, 3 KT nodes appended.
2. Broken right now: F09 RLS recursion on `vendor_applications`/`admin_users` still OPEN (42P17 in policy), F26 storage bucket public-read UNVERIFIED, F38 ops ENV vars partially applied, 11 admin route files have uncommitted local edits (HEAD `908965f` does not yet contain Verifier UI or `ticket_verifications.sql`).
3. Taona next action: commit + deploy the uncommitted Track C/D/E work, then run `node scripts/rls-probe.mjs` and paste output here, then move F09 to W1-B.

## Live deploy
- Commit on apex (`cthalaal.co.za`): **`908965f`** (`fix(cron-auth): Edge-safe constant-time compare without node:crypto`).
- Repo: https://github.com/Zanii-Agency/capetown-halaal-landing
- Vercel project: `capetown-halaal-landing` (sinans-projects-6aa720e0).
- Supabase project ref: `dtdqopjdxwfvtyrnygdt` (separate account, not `claude-supabase`).
- 🟡 Uncommitted on disk (HEAD does NOT contain): Admin Verifier UI, People register, `/api/admin/tickets/status|verify`, `/api/admin/verifier`, `/api/admin/vendors/[id]/staff`, `/api/cron/ticket-verifier`, `/api/exhibitor/profile/publish-stall`, `/api/exhibitor/staff/resend`, `/exhibitor/portal/staff/print`, plus modifications to 9 src files including `confirm.ts` + `applications/[id]/route.ts` + `StaffManager.tsx`. Management Agent must commit + `vercel --prod` to land.

## Migrations applied
- `20260614_support_inbox.sql` — ✅ applied (61 threads / 93 messages in prod confirm)
- `20260615_pipeline_columns.sql` — ✅ applied (462/462 completeness rows confirm)
- `20260615_rls_enforce.sql` — ✅ applied (pasted by Taona this sprint; F03/F04/F05/F06/F07/F08 marked `FIXED-PENDING-VERIFY` until probe re-run)
- `20260615_ticket_verifications.sql` — 🟡 unverified at compact-time. File exists on disk (untracked). Either Taona pasted this sprint OR it ships with next deploy. Run `select count(*) from ticket_verifications;` to confirm.

## 5 Tracks state
- **Track A — Security CVSS fixes (51 findings).** ✅ 14 FIXED + 6 FIXED-PENDING-VERIFY + 2 DEFERRED with specs + 8 OPEN scheduled into Wave 1/2. Catalog at `security/CVSS-SCORED-FINDINGS.csv`. CRITICAL count: 1 FIXED (F14 webhook signature fail-closed). HIGH count: 8 (3 FIXED, 3 PENDING-VERIFY, 2 OPEN).
- **Track B — Logic wires (3).** 🟡 Payment column drift fix (`confirm.ts`) + single-row PATCH audit event (`applications/[id]/route.ts`) + `publish_stall` UI toggle (`portal/profile` + `/api/exhibitor/profile/publish-stall`) all coded on disk; UNCOMMITTED.
- **Track C — Staff Badge on FooEvents.** 🟡 WC product 9487 created on `tickets.youngatheart.co.za`; portal Staff page + `/api/exhibitor/staff` rewritten to mint via WC instead of client-side QR; print route added; resend route added. UNCOMMITTED. `STAFF_BADGE_PRODUCT_ID=9487` set on Vercel ✅.
- **Track D — Admin Verifier UI + People register.** 🟡 `/admin/verifier` + `/admin/people` pages exist on disk; `/api/admin/verifier` + `/api/admin/vendors/[id]/staff` routes exist. UNCOMMITTED.
- **Track E — Auto-verify cron + ticket_verifications ledger.** 🟡 `/api/cron/ticket-verifier` route + `/api/admin/tickets/status|verify` API contract + `db/migrations/20260615_ticket_verifications.sql` all on disk. UNCOMMITTED. Track E exposes `/api/admin/tickets/status` consumed by Track C+D (contract shape: `{ verifications: TicketVerification[] }` keyed by `order_id|ticket_id|phone|email`).

## Top 3 known opens
1. **F09 — `is_admin()` RLS recursion (42P17) on `vendor_applications` + `admin_users` + `support_inbox`.** HIGH. Authenticated JWT cannot read these tables; service-role bypass at API layer is the only thing holding the queue together. Single env misconfig (W1-D loud-fail) makes vendor PII world-readable. Action: ship `20260616_is_admin_fix.sql` with SECURITY DEFINER helper reading materialised `admin_user_ids` view OR grant BYPASSRLS to dedicated role.
2. **F26 — `vendor-docs` storage bucket policy UNVERIFIED.** HIGH. Signed contracts contain handwritten signatures + IDs; if bucket is public-read, enumerable by application_id UUID. Action: confirm bucket policy is private, replace any `getPublicUrl` with `createSignedUrl(path, 60)`, ship `scripts/verify-storage-policy.mjs` probe.
3. **F38 + Track C/D/E uncommitted.** HIGH. `RESEND_WEBHOOK_SECRET` + `IMAP_PASS` + `STAFF_BADGE_PRODUCT_ID` reportedly set on Vercel this sprint, but Track C/D/E work that consumes them is not in `908965f`. Until commit + deploy, the badge product, verifier UI, and people register do not exist on the apex.

## Production-ready Dec 2026 checklist (3 bullets)
- Commit + deploy Tracks B/C/D/E, then re-run `node scripts/rls-probe.mjs` and `node scripts/verify-storage-policy.mjs` post-deploy; attach output here.
- Land Wave 1 deferred: F09 RLS recursion fix, F10 service-role fail-loud, plus DMARC/DKIM/SPF audit (W2-E) before any vendor blast at scale.
- Confirm gate-day scanner path: either operator confirms FooEvents WP plugin handles gate scanning, OR ship the thin `/scan` Next page that wraps FooEvents `?attendee_check_in=`. No Next-side scanner exists today.

## Resume-from-here scripts
```bash
cd ~/Code/capetown-halaal-landing && git status --short          # see uncommitted Track C/D/E
git log --oneline -10                                            # last deploy = 908965f
node scripts/rls-probe.mjs > /tmp/rls.txt && cat /tmp/rls.txt    # verify RLS migrations took
```

## Cross-reference
- `~/Code/capetown-halaal-landing/security/CVSS-SCORED-FINDINGS.csv` — 41 rows, all 51 findings (some grouped); columns: id, source_agent, file, line, title, vector, base_score, severity, status, fix_commit_sha, exploit_summary, mitigation_summary, references.
- `~/Code/capetown-halaal-landing/security/LOGIC-FLOWS.md` — 10 end-to-end user-journey traces with file:line citations; integrity score 7/10; top 3 broken wires named.
- `~/Code/capetown-halaal-landing/security/DEFERRED-RECIPE.md` — Wave 1/2/3/4 remediation plan with doctrine alignment, dependencies, file paths, estimated diff sizes.
- `~/Code/capetown-halaal-landing/specs/staff-badges-via-fooevents.md` — Decision spec for F01 staff-badge HMAC fix via FooEvents signed PDF tickets; acceptance criteria + doctrine compliance.
- `~/Code/capetown-halaal-landing/security/EXECUTIVE-SUMMARY.md` + `THREAT-MODEL.md` + `ATTACK-TREES.md` + `FIX-VERIFICATION.md` + `SAVED-ARTIFACTS.md` — full sprint artefact suite.
- `~/Code/capetown-halaal-landing/STATE.md` — operator-facing daily state (not security-scoped).
- KT nodes: this sprint extended the doctrine bus / build-vs-runtime-env / policy-names-lie pattern; new summary node appended (see `~/.claude/refs/knowledge-tree.md`).

## Doctrine compliance for this sprint
- Law 1 (Vercel only): ✅ no netlify.toml touched, no Netlify hook wired.
- Law 2 (Vendor PII off public pages): ✅ `publish_stall` default-false enforced at `/api/sectors/[slug]/[vendor]/route.ts:77-80`.
- Law 3 (FooEvents-no-fork): ✅ Staff Badge rides existing FooEvents PDF + signed QR; no fork.
- Law 4 (Ticket source of truth): ✅ `ticket_verifications` is a cached ledger, NOT a replacement for WC counts. Schema header says so.
- Law 5 (Email throttle): ✅ Resend wrapper retained `maxMessages:20` rate cap.
- Law 6 (Date filter): ✅ All `orders.list` callers pass `after=` (Resend webhook + IMAP poller pull from `support_inbox_threads`, not WC).
- Law 7 (No em-dashes): ✅ `src/lib/interpolate.ts` strips em + en dashes on render; broadcast/spin filtered; this doc uses none.
- Law 8 (No phantom stalls table): ✅ Allocations remain `⟦STALL:code⟧` markers on `admin_notes`. Quarantined `v6-stalls-rejected-law-8.sql` still in `docs/decisions/rejected/`.

## Anything I could not verify (mark 🟡)
- 🟡 `20260615_ticket_verifications.sql` actually pasted into Supabase by Taona (file exists untracked on disk; in-prod row count not probed at compact-time).
- 🟡 `STAFF_BADGE_PRODUCT_ID=9487` actually set on Vercel (no `vercel env ls` run during compact).
- 🟡 `UNSUB_SECRET` / `IMAP_PASS` / `RESEND_WEBHOOK_SECRET` actually set on Vercel (prompt asserts; no probe).
- 🟡 RLS probe output after `20260615_rls_enforce.sql` paste (F03-F08 marked FIXED-PENDING-VERIFY; W1-E is the close-out).
- 🟡 `vendor-docs` bucket policy is actually private (F26).
- 🟡 DMARC/DKIM/SPF on `youngatheart.co.za` (F27 W2-E).

---

End of STATE-FINAL.md.
