#!/usr/bin/env bash
# Takes the exercise library proof on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/exercises.sh [--release] [out-dir]
#
# At the largest text size it searches the bundled library, opens the first
# result, and creates a custom exercise with a name unique to this run. Then it
# relaunches svett, searches for that name and opens it again, which proves the
# exercise survived the restart. It fails when a screen, the expected first
# result or the saved exercise is missing. It opens each screen through a
# svett:// link and presses an element at the centre of its frame, because
# agent-device 0.21.37 refuses a selector press inside screen content on iOS 27.
# Numbered screenshots go to out-dir, by default
# ~/svett-proof/<branch>/exercises/. SVETT_EXERCISE_NAME sets the custom
# exercise's name. Like tabs.sh, Debug opens the development client on Metro at
# SVETT_METRO, --release opens the installed Release build, and every step runs
# through SVETT_DEVICE_CMD when it is set.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/exercises}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The Train tab showing means the app has loaded and can take a link.
train_tab='label="Train, tab, 2 of 5"'
library_query="barbell squat"
library_name="Barbell Squat"
custom_name=${SVETT_EXERCISE_NAME:-"Proof press $(date +%Y%m%d-%H%M%S)"}

if command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
fi

# shellcheck source=scripts/sim/simulator.sh
source scripts/sim/simulator.sh
if [[ -z "${SVETT_DEVICE_CMD:-}" ]]; then
  udid=$(simulator_udid "$simulator_name")
  [[ -n "$udid" ]] || {
    echo "No available iOS 27 simulator named \"$simulator_name\". Run scripts/devbook-build.sh first." >&2
    exit 1
  }
fi

mkdir -p "$out"
open_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")

# Leaves the simulator at the default text size, also when a step fails, and
# frees its own session.
restore() {
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

fail() {
  echo "$1" >&2
  exit 1
}

shot=0
screenshot() {
  shot=$((shot + 1))
  local path
  path=$(printf '%s/%02d-%s.png' "$out" "$shot" "$1")
  agent_device screenshot "$path"
  echo "Saved $path"
}

encode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

relaunch() {
  agent_device open "$bundle_id" "${open_flags[@]}"
  agent_device wait "$train_tab" 120000 || fail "svett did not show its tabs after the relaunch"
}

link() {
  agent_device open "$bundle_id" "$1"
}

# expect <selector> <what is missing, for the failure message>
expect() {
  agent_device wait "$1" 10000 >/dev/null || fail "$2"
}

# Checks the first search result is the exercise named $1, then presses the centre
# of its row. A row's label is its name, then its muscles and equipment.
open_first_result() {
  local attrs point
  attrs=$(agent_device get attrs 'id="exercise-result-0"') || fail "The search for \"$1\" showed no result"
  # shellcheck disable=SC2016 # The ${...} are JavaScript template literals.
  point=$(node -e '
    const { label, rect } = JSON.parse(process.argv[1]);
    if (typeof label !== "string") {
      console.error(`agent-device gave the first result no label: ${process.argv[1]}`);
      process.exit(1);
    }
    if (label !== process.argv[2] && !label.startsWith(`${process.argv[2]},`)) {
      console.error(`The first result was not "${process.argv[2]}". Its label is "${label}".`);
      process.exit(1);
    }
    console.log(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
  ' "$attrs" "$1") || exit 1
  agent_device press "${point% *}" "${point#* }"
  expect 'id="exercise-detail"' "The first result did not open its detail"
  expect "id=\"exercise-name\" label=\"$1\"" "The detail did not show \"$1\""
}

# Scrolls the screen until the element $1 is on screen.
reveal() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    fail "$1 never came on screen"
}

press_centre() {
  local frame point
  frame=$(agent_device get attrs "$1") || fail "$1 is not on screen"
  point=$(node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame")
  agent_device press "${point% *}" "${point#* }"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
relaunch

link "svett://exercises?q=$(encode "$library_query")"
expect 'id="exercise-library"' "The exercise library did not open"
agent_device wait 1000
screenshot library-search
open_first_result "$library_name"
expect 'id="exercise-source" label="From, svett library"' "\"$library_name\" did not show it is from the library"
screenshot library-detail

link "svett://exercises/new?name=$(encode "$custom_name")&muscle=chest&equipment=cable"
expect 'id="exercise-form"' "The new exercise form did not open"
agent_device wait 1000
screenshot new-exercise
reveal 'id="save-exercise"'
press_centre 'id="save-exercise"'
expect 'id="exercise-detail"' "Saving \"$custom_name\" did not open its detail"
expect "id=\"exercise-name\" label=\"$custom_name\"" "The saved detail did not show \"$custom_name\""
expect 'id="exercise-source" label="From, Custom"' "\"$custom_name\" was not saved as a custom exercise"
screenshot custom-detail

relaunch
link "svett://exercises?q=$(encode "$custom_name")"
expect 'id="exercise-library"' "The exercise library did not open after the relaunch"
agent_device wait 1000
screenshot custom-search-after-relaunch
open_first_result "$custom_name"
expect 'id="exercise-source" label="From, Custom"' "\"$custom_name\" was not custom after the relaunch"
screenshot custom-detail-after-relaunch

echo "\"$custom_name\" survived the relaunch. Screenshots are in $out"
