#!/usr/bin/env bash
# Autonomous migration watcher.
#
#   bash scripts/migration-watch.sh
#
# Runs unattended and emits one line per state change. It does NOT perform the
# transfer: that is a dashboard action in the SOURCE organisation, and the
# management token on this machine only covers the DESTINATION org
# (bmjejkdorgnegduwmdcy). It cannot even enumerate the CTH project today.
#
# That limitation is what makes the detection work. The moment the project is
# transferred INTO the destination org, `supabase projects list` starts
# returning it. So "has the transfer happened" is answerable with no human
# telling us, and the post-transfer verification can fire on its own.
#
# Sequence:
#   1. wait for Postgres to be genuinely reachable (a real table read, not a
#      gateway 401 — that distinction cost us an hour of wrong diagnosis)
#   2. capture the pre-transfer baseline automatically, once
#   3. watch for the project to appear in the destination org
#   4. re-run the fingerprint and diff it against the baseline
set -uo pipefail
cd "$(dirname "$0")/.."

REF="dtdqopjdxwfvtyrnygdt"
BASELINE=".migration-baseline.json"
set -a; . ./.env.local 2>/dev/null; set +a

db_up() {
  local code
  code=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' \
    "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/vendor_applications?select=id&limit=1" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
  [ "$code" = "200" ]
}

transferred() {
  timeout 60 supabase projects list 2>/dev/null | grep -q "$REF"
}

# --- 1 + 2: wait for the DB, then baseline once -----------------------------
if [ ! -f "$BASELINE" ]; then
  echo "WAITING: database unreachable, cannot baseline yet."
  for _ in $(seq 1 240); do        # ~2h ceiling
    if db_up; then
      echo "DB BACK: capturing pre-transfer baseline."
      if npx tsx --env-file=.env.local scripts/migration-fingerprint.mts save; then
        echo "BASELINE SAVED. Safe to perform the transfer now."
      else
        echo "BASELINE FAILED: fingerprint refused to save. Do NOT transfer yet."
        exit 1
      fi
      break
    fi
    sleep 30
  done
fi

if [ ! -f "$BASELINE" ]; then
  echo "GAVE UP: database never came back, so no baseline exists. Transfer not verified-safe."
  exit 1
fi

# --- 3 + 4: watch for the transfer, then verify -----------------------------
echo "WATCHING: for $REF to appear in the destination org."
for _ in $(seq 1 480); do          # ~4h ceiling
  if transferred; then
    echo "TRANSFER DETECTED: $REF is now in the destination org."
    sleep 20                        # let the move settle before reading
    if npx tsx --env-file=.env.local scripts/migration-fingerprint.mts check; then
      echo "VERIFIED: nothing moved. Ref, keys, auth, buckets and row counts all intact."
      exit 0
    fi
    echo "VERIFICATION FAILED — see the diff above. Investigate before trusting the migration."
    exit 1
  fi
  sleep 30
done

echo "TIMED OUT: transfer never detected. Baseline is saved and still valid whenever you do it."
exit 1
