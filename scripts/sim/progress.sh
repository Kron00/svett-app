#!/usr/bin/env bash
# Takes the Progress proof screenshots on rena-devbook with the 300-workout
# fixture. Run it after devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/progress.sh [--release] [out-dir]
#
# Generates the fixture into out-dir and copies it into the app's data container.
# At the largest text size it relaunches svett on the fixture and shoots the
# Progress tab, then opens each chart screen through its svett:// link and shoots
# it page by page until the screen's closing rule is on screen: bench press over
# all time, sets per muscle in the week of 26 October 2026, the fixture's last
# full week, and body weight over all time with its add sheet. Links stand in for
# taps, because agent-device refuses taps in screen content on iOS 27 as covered
# by UIKit's touch-transparent floating bar containers. It fails when the fixture
# does not open with its 300 workouts or a screen or chart does not show.
# Screenshots are <step>-NN.png in out-dir, by default
# ~/svett-proof/<branch>/progress/. Like tabs.sh, Debug opens the development
# client on Metro at SVETT_METRO, --release opens the installed Release build,
# and every step runs through SVETT_DEVICE_CMD when it is set.
set -euo pipefail

usage() {
  echo "Usage: $0 [--release] [out-dir]" >&2
  exit 64
}

release=false
if [[ "${1:-}" == --release ]]; then
  release=true
  shift
fi
[[ $# -le 1 ]] || usage
[[ "${1:-}" != -* ]] || usage

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
out=${1:-$HOME/svett-proof/$(git branch --show-current)/progress}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
progress_tab='label="Progress, tab, 3 of 5"'
max_pages=40

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

mkdir -p "$out"
out=$(cd "$out" && pwd)
restore() {
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

pnpm fixture --out "$out/svett-fixture.db"
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
fixture="$data/Documents/svett-fixture.db"
mkdir -p "$data/Documents"
# A journal left by an earlier run would be replayed onto the fresh copy.
rm -f "$fixture-wal" "$fixture-shm"
cp "$out/svett-fixture.db" "$fixture"
echo "Copied the fixture to $fixture"

bench=$(node --input-type=module -e '
  import { libraryExerciseId } from "./packages/core/src/exercise-library.ts";
  process.stdout.write(libraryExerciseId(process.argv[1]));
' Barbell_Bench_Press_-_Medium_Grip)

# pages <step> <closing element> <element>... screenshots the screen a page at a
# time until its closing element is on screen. It fails when an element was on
# none of the pages.
pages() {
  local step=$1 closing=$2 page=1 path element
  shift 2
  local unseen=("$@") still
  while true; do
    path=$(printf '%s/%s-%02d.png' "$out" "$step" "$page")
    agent_device screenshot "$path"
    echo "Saved $path"
    still=()
    for element in ${unseen[@]+"${unseen[@]}"}; do
      agent_device is visible "id=\"$element\"" >/dev/null 2>&1 || still+=("$element")
    done
    unseen=(${still[@]+"${still[@]}"})
    agent_device is visible "id=\"$closing\"" >/dev/null 2>&1 && break
    ((page < max_pages)) || {
      echo "$step: $closing was not on screen after $max_pages pages" >&2
      exit 1
    }
    # Scrolling less than a screen overlaps the pages, so nothing falls between two.
    agent_device scroll down 0.6
    page=$((page + 1))
  done
  echo "$step: $page pages"
  ((${#unseen[@]} == 0)) || {
    echo "$step: never on screen: ${unseen[*]}" >&2
    exit 1
  }
}

# link <step> <url> <screen> <closing element> <element>... opens the link, waits
# for the screen, and shoots it page by page.
link() {
  local step=$1 url=$2 screen=$3
  shift 3
  agent_device open "$bundle_id" "$url"
  agent_device wait "id=\"$screen\"" 60000
  agent_device wait 1000
  pages "$step" "$@"
}

launch() {
  if [[ "$release" == true ]]; then
    scripts/sim/launch.sh --release "$@"
  else
    scripts/sim/launch.sh "$@"
  fi
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
launch -svettFixture "$fixture"
agent_device wait "$progress_tab" 120000
# The tab bar takes selector presses.
agent_device press "$progress_tab"
agent_device wait 'id="progress"' 60000
agent_device wait absent 'id="workout-counts" label="Opening the database"' 30000
counts=$(agent_device get text 'id="workout-counts"')
[[ "$counts" == *"300 workouts"* ]] || {
  echo "The Progress tab did not show the fixture's 300 workouts: $counts" >&2
  exit 1
}
agent_device wait 1000
pages 01-progress progress-end

link 02-bench "svett://progress/exercise/$bench?range=all" exercise-progress exercise-progress-end \
  chart-best_one_rep_max chart-heaviest_weight chart-session_volume
link 03-muscles "svett://progress/muscles?week=2026-10-26" muscle-sets muscle-sets-end \
  chart-muscle-weeks
link 04-body-weight "svett://progress/measurements?kind=body_weight&range=all" measurements \
  measurements-end chart-measurement

agent_device open "$bundle_id" "svett://progress/measurements?kind=body_weight&range=all&sheet=open"
agent_device wait 'id="measurement-sheet"' 10000
agent_device wait 1000
agent_device screenshot "$out/05-add-measurement.png"
echo "Saved $out/05-add-measurement.png"

echo "Screenshots are in $out"
