#!/usr/bin/env bash
# Records a walkthrough of svett on rena-devbook's simulator: the first run, every tab
# and the main screens, on the 300-workout fixture. Run it after devbook-build.sh, with
# the same --release choice.
#
# Usage: scripts/sim/walkthrough.sh [--release] [out-dir]
#
# It walks twice, at the default text size and at the largest, and records each pass
# with agent-device's video recording, as default.mp4 and largest.mp4. Each pass
# relaunches svett on a fresh copy of the fixture with the ChatGPT stand-in signed in.
# Each pass opens on the first run with -svettFirstRun show, takes each page, presses
# Next on each and Start training on the last, and checks it ends on Train. Then it opens Train, a routine, the exercise library, Record, Home, Progress,
# the newest workout, bench press's chart, the calendar, the muscles, the body
# measurements, Coach, the ChatGPT settings, the You tab, Your data, Units and plates
# and Account. It reaches each through its svett:// link, and You by its tab button,
# because agent-device 0.21.37 refuses taps in screen content on iOS 27. At each stop
# it waits for the screen's top element, then saves <pass>-NN-<stop>.png. A press in
# screen content goes to the element's centre, clear of the bottom edge, once two
# reads of its frame agree. It fails when a screen does not show. Everything goes to
# out-dir, by default ~/svett-proof/<branch>/walkthrough/. Like tabs.sh, Debug opens
# the development client on Metro at SVETT_METRO, --release opens the installed
# Release build, and every step runs through SVETT_DEVICE_CMD when it is set.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/walkthrough}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
train_tab='label="Train, tab, 2 of 5"'
you_tab='label="You, tab, 5 of 5"'

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
launch_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher.
[[ "$release" == true ]] || launch_flags+=(--launch-url "$(dev_client_url "http://$metro")")

pnpm fixture --out "$out/svett-fixture.db"
documents="$(xcrun simctl get_app_container "$udid" "$bundle_id" data)/Documents"
mkdir -p "$documents"
database="$documents/svett-walkthrough.db"

# sql <query> prints the fixture's rows, one per line.
sql() {
  node -e '
    const database = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
    for (const row of database.prepare(process.argv[2]).all()) console.log(Object.values(row).join("|"));
  ' "$out/svett-fixture.db" "$1"
}
workout=$(sql "SELECT id FROM activity WHERE deleted_at IS NULL ORDER BY started_at DESC LIMIT 1")
routine=$(sql "SELECT id FROM routine WHERE deleted_at IS NULL ORDER BY position, id LIMIT 1")
bench=$(node --input-type=module -e '
  import { libraryExerciseId } from "./packages/core/src/exercise-library.ts";
  process.stdout.write(libraryExerciseId(process.argv[1]));
' Barbell_Bench_Press_-_Medium_Grip)
[[ -n "$workout" && -n "$routine" ]] || {
  echo "The fixture has no workout or no routine" >&2
  exit 1
}

recording=false
restore() {
  [[ "$recording" == false ]] || agent_device record stop || true
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

fail() {
  echo "$*" >&2
  exit 1
}

shot=0
screenshot() {
  shot=$((shot + 1))
  local path
  path=$(printf '%s/%s-%02d-%s.png' "$out" "$pass" "$shot" "$1")
  agent_device screenshot "$path" >/dev/null
  echo "Saved $path"
}

reveal() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1" >/dev/null 2>&1
}

centre_of() {
  local frame
  frame=$(agent_device get attrs "$1") || fail "Could not read where $1 is"
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

# Below this line a press lands on the screen's bottom edge, where iOS 27 keeps the
# home indicator.
safe_bottom=840

# Brings the element on screen, drags it clear of the bottom edge, waits until two reads
# of its frame agree, because iOS takes a tap on a gliding screen as a stop, and presses
# its centre. agent-device 0.21.37 refuses a selector press inside screen content on
# iOS 27, so the press goes to coordinates.
tap() {
  local point before="" reads=0 drags=0
  reveal "$1" || fail "$1 was not on screen to press"
  point=$(centre_of "$1")
  while ((${point#* } > safe_bottom)); do
    ((drags < 3)) || fail "$1 stayed at the bottom edge of the screen"
    agent_device gesture pan 20 600 0 -300 400 >/dev/null
    drags=$((drags + 1))
    point=$(centre_of "$1")
  done
  while [[ "$point" != "$before" ]]; do
    ((reads < 10)) || fail "$1 kept moving"
    before=$point
    agent_device wait 250 >/dev/null
    point=$(centre_of "$1")
    reads=$((reads + 1))
  done
  agent_device press "${point% *}" "${point#* }" >/dev/null
}

# stop <name> <link or tab selector> <top element> opens a screen and shoots it.
stop() {
  if [[ "$2" == svett://* ]]; then
    agent_device open "$bundle_id" "$2" >/dev/null
  else
    agent_device press "$2" >/dev/null
  fi
  agent_device wait "$3" 60000 >/dev/null || {
    screenshot "$1-missing"
    fail "$1 did not show $3"
  }
  agent_device wait 1000 >/dev/null
  screenshot "$1"
}

# first_run walks the first-run pages and checks the last one opens Train.
first_run() {
  local page
  agent_device wait 'id="first-run"' 120000 >/dev/null || fail "svett did not open on its first run"
  for page in feed data account coach; do
    agent_device wait "id=\"first-run-$page\"" 10000 >/dev/null ||
      reveal "id=\"first-run-$page\"" || fail "The first run did not show its $page page"
    screenshot "first-run-$page"
    tap 'id="first-run-next"'
  done
  if ! agent_device wait 'id="train"' 30000 >/dev/null || ! agent_device is visible "$train_tab" >/dev/null; then
    screenshot first-run-end
    fail "The first run did not end on Train"
  fi
}

# walk <pass> <text size> records one pass.
walk() {
  local argument flags=("${launch_flags[@]}")
  pass=$1
  shot=0
  agent_device settings text-size "$2" >/dev/null
  # A fresh copy each pass, so a pass never sees what the last one changed.
  rm -f "$database" "$database-wal" "$database-shm"
  cp "$out/svett-fixture.db" "$database"
  for argument in -svettFixture "$database" -svettChatGPTStub signedIn -svettFirstRun show; do
    flags+=("--launch-args=$argument")
  done
  agent_device open "$bundle_id" "${flags[@]}" >/dev/null
  agent_device record start "$out/$pass.mp4" >/dev/null
  recording=true
  first_run
  stop train svett://train 'id="train"'
  stop routine "svett://routine/$routine" 'id="routine-detail"'
  stop exercises svett://exercises 'id="exercise-library"'
  stop record svett://record 'id="record-cardio"'
  stop home svett://feed 'id="feed" || id="social-signed-out" || id="social-accounts-off"'
  stop progress svett://progress 'id="progress"'
  stop workout "svett://workout/$workout" 'id="workout-detail"'
  stop exercise-chart "svett://progress/exercise/$bench?range=all" 'id="exercise-progress"'
  stop calendar "svett://calendar?month=2026-10" 'id="calendar"'
  stop muscles "svett://progress/muscles?week=2026-10-26" 'id="muscle-sets"'
  stop measurements "svett://progress/measurements?kind=body_weight&range=all" 'id="measurements"'
  stop coach svett://coach 'id="coach" || id="coach-signed-out"'
  stop chatgpt svett://chatgpt 'id="chatgpt"'
  stop you "$you_tab" 'id="tab-you"'
  stop data svett://data 'id="data"'
  stop settings svett://settings/workout 'id="workout-settings"'
  stop account svett://account 'id="account"'
  agent_device record stop >/dev/null
  recording=false
  echo "Saved $out/$pass.mp4"
}

walk default large
walk largest accessibility-extra-extra-extra-large

echo "The walkthrough's videos and screenshots are in $out"
