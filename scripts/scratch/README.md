# scripts/scratch — the throwaway lane

Drop one-off scripts you do **not** intend to keep in here. Everything under
`scripts/scratch/` is gitignored (except this README), so it never dirties the
working tree and never trips the deploy review-gate that blocks `vercel --prod`
on untracked files.

## Use it for
- A single-use audit, backfill, chase, export, or repair you run once and discard.
- Anything you would otherwise leave untracked in `scripts/` and then have to
  `DEPLOY_UNREVIEWED=1` past at deploy time.

## Do NOT use it for
- A script worth keeping as a record. The repo commits those (~85 tracked scripts,
  one-offs included, `_`-prefixed ones too). Put those in `scripts/` proper and
  commit them.

## Running
Scripts import app libs via `@/…`, so run from the repo root with tsx:

    node --import tsx scripts/scratch/my-one-off.tsx

Env flags follow each script's own header (commonly `SEND=1` to go live).
