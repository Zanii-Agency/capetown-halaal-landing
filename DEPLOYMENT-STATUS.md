# Cape Town Halaal - Deployment Status

**Date:** 2026-03-04

## What Was Done

1. **Landing page pushed** to `Zanii-Agency/capetown-halaal-portal` main branch
2. **Portal backed up** to `portal-backup` branch
3. Netlify should auto-deploy from GitHub

## Current State

| Item | Location |
|------|----------|
| Landing page code | `main` branch (GitHub) |
| Portal code (backup) | `portal-backup` branch (GitHub) |
| Portal on Vercel | https://capetown-halaal-v3.vercel.app |
| Landing on Vercel | https://capetown-halaal-landing.vercel.app |

## Netlify Site

- **Site name:** capetown-halaal
- **Account:** Tarugarira O Chipunza (taonac96@gmail.com)
- **Domain:** cthalaal.co.za → www.cthalaal.co.za

## To Verify Deployment

1. Log into Netlify as taonac96@gmail.com
2. Check "capetown-halaal" site build status
3. Or wait and hard refresh cthalaal.co.za

## Videos Note

Videos (138MB) were excluded from push - too large for GitHub.
Original videos still in: `/Users/lord/Code/capetown-halaal-landing/public/videos/`

## To Restore Portal

```bash
cd ~/Code/capetown-halaal-portal
git checkout portal-backup
git push origin portal-backup:main --force
```

---
*Saved by Claude Code*
