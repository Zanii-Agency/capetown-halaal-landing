# CTH Bot — Vendor-Conversation Failure Classes (staged, 2026-07-21)

## FIXED + DEPLOYED 2026-07-21 (commit 8beeb10, live on cthalaal.co.za, HTTP 200)
_tsc clean · eslint clean · 20 tests pass · prod build ok · vercel --prod READY · aliased cthalaal.co.za_
- **Root cause found: the live WhatsApp agent (`vendor-agent.ts`, `CTH_AGENT` on) ran a thin prompt.** All the grounding (31-Aug part-payment policy, documents, stall sizes, allocation timing) lived in `system-prompt.ts` `BASE_PROMPT`/`VENDOR_FACTS`, which only the FAQ path uses. The policy answers existed but never reached vendors. `part-payment.test.ts` asserted them on `BASE_PROMPT` (the wrong prompt), so it passed green while vendors got an ungrounded bot.
- **A — grounded the live agent:** `vendor-agent.ts` now imports `VENDOR_FACTS` (verified vendors only) + the `vendor_part_payment` FAQ answer + a RESOLVE-DON'T-DEFLECT rule. Single-sourced, no policy rewrite. Fixes C-1, C-8, C-5, most of C-4.
- **B — killed self-contradiction (I-2):** `check_application_status` now reads back open `support[]` / pending stall-change / stall-move and tells the vendor "already logged, do not log again." Stops the "no request on file" contradiction and duplicate tickets.
- **C — fixed breadcrumb fragmentation (I-1):** `flagNeedsHuman` writes to `session.waPhone` (the live `+27…` inbound key) instead of the malformed `application.phone` stripped to digits. All 17 historical `[NEEDS_HUMAN]` breadcrumbs were stranded on phantom keys; new ones land on the real thread.
- **Skipped D (mass phone backfill):** 492/541 rows are benign `0…` local format; `normalizePhone`/`toE164` already convert every variant correctly. A 492-row prod write for zero functional gain, not done.
- **Tests:** `src/lib/bot/grounding.test.ts` (6) guards A + B against the wrong-prompt regression.

## Stranded escalations — MIGRATED 2026-07-21 (data fix, no deploy)
- **Correction to the earlier "17/17 stranded" figure:** the Needs You queue keys by `norm(phone) = phone.replace(/^\+/,'')` (strips the `+` only). So the 5 breadcrumbs stored as `27…` (no `+`) already merged with the canonical `+27…` thread and were VISIBLE. Only the 12 on leading-`0`/malformed keys were truly stranded. Measuring raw keys over-counted; the queue's own norm() is the right yardstick.
- **Applied:** re-pointed the 12 stranded breadcrumbs to canonical `+27…` E.164 (update-by-id, guarded on old value, `repointed_from` audit trail, count asserted 12/12, 0 left on non-`27` keys). No code change — they now flow through the already-live queue.
- **Verified against the exact queue formula:** 10 escalations now surface as OPEN (9 rescued vendors + Velvet Crumb already-visible); 2 correctly hidden (Farhan, En Vogue — human replied after). Rescued: Layali Haus + MeeAad (withdrawals), MaterniTee + Amklegend + Flaming Spuds (payment plans), Elegant Muslimah (POP), Islamic Relief, CN Collection (sharing), Sakiena (clothing).
- Final UI confirm: a human glance at cthalaal.co.za/admin/customer-inbox.

## Remaining
- **Open policy (no grounding exists):** discounts/returning-vendor (C-4), stall sharing (C-6), withdrawal/refund for vendors (C-11). The other three (extension=31 Aug, installments=no, EFT=card-only) are answered and now wired.
- **Infra subsystems (not the bot brain):** password-reset email deliverability (C-9), badge-add portal bug (C-10).

---


Grounded in the real corpus: **130 threads, 526 inbound vendor messages, 35 escalation tickets** (`⟦PORTAL⟧.support[]`) + 17 `[NEEDS_HUMAN]` breadcrumbs. Bot has **11 tools** (registry.ts): `get_event_info`, `check_application_status`, `get_payment_status` (live Yoco), `get_invoice`, `get_badge_allocation`, `send_contract`, `get_logo_upload_link`, `request_password_reset`, `request_stall_change`, `escalate_to_human`, `start_verification`.

**The bot is not "dumb" — it punts.** Every failure is the bot hitting `escalate_to_human` (or redirecting to `support@`) because it lacks **authority**, **grounded knowledge**, or a **working downstream**. Three buckets, three different fixes:

- **Bucket P (Policy):** bot lacks authority/policy → decide policy, ground it, give a tool. *Needs Taona's business decision.*
- **Bucket K (Knowledge):** bot lacks a fact it could know → add to FAQ grounding. *Cheap.*
- **Bucket I (Infra broken):** bot correctly escalates because something underneath is broken → fix the infra, not the bot.

Some punts SHOULD stay punts (refund-bearing cancellations). "Bot resolves everything" is the wrong target; "bot resolves everything it has the authority and data to resolve, and escalates cleanly (without contradicting itself) for the rest" is the right one.

---

## ROOT INFRA (fix these first — they poison every class)

### I-1. Phone-key fragmentation — conversations split across `+27…` / `27…` / malformed
- **Evidence:** 273 distinct `wa_phone` keys but **144 have zero inbound** — phantom outbound-only fragments. Every one of the 4 audited vendors had their thread split: e.g. `+27746264537` (22 in / 17 out) vs `27746264537` (0 in / 4 out, holds the approval template + `[NEEDS_HUMAN]` flags). Application phones are also malformed at source (Sakiena stored as `+744520230`, missing the `27`).
- **Impact:** the bot's conversation view and its own escalation breadcrumbs land on a *different key* than the live thread. History is fragmented; vendor↔application linking by phone silently misses.
- **Root cause:** outbound sender and inbound webhook normalise phones differently; the apply form accepts unnormalised numbers.
- **Fix:** one canonical E.164 normaliser at every write (webhook in, sender out, apply form). Backfill-merge existing keys by last-9-digits. Bucket: **I**.

### I-2. The bot is blind to its own escalations → contradicts itself, duplicates tickets
- **Evidence (verified in code):** `escalateToHuman` writes to `state.support[]` (registry.ts:324) but `checkApplicationStatus` (registry.ts:158) only reads `payment / status / contract / stall` — never `support[]`. Live proof: Farhan requested a payment plan (logged), then minutes later the bot told him *"I don't see any payment plan request on file for you, so there's nothing blocking you from paying now."* He re-asked → the bot escalated **again** (duplicate ticket). Same duplicate pattern on En Vogue, Flaming Spuds, CN Collection (all have 2 tickets for one ask).
- **Fix:** `check_application_status` (and the status the bot narrates) must read back open `support[]` items and say *"you have a pending payment-plan request with the team, logged 19 Jul."* Dedupe: `escalate_to_human` should no-op if an open ticket of the same intent exists. Bucket: **I**.

---

## PAYMENT CLASSES

### C-1. Payment plan / partial / installment / deadline extension  ⭐ #1 class
- **Volume:** 9 vendors, ~11 tickets — By Nadz, Chapter 96 Bookz, CellXpress (Farhan), MaterniTee (Raeesa), En Vogue (Abdullah), Flaming Spuds, Amklegend, Islamic Relief, + the flower sisters (discount variant).
- **Bot now:** escalates every time. In-flight work exists (`71ad716 feat(bot): part-payment asks get a personal reply`, `part-payment.test.ts`) — currently gives a warmer reply but still doesn't *resolve*.
- **The team's real answer is consistent** (from Farhan's human reply): *"the payment gateway only accepts full payments, however we can give you until end of August to pay the full amount."* This is a repeatable policy the bot could state itself.
- **Fix:** if end-of-August extension is a blanket grant → ground it + give the bot a `confirm_payment_extension` tool. If case-by-case → bot states the rule ("full amount only, but extensions are possible — I've logged your request") AND shows it back via I-2 so it stops contradicting. Bucket: **P** (needs the policy decision below).
- **Watch:** MaterniTee says *"an organiser already confirmed it's possible"* — vendors are getting verbal promises off-channel the bot can't see.

### C-2. Card/Yoco payment fails → vendor asks for bank details as fallback  ⭐ the real EFT driver
- **Evidence:** En Vogue (Abdullah) — *"having trouble completing card payment via Yoco… asked for bank details as an alternative."* This is WHY "EFT?" keeps recurring: the card path **fails** for some vendors and there is **no alternative offered**, so they reach for a bank transfer.
- **Policy-vs-reality gap:** the bot (correctly, post-fix) says *"card only, no EFT."* But the team **did** accept Sakiena's EFT and manually marked her `paid` (`method: "eft"`). So operationally EFT-by-arrangement exists; the bot's flat "never" is false and dead-ends a stuck vendor.
- **Fix:** decide the true policy (see below). At minimum the bot needs a Yoco-failure recovery path instead of a dead-end. Bucket: **P + I**.

### C-3. Proof-of-payment / status not showing (reconciliation)
- **Evidence:** Elegant Muslimah, Sakiena, Alex's 3D prints — paid (card or EFT) but status shows `none`.
- **Cause:** EFT payments never appear in Yoco (so `get_payment_status`'s live check can't find them); some card payments may not be captured to portal-state. Bot can't reconcile a mismatch → escalates.
- **Fix:** depends on C-2 policy. If EFT stays manual, the bot should recognise "I emailed proof" and route to a *reconciliation* escalation with the right context, not a generic one. Bucket: **P + I**.

### C-4. Pricing discrepancy / discount / returning-vendor
- **Evidence:** Solo Style (saw R5,500 in a Google Doc, was quoted R6,500 — conflicting price sources); the flower sisters (paid less last year, wants R2,000).
- **Fix:** single source of truth for stall pricing that the bot reads (kill the stray Google Doc). Discount policy = a **P** decision (does CTH negotiate returning-vendor pricing? blanket no?). Bucket: **K + P**.

---

## STALL / LOGISTICS CLASSES

### C-5. Stall upgrade / change / appliance (freezer/fridge) declaration
- **Evidence:** Frullato (upgrade to 4×2 for freezers ×3), Sena (undeclared fridge+freezer), Farhan (corner stand).
- **Bot now:** has `request_stall_change` — partially covers it, but often just says "team will review." Appliance/power *declaration* (vs size change) has no clean path.
- **Fix:** extend `request_stall_change` to capture appliance/power needs and confirm the price delta where known. Bucket: **P (pricing) + K**.

### C-6. Stall sharing / collaboration
- **Evidence:** CN Collection ×2 — *"can I share/collaborate a stall with another vendor?"*
- **Bot now:** no policy → escalates. Bucket: **P** (is sharing allowed? one badge set? split fee?).

### C-7. Stall allocation timing / setup logistics
- **Evidence:** 53 Plumtree (paid + signed, not allocated), GLOBAL CUISINE (setup time).
- **Fix:** `get_event_info` should ground allocation timing + setup-day logistics. Allocation itself is human (floor-plan), but "when / what time" is a **K** answer.

### C-8. Documents step (post-payment portal "Documents")
- **Evidence:** Velvet Crumb — bot doesn't know what the portal's own "Documents" step requires; 19 inbound mention documents.
- **Fix:** ground the portal's post-payment document requirements in the FAQ. Pure **K**, cheap, high-frequency.

---

## ACCESS / LIFECYCLE CLASSES

### C-9. Portal access / password-reset email not arriving
- **Evidence:** By Nadz — *"not receiving password reset emails after multiple attempts"* (×2).
- **Cause:** bot has `request_password_reset` (fires fine) but the **email doesn't deliver** (GoDaddy/Resend deliverability). Tool works; downstream broken. Bucket: **I**.

### C-10. Badge / staff — portal won't allow the action
- **Evidence:** KOCO — *"portal won't let her add a 2nd staff badge."*
- **Cause:** portal bug, not a bot gap (bot has read-only `get_badge_allocation`). Bucket: **I** (fix the portal add-badge flow).

### C-11. Cancellation / withdrawal
- **Evidence:** MeeAad (cancel, travel clash), Layali Haus (withdraw, personal).
- **Recommendation:** **keep escalating** (refund/records implications) — but the bot should acknowledge + start a clean withdrawal ticket, not a generic one. Bucket: **P** (define the withdrawal/refund policy so the ticket carries the right next-step).

### C-12. Low-content / greeting over-escalation
- **Evidence:** "Hi" (En Vogue), "hi how are" (Sweet Treats) logged as tickets.
- **Fix:** don't escalate contentless openers; ask a clarifying question first. Bucket: **K/tuning**.

---

## Policy decisions needed from Taona (the forks the bot can't self-decide)

1. **Payment extension:** is "full amount, but until end of August" a **blanket** grant the bot may confirm, or case-by-case (bot states rule + logs)?
2. **Partial/installments:** ever allowed, or always "no, full only"? (Organisers appear to promise it verbally — need one truth.)
3. **EFT:** truly never, or "EFT-by-arrangement when Yoco card fails"? (Reality today = manual EFT accepted. Bot says never. Pick one.)
4. **Discounts / returning-vendor pricing:** negotiable, or fixed R3,700? (flower sisters, Solo Style.)
5. **Stall sharing:** allowed? terms (fee, badges)?
6. **Withdrawal/refund:** what's the policy the withdrawal ticket should carry?

Answer these six and ~70% of the escalations become bot-resolvable (grounding + small tools). The rest are infra fixes (I-1, I-2, C-9, C-10) that are the bot's problem only because something under it is broken.
