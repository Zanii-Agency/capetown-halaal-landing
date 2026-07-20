# CTH — Master Resolve Loop

> Paste the **LAUNCH PROMPT** below into a session as `/loop <prompt>` (self-paced) to drive
> the whole stack to green. The loop fixes a batch, verifies it live, re-sweeps for new issues,
> and only stops when two consecutive re-sweeps come back empty.
>
> Single-driver rule (CTH-DOCTRINE Law 1): exactly ONE session runs this loop at a time.

---

## LAUNCH PROMPT  (this is the `/loop` input — self-contained)

```
Resolve the CTH whole-stack sweep to green, autonomously, until a clean re-sweep is dry.

REPO: ~/Code/capetown-halaal-landing  · BRANCH: inbox-master-unification  · DEPLOY: vercel --prod (Law 1, one driver) · LIVE: https://cthalaal.co.za

MISSION: drive every finding in BACKLOG to ✅ verified-live, then re-sweep; new findings become the next batch; stop only when two consecutive re-sweeps surface nothing new.

RULES (non-negotiable):
- CTH-DOCTRINE 8 laws apply (vercel-only deploy; vendor PII off public pages; no FooEvents fork; WooCommerce is ticket truth; Resend for blasts; every orders.list passes after=; NO em-dashes in vendor-facing copy; stall state = ⟦…⟧ markers on admin_notes, no DDL via app).
- CLAIM WORDS: "fixed" only with PROOF (curl→200 / DB query / browser screenshot). Build-green is NOT fixed. Never fake a zero on error.
- PARALLELISM: fan out agents ONLY on DISJOINT file sets (one lane per file-group), edit-only (no build/deploy inside agents). Integrate + verify centrally.
- SKEPTIC GATE: any risky/irreversible fix (auth/RBAC, money, notifications, RLS/DDL, multi-tenant) gets an adversarial skeptic agent (refute, not approve) BEFORE deploy.
- VERIFY BAR per fix: tsc --noEmit clean · npm run build green · eslint introduces 0 NEW errors (pre-existing OK, note them) · a LIVE proof on cthalaal.co.za.
- LEDGER: after each wave that holds, update ~/.claude/refs/trees/cth/02-capability.md (badge ✅/🟡/🔴/🟠/🔒 + file:line + proof) and add a knowledge-tree node.

BACKLOG (verified by the 2026-06-22 5-agent sweep; fix in this order):

WAVE A — 🔴 critical (small, localized):
A1 Broadcast targets wrong audience. whatsapp-broadcast.ts:199-200 + broadcast/preview.ts:95-96 filter on ⟦PAID⟧/⟦CONTRACT_SIGNED⟧ markers that NOTHING writes. Point those filters at the real source: payment_status/paid_at + PortalState.payment.status (confirm.ts:147-152) and contract_signed_at column. Verify the audience count changes correctly per filter.
A2 Auth fails OPEN. admin-rbac.ts:35 getRole() defaults null role -> 'operator'. Return null; require explicit allow at call sites. AND add assertRole(['owner','operator']) to the 6 under-gated routes: inbox/unified/status, inbox/unified/handover, inbox/unified/notes, vendors/[id]/staff/[memberId]/resend, applications/[id]/request-documents, applications/send-delay-notice (admin path). Skeptic-gate this one.
A3 Admin can't approve/reject docs. api/admin/vendors/[id]/doc-action has ZERO UI callers -> wire approve/reject buttons into the documents UI (DocumentsClient / Vendor360 doc rows). Fix the doc-type fracture: upload ALLOWED uses halaal_cert; admin required-set checks halal_cert + types the portal can't upload -> reconcile to ONE taxonomy so ⟦DOCS:complete⟧ can fire. Add gas_cert to the upload ALLOWED list (UI offers it, route 400s it).
A4 notifyVendor WhatsApp silently fails. lib/notifications.ts sends template names stall_allocated / document_approved / document_rejected NOT in the Meta registry (lib/templates/wa-meta.ts only has vendor_* names). Align to real approved template names (or add them), so the WA leg stops 400-ing into a swallowed catch.
A5 Bot signs off on EVERY message. festival-brain.ts:115 queries wa_messages.eq('wa_id', …) but the column is wa_phone -> errors -> always "first contact" -> ZANII signoff every turn. Fix the column; verify brain_escalations insert (festival-brain.ts:143) isn't also writing a nonexistent wa_id.
A6 Vendor Resources 404. resources/page.tsx links 4 PDFs to /api/exhibitor/resources/* (route + files do not exist) and ships placeholder phones (+27 76 000 0000). Either build the resource files/route or remove the dead links; replace placeholder phones with the real support number.

WAVE B — 🟡 important:
B1 Multi-booth "you are here": api/exhibitor/map returns mine as a single code; make it multi-aware like api/exhibitor/placement so multi-booth vendors see all their booths.
B2 Activity-feed split: global feed reads site_events; vendor lifecycle writes vendor_application_events. Decide one of: dual-write the key lifecycle events to site_events, or have the global feed union both. (Architecture call — surface options.)
B3 Law-6 drift: contacts/resolve.ts:159-162 hardcodes after=currentYear-1 instead of FESTIVAL_CYCLE_AFTER. Use the central festival-cycle constant.
B4 Payment webhook idempotency: confirm.ts side-effects (email/WA/owner-notify) aren't gated on the atomic paid_at IS NULL result -> can double-send. Gate notifications on the guard's affected-row result.
B5 STOP regex over-triggers: wa-consent.ts:190 opts out on cancel/end/quit anywhere in the body. Narrow to whole-trimmed-body or drop cancel/end/quit.
B6 WhatsApp media expiry: inbound media id (~1h TTL) is fetched on demand -> old attachments 404. Capture bytes to Supabase Storage at receipt; serve from there.
B7 Apply completeness scorer penalizes 100%: socials live in special_requirements.social_media but the scorer reads top-level instagram/facebook/website. Read the real path.

DECISIONS — surface to the operator, do NOT guess (one AskUserQuestion batch):
D1 Finance Paid-default: operator asked for Paid-first; an agent flags it hides pending cash flow. Keep, or default to All/Pending?
D2 dev:true developer routing (global doctrine) is absent in CTH. Add the dev reroute + skip-persist + [DEV] prefix, or skip for CTH?
D3 Announcements gated behind requirePaid: unpaid vendors miss org updates. Intended, or ungate?

PROCEED with the MASTER LOOP below.
```

---

## MASTER LOOP  (the control flow each /loop tick runs)

```
state: BACKLOG (above) with per-item status [todo | building | verifying | ✅live | ❌blocked]
       DRY_SWEEPS = 0

each iteration:
1. PICK the next batch: the lowest-wave todo items whose files are mutually DISJOINT.
   - If WAVE A has todos, batch those first. Then B. Decisions (D*) are one AskUserQuestion batch, asked once, before the work they gate.

2. FAN OUT one agent per disjoint file-group (edit-only; no build/deploy in-agent).
   - Each agent: read current state, fix only its lane, follow existing patterns, return file:line + risk/assumption.

3. INTEGRATE centrally: npx tsc --noEmit  → npm run build → eslint changed files.
   - Fix integration errors yourself. Pre-existing lint errors: leave + note. New errors: fix.

4. SKEPTIC GATE (only for risky items: auth/RBAC, money, notifications, RLS/DDL):
   - spawn an adversarial agent told to REFUTE the fix (find how it breaks / who it locks out / what it double-sends).
   - if it finds a real hole, loop back to step 2 for that item. Do NOT deploy a risky fix unrefuted.

5. SHIP: git commit (conventional, no em-dash) → vercel --prod --yes → wait READY.

6. PROVE LIVE (this is what flips an item to ✅, nothing else):
   - public route → curl→200; gated route → curl 401/redirect is correct; data fix → DB query via mgmt API (claude-supabase token) ; UI/behavior → browse screenshot or a live bot/curl call returning the new behavior.
   - if proof fails → status ❌blocked, investigate, do not claim fixed.

7. LEDGER: update ~/.claude/refs/trees/cth/02-capability.md badges + proof; add a KT node for the wave.

8. RE-SWEEP (the anti-green-gate step, KT #343): re-run the read-only audit agent(s) on the SURFACES this wave touched (and one full-stack pass at the end of each wave). 
   - any NEW finding → append to BACKLOG as todo. 
   - if the re-sweep returns nothing new AND all BACKLOG items are ✅live: DRY_SWEEPS += 1. else DRY_SWEEPS = 0.

9. STOP when DRY_SWEEPS == 2 (two consecutive clean re-sweeps with an all-green backlog).
   - final: one report (what shipped, proofs, residual decisions), PushNotification the outcome, log the closing KT node. Omit the next ScheduleWakeup.
   else: ScheduleWakeup (or continue same turn if budget) and repeat.
```

### Why this shape
- **Disjoint-file fan-out** = parallel speed without clobber (proven across this session's waves).
- **Skeptic-before-ship** on risky lanes catches fail-open auth / double-sends before they hit prod.
- **Prove-live before ✅** keeps "fixed" honest (claim-words discipline).
- **Re-sweep-until-2-dry** is the load-bearing part: fixes hide bugs and the act of fixing creates new seams, so a single green pass is not "done" — only a stable empty audit is. (KT #343: a green 67-seam gate hid ~28 live bugs.)
