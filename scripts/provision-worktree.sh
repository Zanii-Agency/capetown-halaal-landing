#!/usr/bin/env bash
# Provision a git worktree so it can actually build, test and resolve deps.
#
# Why this exists: worktrees start with only tracked files. Everything this
# project needs to RUN is gitignored, so a fresh worktree cannot install, cannot
# read env, and cannot typecheck. An agent handed an unusable worktree does the
# rational thing and falls back to the main checkout, which puts two sessions on
# one working tree. That is how a tested commit and a deployed commit drift apart
# (2026-07-20: a second commit landed mid-build and shipped untested).
#
# The .vercel link is load-bearing in a specific way: with NO .vercel present,
# `vercel --prod` does not fail, it silently creates a BRAND NEW Vercel project
# and deploys there (KT #206639). Linking it means a stray deploy at least hits
# the real project instead of minting a rogue one.
#
# Deploys still belong to the main checkout only (CTH-DOCTRINE law 1, one repo,
# one Vercel project, one driver). This script makes worktrees safe to BUILD and
# TEST in, not to ship from.
#
# Usage:
#   scripts/provision-worktree.sh                # provision every worktree found
#   scripts/provision-worktree.sh <path>         # provision one
#
# Idempotent: anything already present is left alone.

set -euo pipefail

MAIN="$(git rev-parse --show-toplevel)"
# Shared from the main checkout rather than duplicated: node_modules alone is
# ~800MB per copy, and a symlinked env file means a rotated secret propagates
# instead of going stale in a worktree nobody remembers to update.
LINKS=(.env.local .env.production.local node_modules .vercel)

provision() {
  local wt="$1"
  [ -d "$wt" ] || { echo "  skip (not on disk): $wt"; return; }
  echo "  $wt"
  for f in "${LINKS[@]}"; do
    if [ -e "$wt/$f" ] || [ -L "$wt/$f" ]; then
      echo "    = $f (already present)"
    elif [ -e "$MAIN/$f" ]; then
      ln -s "$MAIN/$f" "$wt/$f"
      echo "    + $f"
    else
      echo "    ! $f missing in main checkout, skipped"
    fi
  done
}

if [ $# -ge 1 ]; then
  provision "$1"
else
  echo "Provisioning all worktrees of $MAIN"
  # Skip the main checkout itself (first entry) and any record whose path is gone.
  git worktree list --porcelain \
    | awk '/^worktree /{print substr($0,10)}' \
    | grep -v "^${MAIN}$" \
    | while read -r wt; do provision "$wt"; done
fi

echo "Done. Build and test in worktrees; deploy only from $MAIN."
