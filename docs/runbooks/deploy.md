# Deploy Runbook

One-page guide to deploy Cape Town Halaal landing to production.

## Pre-Flight (5 min)

1. **Typecheck:** Ensure no TypeScript errors.
   ```bash
   npx tsc --noEmit
   ```
   Fix any errors before proceeding.

2. **Build:** Build the Next.js app locally.
   ```bash
   npm run build
   ```
   If build fails, the deploy will fail. Fix locally first.

3. **Env Parity:** Verify `.env.local` matches production secrets (on Vercel).
   - Check Vercel Settings → Environment Variables.
   - Ensure all required keys (API keys, database URLs, etc.) are present.
   - Compare against `.env.example` for completeness.

4. **Git Status:** Ensure all work is committed (no staged/unstaged changes).
   ```bash
   git status
   ```

## Deploy (1 min)

Push to the `final-deploy` branch. Vercel watches this branch and auto-deploys.

```bash
git push origin final-deploy
```

Monitor the deploy in Vercel (https://vercel.com/Zanii-Agency/capetown-halaal-landing).

## Post-Deploy Verify (5 min)

Once Vercel shows a green checkmark:

1. **Homepage:** curl the production domain and check for 200 status.
   ```bash
   curl -I https://cthalaal.co.za
   ```

2. **Young at Heart Alias:** Verify the second domain works.
   ```bash
   curl -I https://youngatheart.co.za
   ```

3. **Key Routes:** Spot-check critical pages load without errors.
   - `/exhibitors` — exhibitor portal
   - `/tickets` — ticketing integration
   - `/vendors` — vendor info

4. **Lighthouse (Optional):** Run a quick performance check.
   ```bash
   npm run lighthouse
   ```
   (if script is configured in package.json)

## Rollback

If production breaks:

1. **Quick Revert:** Undo the last commit and push.
   ```bash
   git revert HEAD
   git push origin final-deploy
   ```
   Vercel will auto-deploy the revert.

2. **Via Vercel UI:** Go to Vercel dashboard → Deployments tab → click a previous stable deployment → "Rollback."

3. **Manual Verify:** After rollback, re-run post-deploy verification steps above.

---

**Owner:** Taona | **Last Updated:** 2026-06-13
