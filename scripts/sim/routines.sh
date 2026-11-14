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
# by an earlier run is discarded first, which takes svett back to the Train tab.
# It fails when a screen, the exercise, a target or a set is missing.
#
# It also times a cold start to the Train tab's routine list, from the relaunch
# until the list shows, and saves it as cold-start.txt. The time includes
# agent-device's own calls, so it is an upper bound. Only a Release build's time
# counts against the plan's 2 second target, which the plan measures with the
# 300-workout database. SVETT_FIXTURE, the absolute path of a fixture database
# in the app's data container such as fixture.sh copies there, relaunches svett
# on that database every time.
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
[[ -z "${SVETT_FIXTURE:-}" ]] || open_flags+=(--launch-args=-svettFixture "--launch-args=$SVETT_FIXTURE")

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
build=$([[ "$release" == true ]] && echo Release || echo "Debug, loaded from Metro")
[[ -z "${SVETT_FIXTURE:-}" ]] || build="$build, on the fixture database"
echo "Cold start to the Train tab's routine list: $cold_start ms ($build, including agent-device's calls)" |
  tee "$out/cold-start.txt"
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
