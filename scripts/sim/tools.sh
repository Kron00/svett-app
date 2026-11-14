#!/usr/bin/env bash
# Takes the logger tools proof on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/tools.sh [--release] [out-dir]
#
# It generates the 300-workout fixture with pnpm fixture, copies it into the
# app's data container as Documents/svett-tools.db, grants notifications ahead,
# and launches svett on it. Then, at the largest text size:
#
#   1. It opens Units and plates through svett://settings/workout and switches
#      weights to pounds.
#   2. It starts an empty workout and adds Barbell Squat and Romanian Deadlift.
#      It sets Barbell Squat's rest to 0:30 from the exercise's options, types
#      225 lb for 5 into its first working set and marks it done, which starts
#      the rest.
#   3. In the very next call it goes to the Home Screen, before any screenshot
#      or database check, so the rest runs out with svett in the background. It
#      waits on SpringBoard for the rest timer's notification, "Rest is over".
#   4. It relaunches svett, reopens the workout, checks the set reads 225 lb
#      and done, and that the database holds 225 lb as kilograms. It joins
#      Barbell Squat with Romanian Deadlift in a superset from the options. It
#      checks both read Superset A, that Barbell Squat's warm-up set starts no
#      rest, and that a set of Romanian Deadlift, the last of the round, does.
#   5. It kills and relaunches svett while that rest runs, and checks the rest
#      timer is back on the workout.
#   6. It opens the plate calculator from Barbell Squat's options and checks
#      225 lb loads two 45 lb plates a side. It opens svett://tools/plates?kg=100
#      and checks 220.46 lb shows the nearest loads either side.
#   7. It finishes the workout and checks the database holds the superset and
#      the 225 lb set.
#
# It fails when a screen, a value, the notification or a database row is
# missing. Every step waits for a screen's top element and scrolls to anything
# below it, because at the largest text size the workout is several screens
# tall. It opens screens through svett:// links and presses an element at the
# centre of its frame, because agent-device 0.21.37 refuses a selector press
# inside screen content on iOS 27. It presses only controls whose centre is
# clear of the screen's bottom edge, so it never presses the keypad's Next and
# Done or the rest timer's buttons there. Before it presses an entry field it
# reads the field's frame until it stops moving, and it types only once the
# field is selected with the keypad open, pressing it once more if not. Numbered
# screenshots go to out-dir, by default ~/svett-proof/<branch>/tools/. Like
# tabs.sh, Debug opens the development client on Metro at SVETT_METRO, --release
# opens the installed Release build, and every step runs through
# SVETT_DEVICE_CMD when it is set. simctl only finds the data container.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/tools}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The Train tab showing means the app has loaded and can take a link.
train_tab='label="Train, tab, 2 of 5"'
banner='Rest is over'
safe_bottom=${SVETT_SAFE_BOTTOM:-880}

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
pnpm fixture --out "$out/svett-fixture.db" >/dev/null
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
database="$data/Documents/svett-tools.db"
mkdir -p "$data/Documents"
# A journal left by an earlier run would be replayed onto the fresh copy.
rm -f "$database-wal" "$database-shm"
cp "$out/svett-fixture.db" "$database"
echo "Copied the fixture to $database"

open_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")
open_flags+=(--launch-args=-svettFixture "--launch-args=$database")

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
  agent_device wait "$train_tab" 120000 || fail "svett did not show its tabs after the launch"
}

link() {
  agent_device open "$bundle_id" "$1"
}

# expect <selector> <what is missing, for the failure message>: waits for a
# screen's top element, which is on screen as soon as the screen opens.
expect() {
  agent_device wait "$1" 10000 >/dev/null || fail "$2"
}

# bring <selector> [what is missing]: scrolls until the element is on screen, up
# or down, because at the largest text size the workout is taller than the screen.
bring() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1" >/dev/null 2>&1 ||
    fail "${2:-$1 never came on screen}"
}

# label_of <selector>: brings the element on screen and prints its label.
label_of() {
  local attrs
  bring "$1"
  attrs=$(agent_device get attrs "$1") || fail "$1 is not on screen"
  node -e 'console.log(JSON.parse(process.argv[1]).label ?? "")' "$attrs"
}

centre_of() {
  local frame
  frame=$(agent_device get attrs "$1") || return 1
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

# settled_centre <selector>: the centre of the element's frame once two reads in
# a row agree, because the workout keeps gliding for a moment after a pan or a
# scroll, and a press at a frame read during the glide lands beside the element.
settled_centre() {
  local before after reads=0
  before=$(centre_of "$1") || return 1
  while ((reads < 10)); do
    agent_device wait 250 >/dev/null
    after=$(centre_of "$1") || return 1
    if [[ "$after" == "$before" ]]; then
      echo "$after"
      return 0
    fi
    before=$after
    reads=$((reads + 1))
  done
  return 1
}

# clear_point <selector> [settle]: prints the centre of the element's frame. One
# whose centre sits at the bottom edge, where iOS 27 keeps the home indicator, is
# dragged up first, and its frame is then read until it settles. With settle it
# is read until it settles anyway.
clear_point() {
  local point drags=0 settle=${2:-}
  point=$(centre_of "$1") || fail "$1 is not on screen"
  while ((${point#* } > safe_bottom)); do
    ((drags < 3)) || fail "$1 stayed at the bottom edge of the screen"
    agent_device gesture pan 20 600 0 -300 400 >/dev/null
    drags=$((drags + 1))
    settle=true
    point=$(centre_of "$1") || fail "$1 is not on screen"
  done
  if [[ -n "$settle" ]]; then
    point=$(settled_centre "$1") || fail "$1 kept moving on screen"
  fi
  echo "$point"
}

# tap <selector> [what is missing]: brings the element on screen and presses the
# centre of its frame.
tap() {
  local point
  bring "$@"
  point=$(clear_point "$1")
  agent_device press "${point% *}" "${point#* }"
}

# field <id> <name>: presses an entry field of the workout and waits until it is
# selected with the keypad open, because keys pressed while the press missed go
# to another field or nowhere. A press that missed is tried once more.
field() {
  local selector="id=\"$1\"" point attempt
  for attempt in 1 2; do
    bring "$selector" "$2 never came on screen"
    point=$(clear_point "$selector" settle)
    agent_device press "${point% *}" "${point#* }"
    if agent_device wait "$selector selected=true" 3000 >/dev/null 2>&1 &&
      agent_device wait 'id="key-2"' 3000 >/dev/null 2>&1; then
      return 0
    fi
    echo "Pressing $2 did not select it with the keypad open, try $attempt of 2" >&2
  done
  fail "Pressing $2 ($selector) did not select it and open the keypad, after two presses"
}

# key <digit>...: presses keys on the keypad, which stays open over the workout.
key() {
  local digit
  for digit in "$@"; do
    tap "id=\"key-$digit\""
  done
}

expect_set() {
  bring "id=\"workout-set-$1-$2\" label=\"$3\"" "Set $(($2 + 1)) of exercise $(($1 + 1)) does not read \"$3\""
}

expect_exercise() {
  bring "id=\"workout-exercise-$1\" label=\"$2\"" "Exercise $(($1 + 1)) of the workout is not $2"
}

# option <exercise> <label>: opens an exercise's options and presses one. The
# options are an action sheet, whose buttons are found by their labels.
option() {
  tap "id=\"exercise-options-$1\""
  # iOS nests each sheet button in containers with the same label, so ask for the button.
  agent_device wait "role=\"button\" label=\"$2\"" 5000 >/dev/null || fail "The options of exercise $(($1 + 1)) have no \"$2\""
  tap "role=\"button\" label=\"$2\""
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

add_exercise() {
  link "svett://train/workout/exercises?q=$(encode "$1")"
  expect 'id="exercise-library"' "The exercise picker did not open"
  agent_device wait 1000
  choose_first_result "$2"
  expect 'id="workout"' "Choosing $2 did not go back to the workout"
}

# check_rows <name> <title> <expected line>...: copies the database with its
# write-ahead log and checks the workout's rows include each line, in order.
check_rows() {
  local name=$1 title=$2 copy
  shift 2
  copy="$out/$name.db"
  rm -f "$copy" "$copy-wal" "$copy-shm"
  cp "$database" "$copy"
  [[ ! -f "$database-wal" ]] || cp "$database-wal" "$copy-wal"
  node scripts/workout-rows.ts workout "$copy" "$title" >"$out/$name.txt" ||
    fail "The database holds no workout called \"$title\""
  printf '%s\n' "$@" >"$out/$name-expected.txt"
  # shellcheck disable=SC2016 # The ${...} are JavaScript template literals.
  node -e '
    const [found, expected] = process.argv.slice(1).map((path) =>
      require("node:fs").readFileSync(path, "utf8").trimEnd().split("\n"));
    let at = 0;
    for (const line of expected) {
      at = found.indexOf(line, at);
      if (at === -1) {
        console.error(`Missing from the database: ${line}`);
        process.exit(1);
      }
      at += 1;
    }
  ' "$out/$name.txt" "$out/$name-expected.txt" ||
    fail "The database does not hold \"$title\" as logged. See $out/$name.txt"
  echo "The database holds \"$title\" as logged. See $out/$name.txt"
}

# The kilograms svett stores for 225 lb, as the app converts them.
squat_kg=$(node -e 'console.log(225 * 0.45359237)')

if ! agent_device settings permission grant notifications; then
  echo "Could not grant notifications ahead, so the first rest answers the prompt" >&2
  ask_permission=true
else
  ask_permission=false
fi

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
relaunch

link "svett://settings/workout"
expect 'id="workout-settings"' "Units and plates did not open"
tap 'label="Pounds"' "Units and plates has no Pounds"
bring 'id="unit-note" label="Weights show and are typed in pounds. svett stores kilograms, so switching changes no workout."' \
  "Units and plates did not switch to pounds"
screenshot pounds

link "svett://train"
expect 'id="train"' "The Train tab did not open"
tap 'id="start-empty-workout"' "The Train tab has no Start empty workout"
expect 'id="workout"' "Start empty workout did not open the workout"
title=$(label_of 'id="workout-title"')
[[ "$title" == *" workout" ]] || fail "The empty workout is called \"$title\""
add_exercise "barbell squat" "Barbell Squat"
add_exercise "romanian deadlift" "Romanian Deadlift"
expect_exercise 0 "Barbell Squat"
expect_exercise 1 "Romanian Deadlift"

option 0 "Rest timer: 1:30"
expect 'id="rest-sheet"' "The rest timer's times did not open"
tap 'id="rest-sheet-30"'
expect 'id="workout"' "Choosing a rest time did not go back to the workout"

# The fixture's last Barbell Squat began with a warm-up, so its first working set is the second.
field set-0-1-weight "the weight of Barbell Squat's first working set"
key 2 2 5
field set-0-1-reps "the reps of Barbell Squat's first working set"
key 5
expect_set 0 1 "Set 1, 225 lb, 5 reps, To do"
screenshot pounds-typed
# Marking the set done starts the 30 second rest. svett leaves in the very next
# call, before any screenshot or database check, so the rest runs out with svett
# in the background and its notification shows on the Home Screen.
tap 'id="workout-set-0-1"'
[[ "$ask_permission" == false ]] || {
  agent_device alert wait 5000 >/dev/null 2>&1 && agent_device alert accept || true
}
agent_device home
agent_device open com.apple.springboard
agent_device wait text "$banner" 60000 ||
  fail "The rest timer's notification did not show with svett in the background"
screenshot rest-notification

relaunch
link "svett://train/workout"
expect 'id="workout"' "The workout did not open after the relaunch"
expect 'id="workout-title"' "The workout in progress did not come back after the relaunch"
expect_set 0 1 "Set 1, 225 lb, 5 reps, Done"
screenshot set-done
check_rows pounds "$title" "Exercise 1: Barbell Squat, by weight_reps" \
  "Set 1.2: normal, $squat_kg kg, 5 reps, done"
option 0 "Superset with next exercise"
bring 'id="workout-superset-0" label="Superset A"' "Barbell Squat is not in Superset A"
bring 'id="workout-superset-1" label="Superset A"' "Romanian Deadlift is not in Superset A"
# The warm-up set, done from last time's values. Working sets still to do stay
# empty, so the plate calculator below opens on the 225 lb set.
tap 'id="workout-set-0-0"'
agent_device wait 1500
! agent_device is visible 'id="rest-timer"' >/dev/null 2>&1 ||
  fail "A set of Barbell Squat, first in its superset, started a rest"
tap 'id="workout-set-1-0"'
bring 'id="rest-timer"' "A set of Romanian Deadlift, last in its superset, started no rest"
screenshot superset

# A rest outlives a killed svett.
relaunch
link "svett://train/workout"
expect 'id="workout"' "The workout did not open after the relaunch"
bring 'id="rest-timer"' "The rest did not come back after svett was killed"
screenshot rest-restored

option 0 "Plate calculator"
expect 'id="plates"' "The plate calculator did not open"
bring 'id="plates-result" label="On the barbell, 225 lb. Each side, 2 plates of 45 lb."' \
  "The plate calculator does not load 225 lb with two 45 lb plates a side"
screenshot plates
link "svett://tools/plates?kg=100"
expect 'id="plates"' "The plate calculator did not open from its link"
bring 'id="plates-result" label="Your plates cannot make 220.46 lb exactly."' \
  "The plate calculator does not say 100 kg, 220.46 lb, cannot be made"
bring 'id="plates-lighter" label="Nearest lighter, 220 lb. Each side, 1 plate of 45 lb, 1 plate of 35 lb, 1 plate of 5 lb, 1 plate of 2.5 lb."' \
  "The plate calculator does not offer 220 lb"
bring 'id="plates-heavier" label="Nearest heavier, 225 lb. Each side, 2 plates of 45 lb."' \
  "The plate calculator does not offer 225 lb"
screenshot plates-nearest

link "svett://train/workout"
expect 'id="workout"' "The workout did not open"
# Finish is a native bar item, which carries its label but no identifier.
tap 'label="Finish"'
agent_device alert wait 5000 >/dev/null || fail "Finish asked nothing"
# The confirmation is svett's own alert, which agent-device's alert accept cannot
# answer, so its button is pressed by its label like any other control.
tap 'label="Finish workout"'
agent_device wait absent 'id="workout-bar"' 10000 >/dev/null ||
  fail "The workout bar still shows after Finish"
screenshot finished
check_rows finished "$title" "$title: finished" \
  "Exercise 1: Barbell Squat, by weight_reps, superset 0" \
  "Set 1.2: normal, $squat_kg kg, 5 reps, done" \
  "Exercise 2: Romanian Deadlift, by weight_reps, superset 0"

echo "Typed 225 lb and stored $squat_kg kg, saw the rest notification with svett in the background, rested only after a superset's round, kept a rest through a relaunch, and loaded plates in pounds. Screenshots are in $out"
