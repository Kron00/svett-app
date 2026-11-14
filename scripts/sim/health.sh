#!/usr/bin/env bash
# Proves Apple Health and GPX import, duplicate linking and manual entry on
# rena-devbook's simulator. Run it after devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/health.sh [--release] [out-dir]
#
# At the largest text size, it writes a made-up Apple Health export.zip and a GPX
# ride into svett's Documents, as data.sh does with a svett file, and opens svett
# on a database that holds one Hevy-shaped strength workout. It previews the
# export and declines, then previews it again and imports it, which links the
# Health copy of the Hevy workout. It imports the export once more and sees
# nothing new, imports the GPX ride, opens the linked workout, and saves a ride
# through manual entry. After each step scripts/health-proof.ts checks the
# database and the script fails on any check that does not pass. It reaches the
# screens through svett://health-import?file=<name>, svett://activity/<id> and
# svett://manual, because agent-device 0.21.37 refuses selector presses in screen
# content on iOS 27, so it presses an element's centre instead, as checks.sh does.
# Screenshots and proof.txt go to out-dir, by default ~/svett-proof/<branch>/health/.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/health}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
you_tab='label="You, tab, 5 of 5"'
export_file=svett-health-export.zip
gpx_file=svett-ride.gpx
max_pages=15

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
database="$documents/svett-health.db"
mkdir -p "$documents"

node scripts/health-proof.ts files "$out" >/dev/null
cp "$out/$export_file" "$out/$gpx_file" "$documents/"
hevy_id=$(node scripts/health-proof.ts seed "$database")
echo "Seeded $database with the Hevy workout $hevy_id"

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
  reveal "$1" || fail "$1 was not on screen to press"
  press_centre "$1"
}

# open_link <url> <element> opens a svett link and waits for the element.
open_link() {
  agent_device open "$bundle_id" "$1"
  agent_device wait "$2" 180000 || fail "$2 did not show after opening $1"
  agent_device wait 1000
}

# pages <name> <last element> screenshots page after page until the element shows.
pages() {
  local page=1
  while true; do
    screenshot "$(printf '%s-%02d' "$1" "$page")"
    agent_device is visible "$2" >/dev/null 2>&1 && return 0
    ((page < max_pages)) || fail "$2 was not on screen after $max_pages pages"
    # Scrolling less than a screen overlaps the pages, so nothing falls between two.
    agent_device scroll down 0.6
    page=$((page + 1))
  done
}

proof="$out/proof.txt"
: >"$proof"
check() {
  node scripts/health-proof.ts check "$database" "$1" >>"$proof" || {
    grep FAILED "$proof" >&2
    fail "The database is not as the $1 step leaves it. See $proof."
  }
  echo "Checked $1"
}

# close_import presses Done, so the next link opens a fresh preview.
close_import() {
  tap 'label="Done"'
  agent_device wait absent 'id="health-import"' 10000 || fail "Done did not close the import"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
agent_device open "$bundle_id" "${launch_flags[@]}" --launch-args=-svettFixture "--launch-args=$database"
agent_device wait "$you_tab" 120000
check seeded

open_link "svett://health-import?file=$export_file" 'id="health-decline"'
pages preview 'id="health-decline"'
tap 'id="health-decline"'
agent_device wait absent 'id="health-import"' 10000 || fail "Don't import did not close the preview"
screenshot declined
check declined

open_link "svett://health-import?file=$export_file" 'id="health-duplicates"'
reveal 'id="health-duplicate-0"'
screenshot duplicate
tap 'id="health-apply"'
agent_device wait 'id="health-done"' 300000 || fail "The import did not finish"
screenshot imported
check imported
close_import

open_link "svett://health-import?file=$export_file" 'id="health-nothing-new"'
screenshot import-again
check again
close_import

open_link "svett://health-import?file=$gpx_file" 'id="health-new"'
screenshot gpx-preview
tap 'id="health-apply"'
agent_device wait 'id="health-done"' 60000 || fail "The GPX import did not finish"
screenshot gpx-imported
check gpx
close_import

open_link "svett://activity/$hevy_id" 'id="activity-heart-average"'
pages linked-workout 'id="activity-sources"'

open_link "$(node scripts/health-proof.ts manual-link)" 'id="manual-save"'
pages manual 'id="manual-save"'
tap 'id="manual-save"'
agent_device wait 'id="activity"' 30000 || fail "Saving the manual ride did not open it"
pages manual-ride 'id="activity-notes"'
check manual

cat "$proof"
echo "Screenshots and proof.txt are in $out"
