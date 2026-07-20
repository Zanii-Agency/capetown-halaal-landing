# Cape Town Halaal 2026

The festival website and vendor portal layer for Cape Town Halaal / Young at Heart 2026. Two domains, one Next.js app, FooEvents for ticketing on WordPress upstream.

Stack: Next.js App Router, TypeScript, Vercel (deploy target), Supabase (vendor portal), WooCommerce + FooEvents (ticket source of truth), GoDaddy SMTP (vendor email), public stalls.json for the map.

Mission: ship the 2026 festival site at cthalaal.co.za and youngatheart.co.za, run the vendor application + portal layer on top of FooEvents without rebuilding what FooEvents already does for free, and never break the ticket purchase path.

## The doctrine governs everything

This project obeys CTH-DOCTRINE (the eight laws below). Before any change, read the laws that touch your surface. After any change, verify against them. No "done" without proof attached.

## The eight laws

1. Deploy-target law. This project ships through `vercel --prod` from the project root, on the configured Vercel project (capetown-halaal-landing). The stray netlify.toml and .netlify folder in the repo are a red herring left over from an earlier attempt; never run netlify deploy, never link a Netlify site, never wire a Netlify hook. One repo, one Vercel project, one driver. If a session smells like a parallel driver is open, stop and confirm.

   The production deploy branch is `feat/inbox-needs-you`, not `main`. Production ships from that branch and `main` catches up afterwards by PR. NEVER delete that branch when merging: it is what production deploys from and what other sessions are working on. Merge with the branch retained, every time, including when a merge UI offers to tidy it up.

   `vercel --prod` uploads the WORKING TREE, not the committed state, so `git status` is a deploy manifest. Every dirty file ships. A dirty uncommitted file goes live while existing in no commit at all, which is how production served 135 lines that were in no commit for hours on 2026-07-20. Commit before deploying, and read the tree first. Before excluding someone else's dirty files from a deploy, check whether they are already live: excluding live-but-uncommitted code is a silent rollback that looks identical to a clean deploy.

   Record the SHA you tested and diff it against the SHA you push. In a shared checkout HEAD moves under you, and a green gate on a commit that is no longer HEAD is an untested deploy wearing a passing badge. Bracket a deploy with `git rev-parse HEAD` before and after to prove the tree stayed still.

   Worktrees build and test, they never ship. Run `scripts/provision-worktree.sh` after creating one. A worktree checks out tracked files only, and everything needed to run here is gitignored (`.env.local`, `.env.production.local`, `node_modules`, `.vercel`), so an unprovisioned worktree is inert and its session will quietly fall back to the main checkout, putting two drivers on one tree. A worktree with no `.vercel` does not fail on `vercel --prod`, it silently creates a NEW Vercel project and deploys there.

2. Vendor-data-privacy law. Vendor names, phone numbers, addresses, stall codes, payment status, and admin notes never leak to public pages. Public pages render only what the vendor has marked public (logo, brand name, category, allocated stall code if and only if the vendor's status is confirmed). All other vendor reads go through an authenticated server context or RLS.

3. FooEvents-no-fork law. FooEvents charges 0% on this build. Do not rebuild ticket purchase, ticket delivery, attendee records, or PDF tickets. Layer on top through reads from WooCommerce or the FooEvents PDF theme path. If a feature requires forking FooEvents to ship, stop and surface the tradeoff to the operator before writing code.

4. Ticket-source-of-truth law. WooCommerce orders + FooEvents attendee records are canonical for tickets sold, attendees registered, and ticket PDFs. Halo never stores a duplicated ticket count. Any dashboard counter reads from the WC API at request time or from a clearly labeled cached snapshot with a fetched_at timestamp.

5. Email-throttle law. GoDaddy SMTP throttles aggressively. Every batch send uses maxMessages: 20 to recycle the SMTP connection. Every batch send is idempotent, resumable, and logs sent + remaining. If a throttle hit occurs, append the incident (date, batch, count, mitigation) to docs/throttle-log.md. Resend is the preferred outbound channel for vendor blasts; GoDaddy SMTP is for confirmation emails only.

6. Date-filter law. WooCommerce orders API returns all-time orders by default. Every orders.list call in this codebase passes the `after=` date filter scoped to the current festival year (2026 cycle). A call without `after=` is a defect. The doctrine-reviewer blocks any new caller missing this filter.

7. No-em-dashes law. Every vendor-facing email, every confirmation, every web copy string, every CMS field uses commas, periods, colons. No em-dashes. No en-dashes used as sentence breaks. LLM-generated copy is filtered or re-prompted before send.

8. Stall-allocation law. Allocations are stored as `⟦STALL:code⟧` markers on vendor_applications.admin_notes. There is no stalls table in this Supabase project, and DDL is blocked because the CTH Supabase lives on a different account. Never introduce a phantom stalls table in code that assumes DDL access. The map renders from /public/stalls.json. Allocation conflicts (two vendors on one code) surface as an over-confirm guard alert.

## The canonical files

CTH-DOCTRINE in this CLAUDE.md (the constitution).
package.json (deploy target, scripts).
vercel.json or Vercel project settings (the only deploy contract).
scripts/provision-worktree.sh (run after creating any worktree; without it the worktree cannot build).
public/stalls.json (the map).
docs/throttle-log.md (append on every SMTP throttle incident).
lib/woocommerce.ts (every WC call here; date-filter enforced at this layer).
lib/email.ts (sender, throttle, maxMessages config).
app/portal/ (authenticated vendor surfaces; RLS contract).
.env.local and Vercel env (the secret map, never committed).

## How to work

Each module gets its own CLAUDE.md when it grows past a single file (lib/CLAUDE.md, app/portal/CLAUDE.md, etc.). Load only what you need. Invoke the doctrine-reviewer sub-agent before claiming done.

## Hard rules at this layer

Deploy through `vercel --prod` only, from `feat/inbox-needs-you`, never deleting that branch on merge. Commit before deploying: the working tree is what ships. Ignore the netlify.toml. Vendor PII off public pages. Do not fork FooEvents. WooCommerce wins for tickets. Email batches use maxMessages: 20 and log throttle hits. Every orders.list call uses `after=`. No em-dashes anywhere vendor-facing. Stall codes only as markers on admin_notes; no phantom DDL.

## When in doubt

Read the law. Run the doctrine-reviewer. Confirm the deploy target. Confirm the WC date filter. Show proof. If a law seems wrong, write an ADR proposing the change. Do not silently violate.
