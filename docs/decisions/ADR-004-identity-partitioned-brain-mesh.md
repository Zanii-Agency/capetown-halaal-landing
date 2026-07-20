# ADR-004: Identity-partitioned brain mesh + WhatsApp vendor self-service

- Status: Accepted
- Date: 2026-06-28
- Deciders: Taona (master), Sinan (builder)
- Supersedes: nothing. Builds on ADR-002 (unified inbox bot+mail).

## Context

The WhatsApp webhook (`src/app/api/whatsapp/webhook/route.ts`) is already the
de-facto orchestrator: it resolves the sender with `resolveIdentity(e164)` and
branches by role — admins go to `handleAdminMessage`, everyone else goes to the
read-only `askFestivalBrain`. Today a vendor can only *ask questions*; the
vendor identity briefing literally tells them "Direct portal questions to
cthalaal.co.za/exhibitor/login." A vendor cannot *do* anything (update profile,
post support, manage staff, pay) from WhatsApp — they must log into the web
portal with an email + password they often do not have to hand.

The reference architecture is Sasa (Nisria): an orchestrator → router → 8
isolated specialists → one shared engine. We want CTH to gain the same
multi-brain isolation (vendor / admin / attendee) AND let a vendor control
their own portal from their phone number, scoped to what they are allowed to do.

## The fork

**How does a vendor perform an action (a write) from WhatsApp?**

- **Option A — Agentic tool-loop (Sasa-style `runSasa`).** The LLM is given a
  toolset and decides which tool to call and with what arguments, in a loop.
  Powerful and general. But it places a language model in direct control of a
  money path (stall payment) and a multi-tenant write boundary. A prompt
  injection inside a vendor's free text, or a model that hallucinates an
  `application_id`, becomes a cross-tenant data write. High blast radius.

- **Option B — Deterministic route for the action, grounded LLM for
  understanding. (CHOSEN.)** The LLM only *classifies intent and extracts
  slots*. A deterministic handler executes the action, hard-bound to
  `identity.vendor.id` resolved from the verified WhatsApp number. The model
  never supplies the scope key, never picks the tool that touches the database
  directly with an arbitrary id.

## Decision

1. **Identity-partitioned mesh.** Sasa routes by message *content* (one
   operator, many intents). CTH routes by *who is speaking* (many people, each
   with a fixed scope). `resolveIdentity` IS the router. A thin dispatcher
   `routeToBrain(identity, msg, ctx)` names three brains:
   - `admin`  → admin brain (`handleAdminMessage`, broad org tools) — unchanged.
   - `vendor` → vendor brain (NEW: scoped self-service actions + Q&A fallthrough).
   - `ticket_buyer | unknown` → attendee brain (`askFestivalBrain`, read-only).

2. **Phone→exhibitor identity is the auth.** Possession of the registered
   WhatsApp number is the credential, exactly as possession of the registered
   email is the credential for the web portal. `resolveIdentity(e164).vendor.id`
   is the application_id. Multi-apply ambiguity (one phone, several businesses)
   already forces a disambiguation in `identityBriefing` and gates actions.

3. **Deterministic actions, grounded understanding (Option B).** The vendor
   brain decides QUESTION vs ACTION. Questions fall through to the existing
   `askFestivalBrain` (read-only, already battle-tested). Actions run through
   deterministic handlers, each one:
   - hard-bound to `applicationId = identity.vendor.id` (the **isolation wall** —
     the handler signature does not even accept an id from the caller-supplied
     text);
   - writing through the single `updatePortalState(applicationId, mutate)`
     chokepoint (no new tables — CTH-DOCTRINE Law 8, DDL is blocked);
   - money / irreversible actions (`pay`) **confirm-gated**: the bot stages the
     action and the vendor must reply "yes" before it commits. For v1 the pay
     intent returns the portal payment link rather than charging from chat.

4. **Leakage guard.** Every vendor action asserts the bound id and refuses any
   write whose target id was not derived from the resolved identity. An action
   that cannot bind to a single vendor (multi-apply unresolved) is an honest
   error, never a guess — mirrors Sasa's "no monolith fallback".

## Consequences

- Positive: vendors self-serve from the channel they already use; the
  multi-tenant boundary is enforced by code (id binding) not by prompt
  discipline; reuses `updatePortalState`, `resolveIdentity`, `askFestivalBrain`,
  Haiku — minimal new surface; matches the proven Nisria doctrine.
- Negative: the LLM is NOT free to compose novel multi-step actions; each new
  vendor action is a small deterministic handler we write. Acceptable — the
  action set is small and well-known (profile, support, staff, pay, docs).
- Rollback: the dispatcher falls through to today's behaviour (vendor →
  `askFestivalBrain`) if the action layer is disabled via the
  `CTH_VENDOR_ACTIONS` flag. Zero-risk default-off rollout.

## Build sequence (the loop)

1. Mesh dispatcher + vendor brain with the 3 safest scoped writes
   (update_profile, publish/hide stall, post_support) + walls. **(this iter)**
2. Staff badges + payment intent behind confirm-gate + walls.
3. Formalize admin + attendee brains as named modules; leakage guard tests.
4. Eval set, soak, deploy (`vercel --prod`), live curl proof.
