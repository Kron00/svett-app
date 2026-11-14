#!/usr/bin/env bash
# Proves export, import and undo on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/data.sh [--release] [out-dir]
#
# At the largest text size, it opens the 300-workout fixture and exports it
# through the share sheet. Then it wipes, by launching on a new empty database,
# imports the export and checks the new database equals the fixture row for
# row. It imports the same file again and checks nothing was added. Last it
# undoes the import from Your data and checks every workout is gone. It reaches
# the screens through svett://data, svett://import?file=<name> and the rows on
# Your data, because agent-device 0.21.37 refuses selector presses in screen
# content on iOS 27, so it presses an element's centre instead, as checks.sh
# does. Screenshots, the export, the comparisons and summary.txt go to out-dir,
# by default ~/svett-proof/<branch>/data/. Like tabs.sh, Debug opens the
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/data}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
you_tab='label="You, tab, 5 of 5"'
progress_tab='label="Progress, tab, 3 of 5"'
counts='id="workout-counts"'
import_name=svett-proof-import.json

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
fixture="$documents/svett-fixture.db"
wiped="$documents/svett-wiped.db"
mkdir -p "$documents"

pnpm fixture --out "$out/svett-fixture.db"
# A journal left by an earlier run would be replayed onto a fresh file.
rm -f "$fixture" "$fixture-wal" "$fixture-shm" "$wiped" "$wiped-wal" "$wiped-shm" \
  "$documents/$import_name" "$data/Library/Caches"/svett-export-*.json
cp "$out/svett-fixture.db" "$fixture"
echo "Copied the fixture to $fixture"

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
  reveal "$1"
  press_centre "$1"
}

# launch_on <database> relaunches svett on that database file with -svettFixture.
launch_on() {
  agent_device open "$bundle_id" "${launch_flags[@]}" --launch-args=-svettFixture "--launch-args=$1"
  agent_device wait "$you_tab" 120000
}

# open_link <url> <element> opens a svett link and waits for the element.
open_link() {
  agent_device open "$bundle_id" "$1"
  agent_device wait "$2" 180000
  agent_device wait 1000
}

# show_counts <name> shows the Progress tab's counts after a relaunch, saves
# <name>.png and leaves the counts in $shown.
show_counts() {
  agent_device press "$progress_tab"
  agent_device wait "$counts" 10000
  agent_device wait absent "$counts label=\"Opening the database\"" 60000
  screenshot "$1"
  shown=$(agent_device get text "$counts")
}

# is_count <text> <workouts> <sets> checks the Progress text reads exactly that.
is_count() {
  [[ "$1" =~ (^|[^0-9])$2\ workouts,\ $3\ sets ]]
}

counts_of() {
  node scripts/compare-databases.ts counts "$1"
}

# json_field <json> <expression on c> prints the expression's value.
json_field() {
  node -e 'const c = JSON.parse(process.argv[1]); console.log(eval(process.argv[2]))' "$1" "$2"
}

summary="$out/summary.txt"
: >"$summary"
note() {
  echo "$*" | tee -a "$summary"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large

launch_on "$fixture"
fixture_counts=$(counts_of "$fixture")
workouts=$(json_field "$fixture_counts" 'c.live.activity')
sets=$(json_field "$fixture_counts" 'c.live.activity_set')
((workouts > 0)) || fail "The fixture has no workouts"
note "Fixture: $workouts workouts, $sets sets."

open_link svett://data 'id="data"'
screenshot data
tap 'id="export-button"'
agent_device wait 3000
screenshot share-sheet
# The share sheet covers Your data. Close it, or a relaunch closes it.
agent_device alert dismiss >/dev/null 2>&1 || press_centre 'label="Close"' ||
  echo "Could not close the share sheet, so the next relaunch closes it" >&2

export_file=$( (find "$data/Library/Caches" -maxdepth 1 -name 'svett-export-*.json' 2>/dev/null || true) | sort | tail -1)
[[ -n "$export_file" ]] || fail "Export wrote no svett-export-*.json to svett's cache folder"
cp "$export_file" "$out/"
cp "$export_file" "$documents/$import_name"
header=$(node -e '
  const file = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const rows = Object.values(file.tables).reduce((sum, rows) => sum + rows.length, 0);
  console.log(file.format, file.version, Object.keys(file.tables).length, rows);
' "$export_file")
read -r format version tables rows <<<"$header"
[[ "$format" == svett && "$version" == 1 ]] || fail "The export is not a version 1 svett file: $header"
note "Export: $(basename "$export_file"), $tables tables, $rows rows."

# Wiping is a launch on a database file that does not exist yet.
launch_on "$wiped"
show_counts wiped
is_count "$shown" 0 0 || fail "The wiped database is not empty: $shown"
note "Wiped: $shown."

# The preview lists every new workout, so at the largest text size its Import button
# starts far below the fold: wait for the summary at the top, and tap scrolls to it.
open_link "svett://import?file=$import_name" 'id="import-new"'
screenshot import-preview
started=$(date +%s)
tap 'id="import-apply"'
agent_device wait 'id="import-done"' 300000
note "Import took about $(($(date +%s) - started)) seconds, counted from the press."
screenshot imported

if node scripts/compare-databases.ts compare "$fixture" "$wiped" >"$out/compare-import.txt"; then
  note "Export, wipe, import: equal to the fixture row for row. See compare-import.txt."
else
  cat "$out/compare-import.txt" >&2
  fail "The imported database differs from the fixture"
fi
launch_on "$wiped"
show_counts counts-after-import
is_count "$shown" "$workouts" "$sets" || fail "Progress does not count the imported workouts: $shown"
note "After import: $shown."

open_link "svett://import?file=$import_name" 'id="import-nothing-new"'
screenshot import-again
node scripts/compare-databases.ts compare "$fixture" "$wiped" >"$out/compare-again.txt" ||
  fail "Importing the same file again changed the database"
again=$(counts_of "$wiped")
[[ "$(json_field "$again" 'c.imports.length')" == 1 ]] ||
  fail "Importing the same file again recorded another import: $again"
note "Same file again: nothing new, one import on record, still equal row for row."

# Past imports are listed below export and import, under the fold at the largest
# text size, so wait for the screen and let tap scroll to the row.
open_link svett://data 'id="data"'
screenshot data-with-import
tap 'id="import-batch-0"'
agent_device wait 'id="undo-import"' 60000
# The plan reads in a moment, so the screenshot waits for the Undo button below it.
reveal 'id="undo-apply"'
screenshot undo-preview
tap 'id="undo-apply"'
agent_device wait 'id="undo-done"' 300000
screenshot undone

after=$(counts_of "$wiped")
[[ "$(json_field "$after" 'c.live.activity')" == 0 ]] || fail "Undo left workouts: $after"
[[ "$(json_field "$after" 'c.imports[0].status')" == undone ]] || fail "Undo did not mark the import undone: $after"
launch_on "$wiped"
show_counts counts-after-undo
is_count "$shown" 0 0 || fail "Progress still counts workouts after Undo: $shown"
note "Undo: $shown, and the import is marked undone."

echo "Screenshots, the export and summary.txt are in $out"
