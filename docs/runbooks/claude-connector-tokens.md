# Runbook: Claude connector tokens (/api/mcp)

Owner-scoped remote MCP channel. Code: `src/lib/admin-actor.ts`, `src/app/api/mcp/[token]/route.ts`. Decision: ADR-005.

## Issue a link

```bash
node --env-file=.env.local --import tsx scripts/mint-admin-api-token.mts capetownhalaal@gmail.com
```

Prints `https://cthalaal.co.za/api/mcp/cth_...`. Hand it over on a private channel (WhatsApp to her own number, not a group). The same email always mints the same link while the secret is unchanged, so re-run it to recover a lost one.

`.env.local` must carry the SAME `ADMIN_API_TOKEN_SECRET` as Vercel production, otherwise the minted link is dead on prod.

## Who can hold one

Anyone with an `admin_users` row. The actor's email is what every wall keys on:
`isEftAdmin` / `laneScopeFor` / `hidesEftContent` read it exactly as they read a browser session. So a token for the festival owner is walled, a token for `taona@cthalaal.co.za` is not. Never mint for an address you would not log in as.

## Revoke

- One person: delete (or re-key) their `admin_users` row. The token resolves to nothing on the next call.
- Everyone: rotate the secret, then re-mint for whoever still needs one.

```bash
vercel env rm ADMIN_API_TOKEN_SECRET production
openssl rand -base64 48 | tr -d '\n' | vercel env add ADMIN_API_TOKEN_SECRET production
vercel deploy --prod
```

Then update `.env.local` to match.

## Verify the seal (after every deploy touching the wall or the channel)

```bash
node --env-file=.env.local --import tsx scripts/verify-mcp-seal.mts https://cthalaal.co.za
```

Exit 0 = SEAL HOLDS. Exit 1 lists every vendor the owner could read that the canonical rule says she must not.

## Surface

The tool table in the route file is the whole surface. No `/api/admin/eft*`, no mark-paid, no settle, no reconcile. Adding a tool = adding a row there; the seal script fails on any tool whose name matches eft/master/settle/reconcile/mark-paid.
