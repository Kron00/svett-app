#!/usr/bin/env bash
# Takes the fixture proof screenshots on rena-devbook. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/fixture.sh [--release] <out-dir>
#
# Generates the fixture into out-dir with pnpm fixture and copies it into the
# app's data container. Then it screenshots the Progress tab's workout counts
# twice, after a plain launch that opens the anonymous database and after a
# relaunch with -svettFixture. Launches go through launch.sh, so like tabs.sh it uses
# SVETT_DEVICE_CMD when set and its own agent-device session otherwise.
set -euo pipefail

usage() {
  echo "Usage: $0 [--release] <out-dir>" >&2
  exit 64
}

release=false
if [[ "${1:-}" == --release ]]; then
  release=true
  shift
fi
[[ $# -eq 1 && "$1" != -* ]] || usage

mkdir -p "$1"
out=$(cd "$1" && pwd)
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
bundle_id=com.kron00.svett

if command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
fi

# shellcheck source=scripts/sim/simulator.sh
source scripts/sim/simulator.sh
udid=$(simulator_udid "$simulator_name")
[[ -n "$udid" ]] || {
  echo "No available iOS 27 simulator named \"$simulator_name\". Run scripts/devbook-build.sh first." >&2
  exit 1
}

pnpm fixture --out "$out/svett-fixture.db"
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
fixture="$data/Documents/svett-fixture.db"
mkdir -p "$data/Documents"
# A journal left by an earlier run would be replayed onto the fresh copy.
rm -f "$fixture-wal" "$fixture-shm"
cp "$out/svett-fixture.db" "$fixture"
echo "Copied the fixture to $fixture"

[[ -n "${SVETT_DEVICE_CMD:-}" ]] || trap 'agent_device close || true' EXIT

# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
progress_tab='label="Progress, tab, 3 of 5"'
counts='id="workout-counts"'

# show_counts <name> opens the Progress tab, waits for the counts and saves <name>.png.
show_counts() {
  agent_device wait "$progress_tab" 120000
  agent_device press "$progress_tab"
  agent_device wait "$counts" 10000
  agent_device wait absent "$counts label=\"Opening the database\"" 30000
  agent_device get text "$counts"
  agent_device screenshot "$out/$1.png"
  echo "Saved $out/$1.png"
}

launch() {
  if [[ "$release" == true ]]; then
    scripts/sim/launch.sh --release "$@"
  else
    scripts/sim/launch.sh "$@"
  fi
}

launch
show_counts 01-anonymous

launch -svettFixture "$fixture"
show_counts 02-fixture

echo "Screenshots are in $out"
