#!/usr/bin/env bash
# Proves the Hevy import on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/hevy.sh [--release] [out-dir]
#
# At the largest text size, on a new empty database, it imports the synthetic
# Hevy sample in packages/core/test-data. It matches one unknown exercise name
# to the first suggestion on the match screen, keeps the other as a new
# exercise, and checks the database holds the sample's three workouts and 25
# sets. It imports the sample again and checks nothing was added. It imports
# the changed sample, with one workout changed and one renamed, checks both are
# listed as changed and nothing is new, takes both, and checks the database
# holds the new versions. Last it undoes that import and checks the earlier
# versions are back. It reaches the screens through svett://import links,
# because agent-device 0.21.37 refuses selector presses in screen content on
# iOS 27, so it presses an element's centre instead, as checks.sh does.
# Screenshots and summary.txt go to out-dir, by default
# ~/svett-proof/<branch>/hevy/. Like tabs.sh, Debug opens the development
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/hevy}
bundle_id=com.kron00.svett
you_tab='label="You, tab, 5 of 5"'
progress_tab='label="Progress, tab, 3 of 5"'
counts='id="workout-counts"'
sample=svett-hevy-sample.csv
changed=svett-hevy-changed.csv
# Each workout as "title sets heaviest-kg", by start time.
imported_state="Push Day 8 100 | Pull Day 8 160 | Legs 9 120"
changed_state="Push Day 7 102.5 | Back Day 8 160 | Legs 9 120"

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
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
documents="$data/Documents"
database="$documents/svett-hevy.db"
mkdir -p "$documents"
# A journal left by an earlier run would be replayed onto a fresh file.
rm -f "$database" "$database-wal" "$database-shm"
cp packages/core/test-data/hevy-sample.csv "$documents/$sample"
cp packages/core/test-data/hevy-sample-changed.csv "$documents/$changed"
echo "Copied the Hevy samples to $documents"

launch_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || launch_flags+=(--launch-url "$(dev_client_url "http://$metro")")

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

fail() {
  echo "$*" >&2
  exit 1
}

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
  reveal "$1"
  press_centre "$1"
}

launch_on() {
  agent_device open "$bundle_id" "${launch_flags[@]}" --launch-args=-svettFixture "--launch-args=$1"
  agent_device wait "$you_tab" 120000
}

open_link() {
  agent_device open "$bundle_id" "$1"
  agent_device wait "$2" 180000
  agent_device wait 1000
}

# text_of <element> prints the element's text after it is on screen.
text_of() {
  reveal "$1"
  agent_device get text "$1"
}

show_counts() {
  agent_device press "$progress_tab"
  agent_device wait "$counts" 10000
  agent_device wait absent "$counts label=\"Opening the database\"" 60000
  screenshot "$1"
  shown=$(agent_device get text "$counts")
}

is_count() {
  [[ "$1" =~ (^|[^0-9])$2\ workouts,\ $3\ sets ]]
}

# sql <query> prints the query's rows from svett's database, one per line, fields joined by "|".
sql() {
  node -e '
    const database = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
    for (const row of database.prepare(process.argv[2]).all()) console.log(Object.values(row).join("|"));
  ' "$database" "$1"
}

# state prints each live workout as "title sets heaviest-kg", by start time.
state() {
  sql "SELECT a.title, count(s.id), max(s.weight_kg) FROM activity a
         JOIN activity_exercise ae ON ae.activity_id = a.id AND ae.deleted_at IS NULL
         JOIN activity_set s ON s.activity_exercise_id = ae.id AND s.deleted_at IS NULL
       WHERE a.deleted_at IS NULL GROUP BY a.id ORDER BY a.started_at" |
    tr '|' ' ' | paste -sd '|' - | sed 's/|/ | /g'
}

batches() {
  sql "SELECT status FROM import_batch ORDER BY created_at" | paste -sd ' ' -
}

summary="$out/summary.txt"
: >"$summary"
note() {
  echo "$*" | tee -a "$summary"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large

launch_on "$database"
show_counts empty
is_count "$shown" 0 0 || fail "The new database is not empty: $shown"
note "Empty database: $shown."

open_link "svett://import?file=$sample&kind=hevy" 'id="hevy-match"'
screenshot match
tap 'id="match-1-0"'
screenshot match-chosen
tap 'id="match-continue"'
# At the largest text size the buttons and lists start below the fold, so the script
# waits for the summary at the top of the preview, and tap and reveal scroll to the rest.
agent_device wait 'id="hevy-summary"' 60000
screenshot preview
said=$(text_of 'id="hevy-summary"')
[[ "$said" == *"3 workouts and 25 sets"* ]] || fail "The preview does not count the sample: $said"
note "Preview: $said"
started=$(date +%s)
tap 'id="import-apply"'
agent_device wait 'id="import-done"' 300000
note "Import took about $(($(date +%s) - started)) seconds, counted from the press."
screenshot imported
now=$(state)
[[ "$now" == "$imported_state" ]] || fail "The sample did not import as expected: $now"
matched=$(sql "SELECT e.name FROM exercise_alias x JOIN exercise e ON e.id = x.exercise_id
               WHERE x.deleted_at IS NULL AND x.name = 'Chest Supported Machine Row'")
[[ -n "$matched" ]] || fail "The match screen remembered no exercise for Chest Supported Machine Row"
note "First import: $now. Chest Supported Machine Row matched to $matched, and remembered."

open_link "svett://import?file=$sample&kind=hevy" 'id="hevy-summary"'
reveal 'id="import-nothing-new"' || fail "Importing the sample again does not say nothing is new"
screenshot import-again
[[ "$(state)" == "$imported_state" ]] || fail "Importing the sample again changed the workouts: $(state)"
[[ "$(batches)" == applied ]] || fail "Importing the sample again recorded another import: $(batches)"
note "Same file again: nothing new, no name asked again, one import on record."

open_link "svett://import?file=$changed&kind=hevy" 'id="hevy-summary"'
reveal 'id="import-changed"' || fail "The changed sample lists no changed workout"
screenshot changed-preview
first=$(text_of 'id="import-changed-0"')
second=$(text_of 'id="import-changed-1"')
[[ "$first" == *"Back Day"* && "$second" == *"Push Day"* ]] ||
  fail "The preview does not list the renamed and the changed workout as changed: $first / $second"
if reveal 'id="import-new"' >/dev/null 2>&1; then
  fail "The changed sample shows new records, so a changed workout would be a duplicate"
fi
note "Changed sample: Back Day and Push Day listed as changed, nothing new."
tap 'id="import-changed-0"'
tap 'id="import-changed-1"'
screenshot changed-taken
tap 'id="import-apply"'
agent_device wait 'id="import-done"' 300000
screenshot changed-imported
now=$(state)
[[ "$now" == "$changed_state" ]] || fail "Taking the new versions did not give Hevy's new workouts: $now"
note "Took both: $now."

tap 'id="import-undo"'
agent_device wait 'id="undo-import"' 60000
screenshot undo-preview
tap 'id="undo-apply"'
agent_device wait 'id="undo-done"' 300000
screenshot undone
now=$(state)
[[ "$now" == "$imported_state" ]] || fail "Undo did not give back the earlier versions: $now"
[[ "$(batches)" == "applied undone" ]] || fail "Undo did not mark the import undone: $(batches)"
note "Undo: $now, the earlier versions."

launch_on "$database"
show_counts counts-after-undo
is_count "$shown" 3 25 || fail "Progress does not count the sample after Undo: $shown"
note "After a relaunch: $shown."

echo "Screenshots and summary.txt are in $out"
