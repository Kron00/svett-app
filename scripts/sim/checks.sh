#!/usr/bin/env bash
# Runs the phone checks on rena-devbook's simulator and saves what each one shows.
# Run it after devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/checks.sh [--release] [out-dir]
#
# It opens Phone checks from the You tab and resets the checks. Then it relaunches
# for the Keychain check, runs the notification check from the Home Screen, runs
# Apple Health and allows it when its sheet shows, runs GPS on a simulated route
# with svett in the background for 70 seconds, and opens the ChatGPT sign-in sheet
# and cancels it. Last it relaunches, copies the report and saves the clipboard as
# report.txt. Screenshots are numbered PNGs. Both go to out-dir, by default
# ~/svett-proof/<branch>/checks/. Like tabs.sh, Debug opens the development client
# on Metro at SVETT_METRO, --release opens the installed Release build, and every
# step runs through SVETT_DEVICE_CMD when it is set. The route goes through
# simctl location, because agent-device sets only a fixed point.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/checks}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
you_tab='label="You, tab, 5 of 5"'
banner='The background notification check worked.'
# A loop through Apple Park at running pace.
route=("37.3349,-122.0090" "37.3367,-122.0110" "37.3353,-122.0135" "37.3331,-122.0112" "37.3349,-122.0090")

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
open_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")

restore() {
  xcrun simctl location "$udid" clear || true
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

# Scrolls Phone checks until the element $1 is on screen.
reveal() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1"
}

# agent-device 0.21.37 refuses a selector press inside screen content on iOS 27 as
# covered by another element. It reads UIKit's touch-transparent floating bar
# containers as toolbars over the whole screen. A press at coordinates skips that
# check, so tap presses the centre of the element's frame from the snapshot.
tap() {
  local frame point
  reveal "$1" || return 1
  frame=$(agent_device get attrs "$1") || return 1
  point=$(node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame") || return 1
  agent_device press "${point% *}" "${point#* }"
}

# The tab bar takes selector presses. The row is screen content, so it takes a tap.
show_checks() {
  agent_device wait "$you_tab" 120000
  agent_device press "$you_tab"
  agent_device wait 'id="phone-checks-row"' 10000
  tap 'id="phone-checks-row"'
  agent_device wait 'id="phone-checks"' 10000
  agent_device wait 1000
}

relaunch() {
  agent_device open "$bundle_id" "${open_flags[@]}"
  show_checks
}

# Brings svett back to the front as it was, with no relaunch.
resume() {
  agent_device open "$bundle_id"
  agent_device wait 2000
}

# Accepts the permission prompts a check raises, when there are any.
accept_alerts() {
  for _ in 1 2 3; do
    agent_device alert wait 5000 >/dev/null 2>&1 || return 0
    agent_device alert accept || return 0
  done
}

# svett is dark only, so its proof is too.
agent_device settings appearance dark
relaunch
tap 'id="reset-checks"'
agent_device wait 2000
screenshot reset

# Phone checks saved a Keychain value when it showed again after the reset.
relaunch
screenshot keychain

tap 'id="check-run-notification"'
accept_alerts
agent_device home
agent_device open com.apple.springboard
agent_device wait text "$banner" 20000 ||
  echo "The notification banner did not show in the accessibility tree within 20 seconds" >&2
screenshot notification-banner
resume
reveal 'id="check-run-notification"'
screenshot notification

tap 'id="check-run-health"'
# The Apple Health sheet is not a system alert, so alert accept cannot answer it.
if agent_device wait 'label="Turn On All"' 10000; then
  screenshot health-sheet
  if ! { tap 'label="Turn On All"' && tap 'label="Allow"'; }; then
    echo "Could not allow Apple Health, so a relaunch closes its sheet" >&2
    relaunch
  fi
fi
agent_device wait 2000
reveal 'id="check-run-health"'
screenshot health

agent_device settings permission grant location-always ||
  echo "Could not grant location ahead, so the check's own prompts get accepted" >&2
xcrun simctl location "$udid" start --speed=3 --interval=1 "${route[@]}"
tap 'id="check-run-location"'
accept_alerts
agent_device home
agent_device wait 70000
resume
reveal 'id="check-run-location"'
screenshot location

tap 'id="check-run-chatgpt"'
agent_device wait 3000
screenshot chatgpt-sheet
agent_device alert dismiss || tap 'label="Cancel"' ||
  echo "Could not cancel the sign-in sheet, so the relaunch closes it" >&2

relaunch
tap 'id="copy-report"'
agent_device wait 1000
agent_device clipboard read >"$out/report.txt"
echo "Saved $out/report.txt"
screenshot report

echo "Screenshots and the report are in $out"
