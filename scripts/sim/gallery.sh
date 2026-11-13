#!/usr/bin/env bash
# Takes the design gallery proof screenshots on rena-devbook. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/gallery.sh [--release] [out-dir]
#
# Opens the gallery three times: in light, in dark, and in light at the largest
# accessibility text size. Each time it saves a screenshot per page, scrolling
# until the gallery's end marker is on screen, then opens the sheet and saves
# that too. It reaches the gallery and the sheet through the svett://gallery
# link, not taps, because agent-device refuses taps in screen content on iOS 27
# as covered by UIKit's touch-transparent floating bar containers. Files are <pass>-NN.png and <pass>-sheet.png in
# out-dir, by default ~/svett-proof/<branch>/gallery/. Like tabs.sh, Debug opens
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/gallery}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The You tab showing means the app has loaded and can take the gallery link.
you_tab='label="You, tab, 5 of 5"'
max_pages=40

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

# Leaves the simulator light at the default text size, also when a step fails,
# and frees its own session.
restore() {
  agent_device settings appearance light || true
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

screenshot() {
  agent_device screenshot "$out/$1.png"
  echo "Saved $out/$1.png"
}

# shoot <pass name> <appearance> <text size>
shoot() {
  local pass=$1 page=1
  agent_device settings appearance "$2"
  agent_device settings text-size "$3"
  # A running app adopts a new text size only when it relaunches.
  agent_device open "$bundle_id" "${open_flags[@]}"
  agent_device wait "$you_tab" 120000
  agent_device open "$bundle_id" svett://gallery
  agent_device wait 'id="gallery"' 10000
  agent_device wait 1000

  while true; do
    screenshot "$(printf '%s-%02d' "$pass" "$page")"
    agent_device is visible 'id="gallery-end"' >/dev/null 2>&1 && break
    ((page < max_pages)) || {
      echo "The gallery's end marker was not on screen after $max_pages pages" >&2
      exit 1
    }
    # Scrolling less than a screen overlaps the pages, so no component falls between two.
    agent_device scroll down 0.6
    page=$((page + 1))
  done
  echo "$pass: $page pages"

  # The next pass relaunches the app, which closes the sheet.
  agent_device open "$bundle_id" 'svett://gallery?sheet=open'
  agent_device wait 'id="gallery-sheet"' 10000
  agent_device wait 1000
  screenshot "$pass-sheet"
}

shoot light light large
shoot dark dark large
shoot largest-text light accessibility-extra-extra-extra-large

echo "Screenshots are in $out"
