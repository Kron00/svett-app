#!/usr/bin/env bash
# Takes the logger proof on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/logger.sh [--release] [out-dir]
#
# It generates the 300-workout fixture with pnpm fixture, copies it into the
# app's data container as Documents/svett-logger.db, and launches svett on it
# every time, with -svettTiming 1 so the workout screen shows how long the last
# set took to show done. Then, at the largest text size:
#
#   1. It starts the fixture's Legs routine and logs Barbell Squat on the keypad:
#      100 kg for 5 twice, a set changed to a failure set for 4, and one added
#      set that copies it. It moves Barbell Squat below Romanian Deadlift, types
#      80 kg into Romanian Deadlift's first set without marking it done, adds
#      Plank through the exercise picker and logs it for 1:00.
#   2. It kills svett with simctl terminate, launches it again, opens the
#      workout from the bar above the tabs, and checks every set and value came
#      back. It reads the database file and checks the same rows are there.
#   3. It finishes the workout and checks the database holds it finished with
#      every done set, and without the set that was never marked done.
#   4. It starts an empty workout from the Train tab, adds Barbell Squat, checks
#      the first set shows last time's 100 kg × 5, marks it done so it takes
#      those values, saves the time it took to show done as set-done.txt, and
#      finishes. It checks the database holds that workout too.
#
# It fails when a screen, a set, a value or a database row is missing. It reads
# the database from a copy of the file and its write-ahead log in out-dir.
#
# Every step waits for a screen's top element and scrolls to anything below it,
# because at the largest text size the workout is several screens tall. It
# opens screens through svett:// links and presses an element at the centre of
# its frame, because agent-device 0.21.37 refuses a selector press inside
# screen content on iOS 27. Numbered screenshots go to out-dir, by default
# ~/svett-proof/<branch>/logger/. Like tabs.sh, Debug opens the development
# client on Metro at SVETT_METRO, --release opens the installed Release build,
# and every step runs through SVETT_DEVICE_CMD when it is set. simctl only finds
# the data container and kills svett.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/logger}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The Train tab showing means the app has loaded and can take a link.
train_tab='label="Train, tab, 2 of 5"'

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
database="$data/Documents/svett-logger.db"
mkdir -p "$data/Documents"
# A journal left by an earlier run would be replayed onto the fresh copy.
rm -f "$database-wal" "$database-shm"
cp "$out/svett-fixture.db" "$database"
echo "Copied the fixture to $database"

open_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")
open_flags+=(--launch-args=-svettFixture "--launch-args=$database" --launch-args=-svettTiming --launch-args=1)

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
    agent_device scroll up --until "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    fail "${2:-$1 never came on screen}"
}

# label_of <selector>: brings the element on screen and prints its label.
label_of() {
  local attrs
  bring "$1"
  attrs=$(agent_device get attrs "$1") || fail "$1 is not on screen"
  node -e 'console.log(JSON.parse(process.argv[1]).label ?? "")' "$attrs"
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

# type_into <field selector> <key>...: opens the keypad on a field and types.
type_into() {
  local field=$1 key
  shift
  tap "$field"
  for key in "$@"; do
    tap "id=\"key-$key\""
  done
}

# log_set <exercise> <set> <weight keys> <reps keys>: types a set's weight, moves
# to its reps with Next, types them, closes the keypad and marks the set done.
log_set() {
  local weight=$3 reps=$4
  # shellcheck disable=SC2046 # one key per character
  type_into "id=\"set-$1-$2-weight\"" $(echo "$weight" | grep -o .)
  tap 'id="keypad-next"'
  local key
  for key in $(echo "$reps" | grep -o .); do
    tap "id=\"key-$key\""
  done
  tap 'id="keypad-done"'
  tap "id=\"workout-set-$1-$2\""
}

# expect_set <exercise> <set> <label>: the set's done box reads its values and state.
expect_set() {
  bring "id=\"workout-set-$1-$2\" label=\"$3\"" "Set $(($2 + 1)) of exercise $(($1 + 1)) does not read \"$3\""
}

expect_exercise() {
  bring "id=\"workout-exercise-$1\" label=\"$2\"" "Exercise $(($1 + 1)) of the workout is not $2"
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
  link "svett://workout/exercises?q=$(encode "$1")"
  expect 'id="exercise-library"' "The exercise picker did not open"
  agent_device wait 1000
  choose_first_result "$2"
  expect 'id="workout"' "Choosing $2 did not go back to the workout"
}

# check_rows <exact|includes> <name> <title> <expected line>...: copies the
# database with its write-ahead log and checks the workout's rows are exactly
# the lines given, or include each of them in that order.
check_rows() {
  local mode=$1 name=$2 title=$3 copy
  shift 3
  copy="$out/$name.db"
  rm -f "$copy" "$copy-wal" "$copy-shm"
  cp "$database" "$copy"
  [[ ! -f "$database-wal" ]] || cp "$database-wal" "$copy-wal"
  node scripts/workout-rows.ts workout "$copy" "$title" >"$out/$name.txt" ||
    fail "The database holds no workout called \"$title\""
  printf '%s\n' "$@" >"$out/$name-expected.txt"
  if [[ "$mode" == exact ]]; then
    diff -u "$out/$name-expected.txt" "$out/$name.txt" >&2 ||
      fail "The database does not hold \"$title\" as logged. See $out/$name.txt"
  else
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
  fi
  echo "The database holds \"$title\" as logged. See $out/$name.txt"
}

finish_workout() {
  # Finish is a native bar item, which carries its label but no identifier.
  tap 'label="Finish"'
  agent_device alert wait 5000 >/dev/null || fail "Finish asked nothing"
  # The confirmation is svett's own alert, which agent-device's alert accept cannot
  # answer, so its button is pressed by its label like any other control.
  tap 'label="Finish workout"'
  agent_device wait absent 'id="workout-bar"' 10000 >/dev/null ||
    fail "The workout bar still shows after Finish"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
relaunch
link "svett://train"
expect 'id="routine-list"' "The Train tab did not list the routines"
screenshot train

routine=$(node scripts/workout-rows.ts routine "$out/svett-fixture.db" Legs) ||
  fail "The fixture has no Legs routine"
link "svett://routine/$routine"
expect 'id="routine-detail"' "The Legs routine did not open"
tap 'id="start-routine"'
expect 'id="workout"' "Start workout did not open the workout"
expect 'id="workout-title" label="Legs"' "The workout in progress is not Legs"
expect_exercise 0 "Barbell Squat"
screenshot workout-started

log_set 0 0 100 5
expect_set 0 0 "Set 1, 100 kg, 5 reps, Done"
log_set 0 1 100 5
expect_set 0 1 "Set 2, 100 kg, 5 reps, Done"
tap 'id="workout-set-0-2-type"'
expect 'id="set-type-sheet"' "The set type sheet did not open"
tap 'id="set-type-sheet-failure"'
expect 'id="workout"' "Choosing a set type did not close the sheet"
log_set 0 2 100 4
expect_set 0 2 "Failure set, 100 kg, 4 reps, Done"
tap 'id="add-workout-set-0"'
tap 'id="workout-set-0-3"' "Add set added no set"
expect_set 0 3 "Failure set, 100 kg, 4 reps, Done"
screenshot squat-logged

tap 'id="move-exercise-down-0"'
expect_exercise 1 "Barbell Squat"
expect_exercise 0 "Romanian Deadlift"
type_into 'id="set-0-0-weight"' 8 0
tap 'id="keypad-done"'
expect_set 0 0 "Set 1, 80 kg, 6 to 10 reps, To do"

add_exercise plank Plank
expect_exercise 5 "Plank"
type_into 'id="set-5-0-time"' 1 0 0
tap 'id="keypad-done"'
tap 'id="workout-set-5-0"'
expect_set 5 0 "Set 1, 60 seconds, Done"
screenshot before-kill

xcrun simctl terminate "$udid" "$bundle_id"
echo "Killed svett mid-workout"
relaunch
bring 'id="workout-bar"' "The workout in progress did not show above the tabs after the kill"
screenshot restored-bar
tap 'id="workout-bar"'
expect 'id="workout"' "The workout bar did not open the workout"
expect 'id="workout-title" label="Legs"' "Legs did not come back after the kill"
expect_exercise 0 "Romanian Deadlift"
expect_set 0 0 "Set 1, 80 kg, 6 to 10 reps, To do"
expect_exercise 1 "Barbell Squat"
expect_set 1 0 "Set 1, 100 kg, 5 reps, Done"
expect_set 1 1 "Set 2, 100 kg, 5 reps, Done"
expect_set 1 2 "Failure set, 100 kg, 4 reps, Done"
expect_set 1 3 "Failure set, 100 kg, 4 reps, Done"
expect_exercise 5 "Plank"
expect_set 5 0 "Set 1, 60 seconds, Done"
screenshot restored
check_rows includes restored Legs "Legs: in_progress" "Notes: none" "Workouts in progress: 1" \
  "Exercise 1: Romanian Deadlift, by weight_reps" "Set 1.1: normal, 80 kg, to do" \
  "Set 1.2: normal, to do" "Set 1.3: normal, to do" \
  "Exercise 2: Barbell Squat, by weight_reps" \
  "Set 2.1: normal, 100 kg, 5 reps, done" "Set 2.2: normal, 100 kg, 5 reps, done" \
  "Set 2.3: failure, 100 kg, 4 reps, done" "Set 2.4: failure, 100 kg, 4 reps, done" \
  "Exercise 3: Leg Press, by weight_reps" "Set 3.1: normal, to do" "Set 3.2: normal, to do" \
  "Set 3.3: normal, to do" \
  "Exercise 4: Lying Leg Curls, by weight_reps" "Set 4.1: normal, to do" \
  "Set 4.2: normal, to do" "Set 4.3: normal, to do" \
  "Exercise 5: Standing Calf Raises, by weight_reps" "Set 5.1: normal, to do" \
  "Set 5.2: normal, to do" "Set 5.3: normal, to do" \
  "Exercise 6: Plank, by time" "Set 6.1: normal, 60 s, done"

finish_workout
screenshot finished
check_rows exact finished Legs "Legs: finished" "Notes: none" "Workouts in progress: 0" \
  "Exercise 1: Barbell Squat, by weight_reps" \
  "Set 1.1: normal, 100 kg, 5 reps, done" "Set 1.2: normal, 100 kg, 5 reps, done" \
  "Set 1.3: failure, 100 kg, 4 reps, done" "Set 1.4: failure, 100 kg, 4 reps, done" \
  "Exercise 2: Plank, by time" "Set 2.1: normal, 60 s, done"

link "svett://train"
expect 'id="train"' "The Train tab did not open"
tap 'id="start-empty-workout"' "The Train tab has no Start empty workout"
expect 'id="workout"' "Start empty workout did not open the workout"
title=$(label_of 'id="workout-title"')
[[ "$title" == *" workout" ]] || fail "The empty workout is called \"$title\""
add_exercise "barbell squat" "Barbell Squat"
expect_exercise 0 "Barbell Squat"
bring 'label="Previous, 100 kg × 5"' "The first set does not show last time's 100 kg × 5"
tap 'id="workout-set-0-0"'
expect_set 0 0 "Set 1, 100 kg, 5 reps, Done"
timing=$(label_of 'id="set-done-timing"')
[[ "$timing" =~ ^Set\ shown\ done\ in\ ([0-9]+)\ ms$ ]] || fail "The workout did not time the set marked done. It says \"$timing\""
build=$([[ "$release" == true ]] && echo Release || echo "Debug, loaded from Metro")
echo "Marking a set done until the row showed it: ${BASH_REMATCH[1]} ms ($build, on the fixture database, timed in the app)" |
  tee "$out/set-done.txt"
screenshot empty-workout
finish_workout
check_rows exact empty "$title" "$title: finished" "Notes: none" "Workouts in progress: 0" \
  "Exercise 1: Barbell Squat, by weight_reps" "Set 1.1: normal, 100 kg, 5 reps, done"

echo "Logged Legs from its routine and \"$title\" from empty, restored Legs after a kill, and found both in the database. Screenshots are in $out"
