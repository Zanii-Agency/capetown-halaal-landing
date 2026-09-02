# scripts/ — operational + one-off scripts

Run from the repo root with tsx (scripts import app libs via `@/…`):

    node --import tsx scripts/<name>.tsx        # send scripts default to a DRY RUN
    SEND=1 node --import tsx scripts/<name>.tsx  # go live

## Keep vs throwaway (deploy hygiene)

`vercel --prod` ships the whole working tree, and the review-gate blocks the
deploy on ANY untracked file. So a new script left sitting untracked in
`scripts/` forces a `DEPLOY_UNREVIEWED=1` override at deploy time. Two lanes keep
the tree clean, pick one for every script you create:

- **Keeping it?** Commit it to `scripts/` like the ~85 already tracked (one-offs
  included, they are kept as a record). A `_` prefix is fine and commonly committed.
- **Throwaway?** Put it under `scripts/scratch/` — that directory is gitignored,
  so it never dirties the tree or trips the gate. See `scripts/scratch/README.md`.

Never leave a new script untracked in `scripts/` root: that is exactly what makes
an otherwise-clean deploy need the override.
