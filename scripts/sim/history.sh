#!/usr/bin/env bash
# Takes the P1 history proof on rena-devbook with the 300-workout fixture. Run it
# after devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/history.sh [--release] [out-dir]
#
# At the largest text size it generates the fixture, copies it into the app's data
# container and relaunches on it. Then it scrolls the history list down until the
# oldest workout's row is on screen, failing when a screen shows no row or after
# 600 screens, opens the newest workout, edits its first
# set to 222.5 kg and fails unless the detail shows the new weight, saves the
# workout as a routine, deletes it and checks the count drops to 299, undoes and
# checks it is back at 300, and opens the calendar for October 2026. It reaches
# the workout, the set and the calendar through svett:// links and presses screen
# content at an element's centre, because agent-device 0.21.37 refuses selector
# presses in screen content on iOS 27. Numbered screenshots go to out-dir, by
# default ~/svett-proof/<branch>/history/. Like tabs.sh, Debug opens the
# development client on Metro at SVETT_METRO, --release opens the installed
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/history}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
progress_tab='label="Progress, tab, 3 of 5"'
edited_weight=222.5
# Stops a list that never reaches its oldest workout.
max_scrolls=600

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

fail() {
  echo "$1" >&2
  exit 1
}

mkdir -p "$out"
out=$(cd "$out" && pwd)

restore() {
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

shot=0
screenshot() {
  shot=$((shot + 1))
  local path
  path=$(printf '%s/%02d-%s.png' "$out" "$shot" "$1")
  agent_device screenshot "$path"
  echo "Saved $path"
}

# Scrolls the screen until the element $1 is on screen.
reveal() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1"
}

# agent-device 0.21.37 refuses a selector press inside screen content on iOS 27 as
# covered by another element. It reads UIKit's touch-transparent floating bar
# containers as toolbars over the whole screen. A press at coordinates skips that
# check, so press_centre presses the centre of the element's frame from the snapshot.
press_centre() {
  local frame point
  frame=$(agent_device get attrs "$1") || return 1
  point=$(node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame") || return 1
  agent_device press "${point% *}" "${point#* }"
}

tap() {
  reveal "$1" || fail "Could not bring $1 on screen"
  press_centre "$1"
}

# expect_text <selector> <text> fails unless the element's text holds <text>.
expect_text() {
  local text
  reveal "$1" || fail "Could not bring $1 on screen"
  text=$(agent_device get text "$1") || fail "Could not read $1"
  [[ "$text" == *"$2"* ]] || fail "Expected $1 to show \"$2\", but it shows \"$text\""
  echo "$1 shows \"$2\""
}

open_link() {
  agent_device open "$bundle_id" "$1"
}

pnpm fixture --out "$out/svett-fixture.db"
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
fixture="$data/Documents/svett-fixture.db"
mkdir -p "$data/Documents"
# A journal left by an earlier run would be replayed onto the fresh copy.
rm -f "$fixture-wal" "$fixture-shm"
cp "$out/svett-fixture.db" "$fixture"
echo "Copied the fixture to $fixture"

# The newest and oldest workouts, and the newest one's first normal set with reps in it.
read -r workout set_id reps oldest < <(node -e '
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(process.argv[1], { readOnly: true });
  const live = "SELECT id FROM activity WHERE deleted_at IS NULL ORDER BY started_at";
  const workout = database.prepare(`${live} DESC, id DESC LIMIT 1`).get();
  const oldest = database.prepare(`${live}, id LIMIT 1`).get();
  const set = database
    .prepare(`SELECT s.id, s.reps FROM activity_set s
      JOIN activity_exercise e ON e.id = s.activity_exercise_id
      WHERE e.activity_id = ? AND s.set_type = ? AND s.reps IS NOT NULL AND s.deleted_at IS NULL
      ORDER BY e.position, s.position LIMIT 1`)
    .get(workout.id, "normal");
  console.log(workout.id, set.id, set.reps, oldest.id);
' "$out/svett-fixture.db" 2>/dev/null)
[[ -n "${oldest:-}" ]] || fail "The fixture has no workout with a normal set"
echo "Newest workout $workout, set $set_id with $reps reps, oldest workout $oldest"

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
if [[ "$release" == true ]]; then
  scripts/sim/launch.sh --release -svettFixture "$fixture"
else
  scripts/sim/launch.sh -svettFixture "$fixture"
fi

agent_device wait "$progress_tab" 120000
agent_device press "$progress_tab"
agent_device wait 'id="history-list"' 10000
expect_text 'id="workout-counts"' "300 workouts"
# The progress sections and the streak sit above the rows, so at the largest text
# size the first row starts below the fold.
reveal 'id="history-row"'
screenshot history

# The list loads 60 workouts at a time as it nears its end, and Legend List draws
# rows ahead of the scroll, so every screen down to the oldest workout has rows.
scroll=0
until agent_device is visible "id=\"workout-$oldest\"" >/dev/null 2>&1; do
  ((scroll < max_scrolls)) || {
    screenshot "history-no-end"
    fail "The oldest workout was not on screen after $max_scrolls scrolls"
  }
  agent_device scroll down
  scroll=$((scroll + 1))
  agent_device is visible 'id="history-row"' >/dev/null 2>&1 ||
    {
      screenshot "blank-after-scroll-$scroll"
      fail "The history list showed no row after scroll $scroll"
    }
  ((scroll % 50 != 0)) || screenshot "history-scroll-$scroll"
done
screenshot history-oldest
echo "The history list showed rows on all $scroll screens down to the oldest workout"

open_link "svett://workout/$workout"
agent_device wait 'id="workout-detail"' 10000
agent_device wait 1000
screenshot workout
reveal 'id="muscle-split"'
screenshot muscle-split
reveal "id=\"set-$set_id\""
screenshot set-before-edit

open_link "svett://workout/$workout/set/$set_id"
agent_device wait 'id="set-edit"' 10000
agent_device wait 1000
screenshot set-edit
# The longest weight the keypad takes, 9999.99, is seven characters.
for _ in 1 2 3 4 5 6 7; do
  tap 'label="Delete"'
done
for key in 2 2 2 . 5; do
  if [[ "$key" == . ]]; then
    tap 'label="Decimal point"'
  else
    tap "label=\"$key\""
  fi
done
screenshot set-typed
tap 'id="set-edit-save"'
agent_device wait 'id="workout-detail"' 10000
agent_device wait 1000
expect_text "id=\"set-$set_id\"" "$edited_weight kg × $reps"
screenshot set-edited
expect_text 'id="workout-records"' "Records"
screenshot records

tap 'id="workout-save-routine"'
agent_device wait 'id="routine-saved"' 10000 || fail "Save as routine did not confirm"
screenshot saved-as-routine

tap 'id="workout-delete"'
agent_device wait 'id="undo-delete-banner"' 10000 || fail "Deleting did not offer Undo"
expect_text 'id="workout-counts"' "299 workouts"
screenshot deleted
press_centre 'id="undo-delete"'
agent_device wait absent 'id="undo-delete-banner"' 10000 || fail "Undo did not finish"
expect_text 'id="workout-counts"' "300 workouts"
reveal "id=\"workout-$workout\"" || fail "The workout did not come back after Undo"
screenshot undone

open_link "svett://calendar?month=2026-10"
agent_device wait 'id="calendar"' 10000
agent_device wait 1000
expect_text 'id="calendar-month"' "2026"
agent_device is visible 'id="calendar-streak"' >/dev/null 2>&1 || fail "The calendar shows no streak"
screenshot calendar
expect_text 'id="calendar-count"' "workouts in"
screenshot calendar-month

echo "Screenshots are in $out"
