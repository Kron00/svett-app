#!/usr/bin/env bash
# Takes the routines proof on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/routines.sh [--release] [out-dir]
#
# At the largest text size it builds a routine in the app and starts it. It
# opens a new routine named for this run, adds Barbell Squat through the
# exercise picker, types a target of 60 kg for 8 to 12 reps on the keypad, adds
# two more sets that copy it, and saves. Then it relaunches svett, opens the
# routine from the Train tab and starts it, and checks the workout in progress
# holds the exercise with all three sets filled in. A workout left in progress
# by an earlier run is discarded first. It goes back to the Train tab before it
# opens the routine screens, as a person would open them.
# It fails when a screen, the exercise, a target or a set is missing.
#
# It runs on the 300-workout fixture, which the plan's 2 second cold start target
# names. It generates the fixture into out-dir with pnpm fixture and copies it
# into the app's data container, as progress.sh does, and relaunches svett on it
# every time. SVETT_FIXTURE, the absolute path of a fixture database already in
# the data container, skips that and uses it instead.
#
# It times a cold start from the relaunch until the Train tab lists the
# routines, which it renders once they have loaded. That time includes
# agent-device's calls, so it is an upper bound. Then it times the same calls
# against the running app, which shows the automation's own share. Their
# difference still includes the script's wait before it opens the Train tab, so
# it is an upper bound too. svett is launched with -svettTiming 1, so the Train
# tab also shows the time svett measured itself, from the process start to the
# first frame with the routine list, without the wait for the svett://train link,
# and each step on the way. That in-app time is the number the plan's 2 second
# target is judged by, and only on a Release build. All of it goes to
# cold-start.txt.
#
# It opens screens through svett:// links and presses an element at the centre
# of its frame, because agent-device 0.21.37 refuses a selector press inside
# screen content on iOS 27. Numbered screenshots go to out-dir, by default
# ~/svett-proof/<branch>/routines/. SVETT_ROUTINE_NAME sets the routine's name.
# Like tabs.sh, Debug opens the development client on Metro at SVETT_METRO,
# --release opens the installed Release build, and every step runs through
# SVETT_DEVICE_CMD when it is set.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/routines}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The Train tab showing means the app has loaded and can take a link.
train_tab='label="Train, tab, 2 of 5"'
exercise_query="barbell squat"
exercise_name="Barbell Squat"
routine_name=${SVETT_ROUTINE_NAME:-"Proof routine $(date +%Y%m%d-%H%M%S)"}
target="60 kg, 8 to 12 reps"

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
fixture=${SVETT_FIXTURE:-}
if [[ -z "$fixture" ]]; then
  pnpm fixture --out "$out/svett-fixture.db"
  data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
  fixture="$data/Documents/svett-fixture.db"
  mkdir -p "$data/Documents"
  # A journal left by an earlier run would be replayed onto the fresh copy.
  rm -f "$fixture-wal" "$fixture-shm"
  cp "$out/svett-fixture.db" "$fixture"
  echo "Copied the fixture to $fixture"
fi
open_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")
open_flags+=(--launch-args=-svettFixture "--launch-args=$fixture" --launch-args=-svettTiming --launch-args=1)

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

now_ms() {
  node -e 'console.log(Date.now())'
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

# gone <selector> <what is still there, for the failure message>: waits up to
# 5 seconds for the element to leave the screen.
gone() {
  local tries
  for tries in 1 2 3 4 5 6 7 8 9 10; do
    agent_device is visible "$1" >/dev/null 2>&1 || return 0
    agent_device wait 500 >/dev/null
  done
  fail "$2"
}

# bring <selector> [what is missing]: scrolls until the element is on screen, up
# or down, because at the largest text size a form is taller than the screen.
bring() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    fail "${2:-$1 never came on screen}"
}

# tap <selector> [what is missing]: brings the element on screen and presses the
# centre of its frame.
tap() {
  local frame point
  bring "$@"
  frame=$(agent_device get attrs "$1") || fail "$1 is not on screen"
  point=$(node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame")
  agent_device press "${point% *}" "${point#* }"
}

# type_into <field selector> <key>...: focuses a target field and types on the keypad.
type_into() {
  local field=$1 key
  shift
  tap "$field"
  for key in "$@"; do
    tap "id=\"key-$key\""
  done
}

# Checks the picker's first result is the exercise named $1, then presses it.
choose_first_result() {
  local attrs point
  attrs=$(agent_device get attrs 'id="exercise-result-0"') || fail "The search for \"$1\" showed no result"
  # shellcheck disable=SC2016 # The ${...} are JavaScript template literals.
  point=$(node -e '
    const { label, rect } = JSON.parse(process.argv[1]);
    if (typeof label !== "string" || (label !== process.argv[2] && !label.startsWith(`${process.argv[2]},`))) {
      console.error(`The first result was not "${process.argv[2]}". Its label is "${label}".`);
      process.exit(1);
    }
    console.log(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
  ' "$attrs" "$1") || exit 1
  agent_device press "${point% *}" "${point#* }"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
started=$(now_ms)
relaunch
link "svett://train"
expect 'id="routine-list"' "The Train tab did not list the routines"
cold_start=$(($(now_ms) - started))
# The same calls once svett is running measure agent-device's share of the time.
started=$(now_ms)
agent_device wait "$train_tab" 120000 >/dev/null || fail "svett did not show its tabs"
link "svett://train"
expect 'id="routine-list"' "The Train tab did not list the routines"
overhead=$(($(now_ms) - started))
bring 'id="cold-start-timing"' "The Train tab did not show svett's own cold start time"
in_app=$(agent_device get attrs 'id="cold-start-timing"' |
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).label ?? "")')
[[ "$in_app" == "svett's own cold start: "* ]] || fail "The cold start time on the Train tab reads \"$in_app\""
build=$([[ "$release" == true ]] && echo Release || echo "Debug, loaded from Metro")
{
  echo "Cold start to the Train tab's routine list: $cold_start ms ($build, on the 300-workout fixture, an upper bound that includes agent-device's calls)"
  echo "agent-device's calls alone, against the running app: $overhead ms"
  echo "The difference, an upper bound on svett's start-up that still includes the script's wait before it opens the Train tab: about $((cold_start - overhead)) ms"
  echo "Measured in the app, the number the plan's 2 second target is judged by: $in_app"
} | tee "$out/cold-start.txt"
screenshot train

link "svett://train/workout"
expect 'id="workout"' "The workout screen did not open"
if agent_device wait 'id="workout-title"' 3000 >/dev/null 2>&1; then
  tap 'id="discard-workout"'
  agent_device alert wait 5000 >/dev/null || fail "Discard workout asked nothing"
  # svett's own alert: agent-device's alert accept cannot answer it, so press its button.
  tap 'label="Discard"'
  # Discarding goes back to the Train tab, which reloads without the workout.
  expect 'id="routine-list"' "Discarding the workout did not go back to the Train tab"
  gone 'id="workout-in-progress-row"' "A workout from an earlier run is still in progress"
else
  expect 'label="No workout in progress"' "A workout from an earlier run is still in progress"
fi
# The probe can leave the workout screen open, and the routine screens would then
# open on top of it, under a "Workout" back button.
link "svett://train"
expect 'id="routine-list"' "The Train tab did not list the routines after the workout check"

link "svett://routines/new?title=$(encode "$routine_name")"
expect 'id="routine-editor"' "The new routine editor did not open"
agent_device wait 1000
screenshot new-routine

link "svett://routines/new/exercises?q=$(encode "$exercise_query")"
expect 'id="exercise-library"' "The exercise picker did not open"
agent_device wait 1000
screenshot pick-exercise
choose_first_result "$exercise_name"
expect 'id="routine-exercise-0"' "\"$exercise_name\" was not added to the routine"

tap 'id="routine-set-0-0"'
expect 'id="set-target"' "The first set's target did not open"
type_into 'id="target-weight"' 6 0
type_into 'id="target-reps-from"' 8
type_into 'id="target-reps-to"' 1 2
screenshot set-target
tap 'id="save-set"'
expect "id=\"routine-set-0-0\" label=\"Set 1, $target\"" "The first set did not keep its target"
tap 'id="add-set-0"'
tap 'id="add-set-0"'
bring "id=\"routine-set-0-2\" label=\"Set 3, $target\"" "Add set did not copy the first set's target"
screenshot routine-editor

tap 'id="save-routine"'
expect 'id="routine-detail"' "Saving the routine did not open it"
expect "id=\"routine-title\" label=\"$routine_name\"" "The saved routine is not named \"$routine_name\""
bring "id=\"routine-set-0-2\" label=\"Set 3, $target\"" "The saved routine does not hold three sets of $target"
screenshot routine-detail

relaunch
link "svett://train"
expect 'id="routine-list"' "The Train tab did not list the routines after the relaunch"
tap "id=\"routine-row\" label=\"$routine_name, $exercise_name\"" \
  "\"$routine_name\" was not on the Train tab after the relaunch"
expect "id=\"routine-title\" label=\"$routine_name\"" "\"$routine_name\" did not open from the Train tab after the relaunch"
tap 'id="start-routine"'
expect 'id="workout"' "Start workout did not open the workout"
expect "id=\"workout-title\" label=\"$routine_name\"" "The workout in progress is not \"$routine_name\""
for set in 1 2 3; do
  bring "id=\"workout-set-0-$((set - 1))\" label=\"Set $set, $target, To do\"" \
    "Set $set of the workout is not filled in with $target"
done
screenshot workout

link "svett://train"
expect 'id="workout-in-progress-row"' "The Train tab did not show the workout in progress"
screenshot train-workout-in-progress

echo "\"$routine_name\" started a workout with $exercise_name and three sets of $target. Screenshots are in $out"
