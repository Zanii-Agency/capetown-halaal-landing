# Spec 003 — Vendor phone parity ("everything on the portal, on the phone")

Status: PLAN (locked decisions, not yet built). Tier 1.

## Goal
A vendor can do every portal function from WhatsApp. No feature is web-only that
a vendor would reasonably want from their phone.

## The parity rule (the core decision)
Both the portal and the bot call the SAME `lib/` functions — parity is structural,
not duplicated. Each function is reachable on the phone by ONE of two paths:

- **EXECUTE inline (bot does it):** reads + simple scoped writes.
- **DEEP-LINK (bot hands a one-tap pre-authenticated link to the exact page):**
  money / legal / complex-form actions, which complete on the surface built for them.

Decision rationale: nothing relies on fragile chat form-filling, in-chat card
capture, or chat-based legal signatures (the failure/risk modes). Reads reuse
proven generators; simple writes use the audited scoped `updatePortalState`
pattern; risky actions reuse the exact web flow via a deep link.

## Capability map (portal function -> phone path)
EXECUTE inline:
- Overview/status, payment status            (Q&A, already)
- Invoice PDF            -> lib/payments/invoice-pdf.ts -> sendMedia
- Contract PDF           -> lib/contract/render-pdf.ts  -> sendMedia
- Documents status+files -> portal-state + vendor-docs bucket -> sendMedia
- Announcements          -> announcements lib -> text
- Resources (files)      -> resources -> sendMedia
- Marketing images       -> portal/marketing PNG generators -> sendMedia
- Floor map / my stand   -> map image -> sendMedia
- Staff list (view)      -> portal-state.staff -> text
- Profile text edits     (already: update_profile)
- Logo / photo upload    -> media-in (webhook already captures) -> set logo/gallery
- Support note           (already: post_support)
- Notification prefs     -> updatePortalState
- Resend a staff badge   -> staff/resend lib fn

DEEP-LINK (one-tap magic link to the page):
- Pay the fee            -> /portal/payments  (PCI page; already link-style)
- Sign contract          -> /portal/contract  (legal e-sign ceremony)
- Accept terms           -> /portal/terms
- Add staff badge        -> /portal/staff      (multi-field + WooCommerce order/money)
- Stand-change request   -> /portal/stand/change

REMOVED from bot:
- publish/hide stall (mandatory / auto-shown — no vendor toggle)

WEB-only by nature:
- password set/reset (auth ceremony) — but "resend my login link" IS a bot action
- the card-entry payment page itself (covered by the pay deep-link)

## Build phases (each phase ships working + walled)
**Phase 0 — foundations**
- Confirm/extract shared lib fns for: documents, announcements, resources,
  marketing, staff (invoice + contract already lib). No logic left only in routes.
- NEW primitive: `magicDeepLink(applicationId, path)` — short-lived (e.g. 15 min),
  single-use, signed, bound to vendor.id; a verify step logs the vendor in to that
  page. This is the one new AUTH surface -> gets the adversarial skeptic pass
  (TTL, single-use, scope, signature, no widening) before ship.
- Meta: submit ONE UTILITY template `vendor_portal_action` (body var + URL-button
  var) for OUT-OF-SESSION deep-link / "doc ready" notices. In-session sends need
  no template.

**Phase 1 — remove stall toggle + read/fetch suite** (biggest parity win, lowest risk)
- Remove publish/hide stall from vendor-brain (intents, classifier, handler, facts).
- Add scoped read handlers (reply via sendMedia/text): get_invoice, get_contract,
  get_documents, get_announcements, get_resources, get_marketing, get_map,
  get_staff_list, payment_status. Each bound to identity.vendor.id.
- Golden-set eval + walls per handler.

**Phase 2 — simple writes**
- logo/photo from sent image, notification prefs, resend badge. Scoped + idempotent + walls.

**Phase 3 — deep-link handoffs** (money/legal/complex)
- pay, sign contract, accept terms, add-staff, stand-change: bot replies with the
  one-tap magic deep link to the exact page. Bot composes; web completes.

**Phase 4 — onboarding + cleanup**
- Vendor login: one-time walkthrough listing every function + "you can also do all
  of this on WhatsApp." Seen-flag in portal-state (no DDL).
- Remove the admin-portal demo (locate exact artifact at build; not the vendor map-demo).

**Phase 5 — verify + ship**
- /backend-verify (curl) each handler; adversarial skeptic on the magic-link;
  deploy via vercel --prod; soak. ADR for execute-vs-deeplink + the magic-link.

## Isolation / safety (carry-over, non-negotiable)
- Every bot handler hard-bound to identity.vendor.id (the proven wall).
- Deterministic action routing; LLM for understanding only.
- Magic-link: short TTL + single-use + signed + vendor-scoped.
- CTH_VENDOR_ACTIONS flag still gates the whole action surface (instant off).

## DECISION (2026-06-28): Vendor Concierge = a reasoning specialist over a self-scoping toolset
Taona: "be a problem-solver... a specialist that understands what problem must be
solved and what options/tools it has." This AMENDS ADR-004's pure-deterministic
routing. The deterministic handlers deflect ("go to the portal") and can't reason
about compound asks ("send my invoice and what else to complete my booking").

The synthesis (keeps the ADR-004 isolation wall, gains problem-solving):
- A Claude TOOL-USE loop reads the vendor's message + their live state and SOLVES
  the request by choosing tools and composing a reply that actually delivers.
- FIXED toolset; EVERY tool is hard-bound to identity.vendor.id INTERNALLY. The
  model chooses WHICH tool, never supplies a scope key or an id. The isolation
  wall moves to the tool boundary, it is not abandoned. (Mitigates KT #206540:
  the model only selects + composes; the scoped tool does the real work.)
- Tools (reuse what's built + add): send_invoice (PDF, done), send_contract (PDF),
  send_documents, document_checklist, booking_status, payment_link, update_profile,
  leave_note_for_team, get_announcements, resend_login.
- Money / legal / irreversible tools (charge, sign, add-staff-order) stay
  CONFIRM-GATED (stage -> "yes" -> commit). Heavy file sends use the deferred
  after() pattern (already built for the invoice).
- Behind CTH_VENDOR_ACTIONS; new tool-selection surface gets an adversarial
  skeptic pass (can the model be steered to cross-tenant / over-act / leak? must
  be impossible because tools self-scope — verify).

Build order: (1) extract each capability into a scoped tool fn + Anthropic tool
schema; (2) the specialist loop (system prompt: "solve the vendor's problem using
ONLY these tools; never expose ids/scope/lanes"); (3) confirm-gate the dangerous
tools; (4) golden-set eval (right tool fires for realistic messages) + skeptic;
(5) deploy + soak. This is a focused Tier-1 build, NOT a tail-end job — done
properly with its own verify pass.

## Open at build (decide in-flight, non-blocking)
- Exact admin "demo" artifact to remove (locate in Phase 4).
- Whether "mandatory stall" also means defaulting public publish_stall=on for
  confirmed vendors (display-layer change, separate from the bot).
