#!/usr/bin/env bash
# Proves Apple Health and GPX import, duplicate linking and manual entry on
# rena-devbook's simulator. Run it after devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/health.sh [--release] [out-dir]
#
# At the largest text size, it writes a made-up Apple Health export.zip and a GPX
# ride into svett's Documents, as data.sh does with a svett file, and opens svett
# on a database that holds one Hevy-shaped strength workout. It previews the
# export, checks the line atop it, and declines. The export holds one run whose
# dates are not dates, on purpose, so the preview says svett could not read 1 of
# its entries, and proof.txt says so. Then it previews the export again and
# imports it, which links the Health copy of the Hevy workout. It imports the export once more and sees
# nothing new, imports the GPX ride, opens the linked workout, and saves a ride
# through manual entry. After each step scripts/health-proof.ts checks the
# database and the script fails on any check that does not pass. It reaches the
# screens through svett://health-import?file=<name>, svett://activity/<id> and
# svett://manual, because agent-device 0.21.37 refuses selector presses in screen
# content on iOS 27, so it presses an element's centre instead, as checks.sh does.
# agent-device's wait sees only what is on screen, and at the largest text size each
# screen's buttons sit below it. So it waits for an element at the top of each
# screen, then scrolls each button on screen and clear of the bottom edge before it
# presses it, as cardio.sh does.
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
# check, so tap presses the centre of the element's frame from the snapshot.
centre_of() {
  local frame
  frame=$(agent_device get attrs "$1") || fail "Could not read where $1 is"
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

# Below this line a press lands on the screen's bottom edge, where iOS 27 keeps the
# home indicator, so a control merely peeking up from there takes no press.
safe_bottom=${SVETT_SAFE_BOTTOM:-880}

# Brings the element $1 on screen, drags it up clear of the bottom edge and presses its centre.
tap() {
  local point drags=0
  reveal "$1" || fail "$1 was not on screen to press"
  point=$(centre_of "$1")
  while ((${point#* } > safe_bottom)); do
    ((drags < 3)) || fail "$1 stayed at the bottom edge of the screen"
    agent_device gesture pan 20 600 0 -300 400
    drags=$((drags + 1))
    point=$(centre_of "$1")
  done
  # A drag leaves the screen gliding, and iOS takes a tap on a gliding screen as a
  # stop, not a press, so the press waits until two reads of the frame agree.
  if ((drags > 0)); then
    local before=$point reads=0
    while ((reads < 10)); do
      agent_device wait 250 >/dev/null
      point=$(centre_of "$1")
      [[ "$point" != "$before" ]] || break
      before=$point
      reads=$((reads + 1))
    done
  fi
  agent_device press "${point% *}" "${point#* }"
}

# open_link <url> <element> opens a svett link and waits for the element, which
# must sit at the top of the screen, since wait sees only what is on screen.
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

# expect_preview <file> checks the line atop the file's preview into proof.txt.
expect_preview() {
  local shown
  shown=$(agent_device get text 'id="health-summary"') || fail "Could not read the preview of $1"
  node scripts/health-proof.ts preview "$1" "$shown" >>"$proof" || {
    grep FAILED "$proof" >&2
    fail "The preview of $1 is not what the proof expects. See $proof."
  }
  echo "Checked the preview of $1"
}

# close_import presses Done, so the next link opens a fresh preview.
close_import() {
  tap 'role="button" label="Done"'
  agent_device wait absent 'id="health-import"' 10000 || fail "Done did not close the import"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
agent_device open "$bundle_id" "${launch_flags[@]}" --launch-args=-svettFixture "--launch-args=$database"
agent_device wait "$you_tab" 120000
check seeded

open_link "svett://health-import?file=$export_file" 'id="health-summary"'
expect_preview "$export_file"
pages preview 'id="health-decline"'
tap 'id="health-decline"'
agent_device wait absent 'id="health-import"' 10000 || fail "Don't import did not close the preview"
screenshot declined
check declined

open_link "svett://health-import?file=$export_file" 'id="health-summary"'
reveal 'id="health-duplicate-0"' || fail "The preview lists no possible duplicate"
screenshot duplicate
tap 'id="health-apply"'
# What the import did replaces the whole preview, so it shows at the top of the screen.
agent_device wait 'id="health-done"' 300000 || fail "The import did not finish"
screenshot imported
check imported
close_import

open_link "svett://health-import?file=$export_file" 'id="health-summary"'
reveal 'id="health-nothing-new"' || fail "The second import of the export did not find nothing new"
screenshot import-again
check again
close_import

open_link "svett://health-import?file=$gpx_file" 'id="health-summary"'
expect_preview "$gpx_file"
reveal 'id="health-new"' || fail "The GPX preview lists no new workout"
screenshot gpx-preview
tap 'id="health-apply"'
agent_device wait 'id="health-done"' 60000 || fail "The GPX import did not finish"
screenshot gpx-imported
check gpx
close_import

open_link "svett://activity/$hevy_id" 'id="activity"'
pages linked-workout 'id="activity-sources"'
reveal 'id="activity-heart-average"' || fail "The linked workout shows no heart rate"

open_link "$(node scripts/health-proof.ts manual-link)" 'id="manual-cardio"'
pages manual 'id="manual-save"'
tap 'id="manual-save"'
agent_device wait 'id="activity"' 30000 || fail "Saving the manual ride did not open it"
pages manual-ride 'id="activity-notes"'
check manual

cat "$proof"
echo "Screenshots and proof.txt are in $out"
