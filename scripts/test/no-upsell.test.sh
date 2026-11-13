#!/usr/bin/env bash
# svett has no paid tier, so nothing in the app may gate a feature or ask the
# user to pay. This fails when upsell wording appears in app or package code.
#
# Usage: scripts/test/no-upsell.test.sh
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
pattern='\b(paywall|premium|upsell|upgrade (to|now)|unlock (all|more|with)|free trial|start (a|your) trial|go pro|svett pro|subscribe now)\b'

scan() {
  grep -rniE --include='*.ts' --include='*.tsx' --include='*.json' "$pattern" "$@" || true
}

planted=$(mktemp -d)
trap 'rm -rf "$planted"' EXIT
printf 'export const cta = "Upgrade to svett Pro to see older workouts";\n' >"$planted/cta.ts"
[[ -n "$(scan "$planted")" ]] || { echo "FAIL: the scan missed planted upsell text" >&2; exit 1; }

roots=("$repo/apps/mobile/src" "$repo/apps/mobile/app.config.ts" "$repo"/packages/*/src)
for root in "${roots[@]}"; do
  [[ -e "$root" ]] || { echo "FAIL: $root is gone. Point the scan at the app's code." >&2; exit 1; }
done
found=$(scan "${roots[@]}")
if [[ -n "$found" ]]; then
  echo "FAIL: upsell wording found. svett has no paid tier." >&2
  echo "$found" >&2
  exit 1
fi
echo "PASS: no upsell wording in app or package code"
