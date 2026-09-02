# ADR-005: Owner-scoped Claude channel as a remote MCP over the existing admin routes

Date: 2026-09-02. Status: accepted.

## Context

The festival owner wants her own Claude account to answer the inbox, chase vendors on WhatsApp and email, and check portal data. Non-negotiable: the covert master lane (EFT vendors, the ...191 account, `collected` state) stays invisible to her, as it is in the portal today.

The wall is not in the database. It is in ~119 admin route handlers, keyed on the viewer's email via the cookie session client (`createClient().auth.getUser()` -> `isEftAdmin` / `laneScopeFor` / `hidesEftContent`).

## Decision

1. A remote MCP server at `POST /api/mcp/<token>` (stateless Streamable HTTP JSON-RPC, hand-rolled, no new deps).
2. The token names one `admin_users` row (HMAC of the user id under `ADMIN_API_TOKEN_SECRET`, no table).
3. Each tool invokes the existing route handler function directly, under an AsyncLocalStorage actor that `createClient()` consults before cookies. The route, RBAC and wall code are untouched; the caller is literally that person's browser identity.
4. Fixed tool table; no EFT / mark-paid / settle / reconcile route is importable from it. `scripts/verify-mcp-seal.mts` probes the owner and master tokens against the canonical `laneScopeFor` rule.

## Alternatives rejected

- **Give her Gmail / WhatsApp connectors and DB access directly.** Bypasses the wall entirely: emailed proofs of payment land in the support mailbox and the DB rows carry the EFT markers in `admin_notes`. Every wall would have to be rebuilt in a second place (KT #97/#101/#103 same-node rule).
- **MCP that re-implements queries against Supabase with its own filtering.** Same failure: a second copy of a 20-function wall that drifts.
- **Internal HTTP proxy to `/api/admin/*` with a bearer header honoured by `createClient()`.** Works, but adds a network hop through Vercel's deployment URL (deployment protection, host ambiguity) and a header path that every admin route would then accept. Direct handler invocation keeps the token useless anywhere except `/api/mcp`.
- **OAuth 2.1 server so claude.ai shows a login.** Correct long-term, weeks of work for four admins. Claude's custom connector accepts a bare URL; the URL is the credential.
- **`admin_api_tokens` table with per-token revoke and last_used.** Deferred: revoke-by-row and rotate-all cover four people. Add when the holder count grows.

## Consequences

- Any new admin route is automatically token-capable the moment it is added to the tool table, and automatically walled the same way its browser twin is.
- The three admin routes that query through the cookie client (`stall-changes`, `sales`, `broadcast/revenue`) would run as anon under a token; they are not in the table.
- Token in URL: it appears in Vercel request logs. Acceptable for this population; rotate the secret if a log is ever shared.
- Reversible: delete the route file and the four lines in `supabase/server.ts`.
