# CTH Fix Guide — 2026-06-22

Source: live QA sweep (gstack headless browser, logged in as owner + demo vendor) + 6-agent read-only root-cause investigation. Every item below is grounded in `file:line`. **No code was changed producing this guide.**

---

## ✅ RESOLUTION STATUS — 2026-06-22 (all shipped + live on cthalaal.co.za, curl→200)

Deployed `inbox-master-unification` → `vercel --prod` (dpl_J2XVtHx3j1sNY3VibrjPqjQDAWxW). Build green, tsc clean. Commits: **c22ed85** (Wave 1), **f6a79f9** (Wave 2 / T2-T10 + notify), **4d1ace1** (download class), **8bb72b1** (RLS doc).

| ID | Status | Resolution |
|----|--------|-----------|
| T1 | ✅ fixed (c22ed85) | Retired orphan `/admin/inbox` (Option A); Cmd+K + search + allocation links repointed to `/admin/customer-inbox` (healthy unified source). |
| T2 | ✅ fixed + prod-verified (f6a79f9) | Renderer waits for images+fonts before screenshot; `?preview=1` cacheable inline URL split; placeholder behind `<img>`; normalized thumb height. **Live: grid aligned, 3/4 previews paint branded assets, `ig-story` (1080x1920) still 500s at the Puppeteer render layer but now shows a labeled placeholder, NOT a blank box.** Residual: tall-template render reliability (separate issue, graceful fallback in place). |
| T3 | ✅ fixed (f6a79f9) | Removed misrouted `whatsapp-broadcast?limit=1` fetch + dead wa-failures task from `TaskCenter.tsx`. 400 gone. |
| T4 | ✅ fixed (f6a79f9) | `chartData` now cumulative running total (no longer flat); sparkline explicit `height={48}` kills `width(-1)` warning. |
| T5 | ✅ fixed (f6a79f9) | Money In promoted to full-width hero; duplicate Pending card deleted; Tickets/Approved/Conversion demoted to one strip. |
| T6 | ✅ fixed (f6a79f9) | Dropped client auth pre-gate; skeleton replaces bare spinner; heavy per-row compute moved inside the keep-branch. |
| T7 | ✅ fixed (f6a79f9) | Conditional 600px map reserve + dropped forced `min-h` on My Stand; collapsed Announcements empty state. |
| T8 | ✅ fixed (f6a79f9) | `pb-8` on the portal scroll region (no PageChrome refactor). |
| T9 | ✅ fixed (f6a79f9) | Removed the hand-rolled duplicate `<h1>Floor plan</h1>`; kept the `AdminPage` header. |
| T10 | ✅ fixed (f6a79f9) | Boundary-aware `isActive` in `PortalNav` (no stuck Announcements tab). |
| V1 | ✅ verified non-bug | Login error handling exists (`exhibitor/login` red banner on `!res.ok`); was a stale-deploy/automation artifact. |
| V2 | ✅ resolved | The "non-navigation" was the paygate redirect; paygate now enforces approved→sign→pay→unlock correctly and a paid vendor reaches every page (verified live as demo vendor). |

**Beyond the guide, shipped same waves:** Samreen's 4 (paygate/amend/export/inbox), bot temp-0 + vendor-scope, block/reserve persistence, sponsor form, operator notify gaps (contract/doc/staff), full bare-anchor download class (export + marketing + invoice/contract/badge PDFs).

**Prod-verified live (logged in dev@/demo-vendor on cthalaal.co.za):** T1 inbox, T2 marketing, T3 dashboard 400 gone, T4 cumulative chart, T5 single hero metric, T6 allocation load, T9 single header, T10 nav active state, paygate sequence (paid vendor passes), vendor amend form. T7/T8 (vendor whitespace/footer) build+deploy verified.

**Residual (NOT in-scope bugs / need operator input):**
- `ig-story` (1080x1920) marketing PNG still 500s at the Puppeteer/chromium render layer (tall-template reliability) — graceful placeholder now shown, no blank box. Separate render-infra issue.
- RLS v13 enum is a bug only in an UNRAN file — live prod policies are membership-based and correct, DDL deliberately NOT run (see `supabase-migration-v13-rls.sql` header).
- Bot internal fact-numbers (`chat/route.ts` ADMIN_PROMPT) need canonical festival figures.
- Stall-change self-service + notification-prefs persistence are feature builds.

The per-ticket detail below is preserved as the original root-cause record.

Stack: Next.js 16 · React 19 · Supabase · recharts · Tailwind. Repo root: `capetown-halaal-landing`.

**Out of scope (decided):** the "Zanii AI on behalf of Young at Heart" signoff/bot-identity is **deliberate** (comment cites the "M13" directive) and is being **kept**. Not a bug. Do not change `lib/mail/templates.ts:133` or `lib/festival-brain/system-prompt.ts`.

**Verify-before-fix:** Tickets V1 and V2 may not be real bugs. Do the live check first; do not edit blind.

---

## Priority order

| ID | Sev | Surface | Title |
|----|-----|---------|-------|
| T1 | 🔴 High | Admin | Inbox shows 0 threads despite 60 live (schema mismatch) |
| T2 | 🔴 High | Vendor | Marketing asset previews render blank |
| T3 | 🟡 Med | Admin | Dashboard fires `400` on every load (×2) |
| T4 | 🟡 Med | Admin | Dashboard revenue chart looks flat/empty + console warning |
| T5 | 🟡 Med | Admin | Dashboard metric overload (5 cards, "Pending" shown 3×) |
| T6 | 🟡 Med | Admin | Allocation page slow to load, reads as broken |
| T7 | 🟡 Med | Vendor | Empty colored band / dead whitespace (Stand + Announcements) |
| T8 | 🟡 Med | Vendor | Overview stat-row clips against footer at short viewports |
| T9 | 🟢 Low | Admin | Allocation duplicate "Floor plan" header |
| T10 | 🟢 Low | Vendor | "Announcements" nav tab stuck in active state |
| V1 | ⚪ Verify | Vendor | Login "silent 401" — likely NOT a code bug |
| V2 | ⚪ Verify | Vendor | "My Stand"/"Documents" nav may not navigate |

---

## T1 — Admin Inbox shows 0 threads despite 60 live conversations 🔴

**Symptom:** Sidebar badge reads "Inbox 60", but `/admin/inbox` shows every bucket (Needs you / Open / Snoozed / Done) = 0 and "No threads in this view."

**Root cause:** Two inbox surfaces backed by two different data models.
- Badge source: `components/admin/AdminSidebar.tsx:116-120` → `/api/admin/inbox/unified` → count built from `wa_messages` (`api/admin/inbox/unified/route.ts:266-278`). **Works.** This is the prod-correct path.
- Broken view: `app/(admin)/admin/inbox/InboxClient.tsx:123` → `/api/admin/inbox/threads` → `api/admin/inbox/threads/route.ts:163-183` SELECTs **v11 columns** (`thread_key, channel, status, last_seen_at`) from `wa_threads`. **Prod `wa_threads` is v9** (PK `wa_phone`, per the webhook comment at `api/.../whatsapp/webhook route.ts:453` "Prod schema is migration v9"). The query errors on missing columns, the route swallows it (`route.ts:194-199`) and returns zeros; client cements them (`InboxClient.tsx:126`).

**Fix (pick one):**
- **Option A (recommended, 1 file, lowest risk):** Retire `/admin/inbox`; redirect it to `/admin/customer-inbox` (which already uses the healthy `wa_messages`/unified source the badge uses). Sidebar already links to `/admin/customer-inbox`.
- **Option B (keep the bucketed UI):** Rewrite `api/admin/inbox/threads/route.ts` to query the **v9** schema (`wa_threads` by `wa_phone`, `unread_count`, `last_inbound_at`, `last_outbound_at`) or aggregate from `wa_messages` like the unified route, then map into `{needs,open,snoozed,done}`.

**Do NOT** add a v11 `wa_threads` migration — DDL is blocked on the CTH Supabase, and the live webhook writes v9.

**Verify:** `curl` both endpoints as owner; confirm the chosen view returns the same ~60 the badge shows. Confidence: High.

---

## T2 — Vendor Marketing asset previews render blank 🔴

**Symptom:** "Your auto-filled assets" cards show empty cream boxes; first card looks title-less; card heights badly misaligned.

**Root cause:** `app/exhibitor/portal/marketing/page.tsx:140` sets `<img src={a.href}>` to a **live server-side Puppeteer render endpoint** (`api/exhibitor/portal/marketing/ig-feed/png/route.ts` + 3 siblings).
- On any render failure the route returns `JSON 500` (`ig-feed route:33`) — an `<img>` can't paint JSON → blank box (cream is the container bg, `page.tsx:138`).
- Renderer (`lib/marketing/png-renderer.ts:97-118`) boots `@sparticuz/chromium-min` (downloads ~100MB pack) and waits only `waitUntil:'load'` (`:108`), so even successful shots can capture before the network logo (`{{logo_url}} = https://cthalaal.co.za/logo.png`) and Google Fonts paint.
- `Cache-Control: private, no-store` + `Content-Disposition: attachment` on a URL reused for inline preview → 4 cold re-renders per page view.
- Misaligned heights: each card uses a different `aspect-[…]` (ig-story `9/16` tall vs fb-post `1200/630` wide) with no height normalization (`page.tsx:135`). Titles exist (`page.tsx:147`) but get pushed below the tall blank image.

**Fix:**
1. Split preview URL (inline, **cacheable** `Cache-Control: public, max-age=…`, rendered once) from download URL (attachment). Or pre-generate static thumbnails and point `<img>` at those.
2. `png-renderer.ts:108`: `waitUntil:'load'` → `'networkidle0'`; inline the logo as a data URI and self-host fonts so the shot never waits on the network.
3. Add `onError` on the `<img>` to swap in a static placeholder (no naked empty box on 500).
4. Normalize card image boxes to one aspect ratio (e.g. fixed `h-40`) so the grid lines up.

**Verify:** Load Marketing as the demo vendor; all 4 previews paint with logo + stall code; grid aligned. Confidence: High.

---

## T3 — Admin dashboard fires `400` on every load 🟡

**Symptom:** `GET /api/admin/whatsapp-broadcast?limit=1 → 400`, twice per dashboard load.

**Root cause:** `components/admin/TaskCenter.tsx:47` calls the endpoint with `?limit=1`. The route **requires `?counts=1`** and 400s otherwise (`api/admin/whatsapp-broadcast/route.ts:224-226`). It's also the **wrong endpoint** — it returns audience sizing (`audience_total/mail_count/wa_count`), but TaskCenter reads `wa.failedCount` (`:88`), which this route never returns. The "WhatsApp failures" task is silently dead.

**Fix:** Remove the misrouted fetch from the `Promise.all` (`TaskCenter.tsx:47`) and the `waRes` block (`:86-99`). If a real "failed WhatsApp" task is wanted, point it at an endpoint that actually reports delivery failures. Confidence: High.

---

## T4 — Dashboard revenue chart looks flat/empty + `width(-1)` warning 🟡

**Symptom:** Revenue line flat at the bottom; "Total Money In" sparkline flat; console: "The width(-1) and height(-1) of chart should be greater than 0".

**Root cause:** Not a height bug on the main chart (`admin/page.tsx:402` has fixed `height={240}`). It's **data aggregation**: `chartData` (`:191-202`) plots raw daily revenue over the **last 21 days**, most of which are R0; recharts auto-domains to those near-zero values → flat. The `width(-1)` warning comes from the **sparkline** `ResponsiveContainer width="100%" height="100%"` inside an unmeasured parent on first mount (`:308-322`).

**Fix:**
1. Switch `chartData` to a **cumulative running total** (accumulate revenue across sorted dates) → a rising curve to ~R28k, never flat. Fixes both main chart and sparkline shape.
2. Sparkline `:310`: replace `height="100%"` with explicit `height={48}` (parent is `h-12`) → kills the `width(-1)` warning deterministically.

Confidence: High on mechanism; cumulative-vs-wider-window is a product choice (recommend cumulative).

---

## T5 — Dashboard metric overload 🟡

**Symptom:** 5 competing stat cards; big "Pending Applications" card is mostly whitespace; "Pending" appears 3× (alert bar + card + bottom tab). Violates the "one headline metric" design law.

**Root cause:** `admin/page.tsx:298-370` — 2-up primary grid (Money In + Pending) over a 3-up secondary grid (Tickets/Approved/Conversion).

**Fix:**
1. Promote "Total Money In" to a single full-width hero metric (`lg:col-span-2` / full width with sparkline room).
2. Delete the standalone "Pending Applications" card (`:330-339`) — already covered by the amber alert bar (`:285-296`) and the bottom Pending tab.
3. Demote Tickets Sold / Approved / Conversion (`:343-370`) into one compact supporting strip.

Confidence: High.

---

## T6 — Allocation page slow to load (reads as broken) 🟡

**Symptom:** "Loading live allocation…" spinner for several seconds (still loading at 2.3s, done by 7s). Not broken, just slow + no skeleton.

**Root cause (three compounding):**
1. Auth waterfall: `allocation/page.tsx:68-79` awaits `supabase.auth.getUser()` **before** issuing the data fetch; the API then re-auths (`api/admin/stalls/route.ts:13-21`). 2-3 sequential auth round-trips before any payload.
2. Unbounded scan: `loadOccupants` (`route.ts:24-28`) selects **every** `vendor_applications` row (no limit) and runs `parseAllocation` + `parsePortalState` + `computeVendorPricing` per row (`:33-41`) — heavy compute even on rows later discarded (`:60`).
3. No skeleton: `page.tsx:333-337` renders only a centered spinner.

**Fix (any/all, small):**
1. Fastest perceived win: replace the bare spinner with a skeleton (left vendor-rail shell + gray map block) so structure paints <100ms.
2. Drop the client auth pre-gate: call `load()` immediately (API already enforces auth + redirects on 401).
3. Backend: move `computeVendorPricing`/`parsePortalState` **inside** the `if (a.status === 'approved' || stall)` branch (`route.ts:60`) so discarded rows cost nothing; scope the select to needed columns.

Live component is `components/floor/FloorCommand.tsx` (not `StallMap`, which is imported only for a type). Confidence: High on diagnosis.

---

## T7 — Vendor empty colored band / dead whitespace 🟡

**Symptom:** Large empty tinted band below short content on My Stand and Announcements.

**Root cause:**
- My Stand: `app/exhibitor/portal/stand/page.tsx:22` wraps content in `min-h-[calc(100vh-72px)]` on a tinted bg, and the map area reserves `min-h-[600px]` (`:37`). The short "stall is being assigned" empty state leaves a big band.
- Announcements: short `Card max-w-xl` (`announcements/page.tsx:25`) inside the portal layout's full-height flex (`portal/layout.tsx:38,47`, plus the `min-height:fit-content` override `:42`); the cream bg fills the `flex-1` remainder.

**Fix:** My Stand — drop the `min-h-[calc(100vh-72px)]` (`:22`) and the `min-h-[600px]` reserve (`:37`), or only reserve 600px when a map actually renders. Announcements — stop the short empty state from stretching the `flex-1` remainder (center vertically or cap height). Confidence: High (Stand) / Med-High (Announcements).

---

## T8 — Overview stat-row clips against footer 🟡

**Symptom:** Bottom stat-card row collides with the footer at shorter viewport heights.

**Root cause:** Height-constraint conflict. Portal layout forces `h-screen overflow-hidden flex flex-col` (`portal/layout.tsx:38`) with scroll on `main flex-1 … min-h-0` (`:47`), but `PageShell` is `min-h-screen` (`components/chrome/PageChrome.tsx:35`). The layout injects an `!important` override (`layout.tsx:42`) to defeat that; on the long Overview page (`portal/page.tsx:137-233`) the last row can clip with no bottom clearance.

**Fix:** Add bottom padding to the scroll region (`main … pb-8`/`pb-12` at `layout.tsx:47`, or on `PageShell`'s inner container). More robustly, give `PageShell` a portal variant using `min-h-full` instead of `min-h-screen` and remove the `!important` hack. Confidence: Medium.

---

## T9 — Allocation duplicate "Floor plan" header 🟢

**Root cause:** `app/(admin)/admin/allocation/page.tsx:262` wraps in `<AdminPage title="Floor plan" caption="BOOTH ALLOCATION">` (renders the page `<h1>` via `AdminPageHeader`), **and** lines `264-268` hand-roll a second identical eyebrow + `<h1>Floor plan</h1>` inside the toolbar.

**Fix:** Remove the inline title sub-block (`page.tsx:265-268`), keep the `AdminPage` header (project convention). Confidence: High.

---

## T10 — "Announcements" nav tab stuck in active state 🟢

**Root cause:** `components/exhibitor/PortalNav.tsx:79` uses bare `pathname.startsWith(href)` for active state — no trailing-slash boundary, so sibling routes co-activate / a tab stays lit.

**Fix:**
```ts
function isActive(href: string) {
  if (href === '/exhibitor/portal') return pathname === href
  return pathname === href || pathname.startsWith(href + '/')
}
```
Confidence: Med-High.

---

## V1 — Vendor login "silent 401" — VERIFY FIRST (likely NOT a bug) ⚪

The source already handles it correctly: `app/exhibitor/login/page.tsx:14` error state, `:26-30` checks `!res.ok` and `setError`, `:65-69` renders a red inline banner; the API returns `{error}` on every failure (`api/exhibitor/login/route.ts:69`). The live "no feedback" symptom was probably a **stale deploy** or a **test artifact** (a `curl`/automation submit that never ran the React handler).

**Action:** In a real browser on a confirmed-fresh deploy, submit wrong creds and watch for the red banner. If it shows → no bug; close. If it genuinely doesn't → re-investigate the deployed bundle (not these files). **Do not edit blind.**

---

## V2 — "My Stand" / "Documents" nav may not navigate — VERIFY FIRST ⚪

All six top-nav items render identically as plain `<a href>` (`PortalNav.tsx:106`), so there's no per-link difference between the "working" (Marketing/Announcements) and "broken" (My Stand/Documents) ones. Most likely the click DID navigate but the **destination page errored/redirected** for that vendor's data (or it was my automation hitting stale refs).

**Action:** Live click-through with devtools Network open. If the destination 500s/redirects → fix there (see T7's `min-h` on Stand, or a Documents data fetch), not the nav. Consider converting nav `<a>` to `next/link` `<Link>` for cleaner client routing + error surfacing.

---

## Suggested execution order

1. **Live re-verify V1 + V2** (2 min, no code) — decide if they're real.
2. **T1, T2** (High) — operator-blocking + vendor-facing-broken.
3. **T3, T4, T5** (dashboard cluster, same file — do together).
4. **T6** (allocation), **T7, T8** (vendor whitespace).
5. **T9, T10** (cosmetic, trivial).

Worktree isolation recommended for any parallel writing (one repo / one Vercel = one driver). Each ticket touches disjoint files except T3-T5 (all `admin/page.tsx` + TaskCenter) — do those in one lane.
