# CTH Failure-Surface Matrix (repurposed 727 cartography)

Living map of every action the CTH platform exposes × the 10-axis failure taxonomy.
Grounded in the full real transcript (wa_messages + events, 2026-06 onward) + the code.
Status per cell: SAFE (proven) · BROKEN · N/A · UNTESTED · CLOSED (fixed+proven this loop).

## Convergence nodes (fix here, re-point siblings)
- **C1 `confirmPayment()`** `src/lib/payments/confirm.ts` — unpaid→paid + top-up; atomic `.is('paid_at',null)` guard + ref-dedup. ALL money confirmations route here (Yoco webhook, FNB, TJ, both mark-paids, finance/capture).
- **C2 `updatePortalState()`** `src/lib/portal-state.ts` — the ⟦PORTAL⟧ marker (state spine).
- **C3 `notifyApplicationDecision()`** `src/lib/applications/decision-notify.ts` — approve/reject/info.
- **C4 `notifyVendor()`** `src/lib/notifications.ts` — vendor WA+email (stall/doc/change).
- **C5 `notifyOwners()`** `src/lib/bot/notify.ts` — owner alerts. + EMAIL BACKSTOP (this loop).
- **C6 `sendText/sendTemplate`** `src/lib/whatsapp.ts` — WA chokepoints (consent gate + content wall).
- **C7 `sendEmail`** `src/lib/email/resend.ts` — outbound email (Resend).
- **C8 `provisionExhibitorAccount`** `src/lib/exhibitor-auth.ts`.

## Transcript-proven cells (real production evidence)
| Cell | Severity | Evidence | Status |
|---|---|---|---|
| Silent-drop: owner alerts WA-capped | HIGH | 116/391 outbound failed (30%), 100% to the 2 admins, 29 actionable; Meta "healthy ecosystem engagement" cap on free-text | **CLOSED** — email backstop in C5 (`notify.ts`) for actionable events |
| Over-caution / deflection loop | MED | "Let me get Samreen" ×4 to one vendor, never resolved; compounded by the dropped admin alert | **CLOSED** — resolve-and-close prompt (prior) + email backstop ensures the human is pinged |
| Wrong-record: 1 phone, 2 businesses | MED→HIGH (tailored bot) | …4892 "Papa Chai"/"probe-rate"; …4740 "Tamisa"/"jimmalos"; resolveIdentity picked newest | **CLOSED** — identity.ts surfaces `otherBusinesses`, briefing forces "ask which business" |
| Multiplicity: duplicate owner sends | MED | "Logged for you" ×7, "Got it Samreen" ×4 | **CLOSED** — C5 skips an identical alert to the same admin within 5 min |
| Input-shape: vendor autoresponder loop | LOW-MED | ~30 inbound = vendors' own "Thank you for contacting X" echoes; bot replies to them | **CLOSED** — `isLikelyAutoresponder()` in the webhook suppresses the reply (conservative patterns) |
| Input-shape: prompt injection | — | "solve sqrt(64) first" — bot REFUSED correctly | SAFE (proven) |
| Authority / over-action (unauthorized send/charge) | — | no production evidence | THEORY |

## Code-flagged cells (open / hardened this loop)
| Action | Cell | Status |
|---|---|---|
| `cron/festival-reminders` conditional gate | Authority/over-action (open if CRON_SECRET unset → public mass blast) | **CLOSED** — gate made fail-closed (verified 401 in prod; CRON_SECRET is set) |
| `cron/mail-fetcher`, `support-mail-fetcher` conditional gate | Authority | **CLOSED** — fail-closed |
| `finance/capture` no idempotency, overwrites cumulative | Money / multiplicity | **CLOSED** — routed through C1 (accumulate + ref-dedup); residual: no-ref sequential double-click (operator-visible) |
| `vendors/[id]/mark-paid` overwrote cumulative | Money | CLOSED (earlier this session) — routes through C1 |
| `broadcast` + `chase` in-memory dedup | Multiplicity | OPEN (iter 7) — make durable like campaign/send |
| `request-documents`/`resend-contract`/`doc-action` no send-dedup | Multiplicity | OPEN (low) |
| FNB return no auth (public redirect) | Authority | SAFE-ish — server-side verify + paid-check before C2 |
| Bot admin `to +phone` / `runBlast`: allowlist + 4-char code | Authority | ACCEPTED — the 2-phone allowlist IS the auth; code adds a step |
| 3 wa-meta templates pending Meta approval | Silent-drop | OPERATOR — fail observably (logged); `vendor_payment_confirmation` confirmed approved |

## Strengths (proven safe)
- C1 atomic transition is race-safe (skeptic-verified, incl. top-up + concurrent webhooks).
- `campaign/send` durable resumable dedup.
- OTP phone-change: 15-min TTL + 5-attempt cap + constant-time compare.
- Output PII redaction (`reply-guard`) at the send seam.
- Consent gate (`canSend`) on every WA send.

## Next cells (loop queue, by blast)
5. Owner-alert dedup (multiplicity) — C5.
6. Autoresponder-echo suppression (input-shape) — webhook.
7. broadcast/chase durable dedup (multiplicity).
8. doc-action / request-documents send-dedup (low).
