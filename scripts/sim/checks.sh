#!/usr/bin/env bash
# Runs the phone checks on rena-devbook's simulator and saves what each one shows.
# Run it after devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/checks.sh [--release] [out-dir]
#
# At the largest text size, it opens Phone checks from the You tab and resets the
# checks. Then it relaunches for the Keychain check, runs the notification check
# and leaves svett at once, runs Apple Health and allows it when its sheet shows,
# runs GPS on a simulated route with svett in the background for 70 seconds, and
# opens the ChatGPT sign-in sheet and cancels it. After each step that leaves svett it brings svett back to Phone
# checks, and it stops before a scroll or press when svett is not in front. Last
# it relaunches, copies the report and saves the clipboard as report.txt, with a
# note on what the simulator cannot show. It fails when Keychain, the notification
# or GPS did not pass.
# Screenshots are numbered PNGs. Both go to out-dir, by default
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
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
front_flags=()
[[ "$release" == true ]] || front_flags=(--launch-url "$(dev_client_url "http://$metro")")
open_flags=(--relaunch ${front_flags[@]+"${front_flags[@]}"})

restore() {
  xcrun simctl location "$udid" clear || true
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

# Stops the run when Phone checks is not in front, so no scroll or press lands
# on the Home Screen or a system sheet.
require_checks() {
  agent_device is visible 'id="phone-checks"' >/dev/null 2>&1 || {
    echo "svett is not in the foreground on Phone checks, so the script stops before it reaches $1" >&2
    exit 1
  }
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

# Brings the Phone checks element $1 on screen.
show() {
  require_checks "$1"
  reveal "$1"
}

tap() {
  show "$1" || return 1
  press_centre "$1"
}

# The tab bar takes selector presses. The row is screen content, so it takes a tap.
show_checks() {
  agent_device wait "$you_tab" 120000
  agent_device press "$you_tab"
  agent_device wait 'id="phone-checks-row"' 10000
  reveal 'id="phone-checks-row"'
  press_centre 'id="phone-checks-row"'
  agent_device wait 'id="phone-checks"' 10000
  agent_device wait 1000
}

relaunch() {
  agent_device open "$bundle_id" "${open_flags[@]}"
  show_checks
}

# Brings svett back to the front after the Home Screen or a system sheet. It does
# not relaunch, so the checks keep their state. A Debug build can come back on
# another screen after the development client reloads, so it reopens Phone checks
# from the You tab then.
resume() {
  agent_device open "$bundle_id" ${front_flags[@]+"${front_flags[@]}"}
  for _ in $(seq 60); do
    agent_device is visible 'id="phone-checks"' >/dev/null 2>&1 && return 0
    if agent_device is visible "$you_tab" >/dev/null 2>&1; then
      show_checks
      return 0
    fi
    agent_device wait 2000
  done
  echo "svett did not come back to the foreground within 2 minutes" >&2
  exit 1
}

# Accepts the permission prompts a check raises, when there are any.
accept_alerts() {
  for _ in 1 2 3; do
    agent_device alert wait 5000 >/dev/null 2>&1 || return 0
    agent_device alert accept || return 0
  done
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
relaunch
tap 'id="reset-checks"'
agent_device wait 2000
screenshot reset

# Phone checks saved a Keychain value when it showed again after the reset.
relaunch
screenshot keychain

# The notification is due 10 seconds after Run, and each agent-device call takes
# seconds, so svett leaves in the call right after the press.
if ! agent_device settings permission grant notifications; then
  echo "Could not grant notifications ahead, so a first Run answers the prompt" >&2
  tap 'id="check-run-notification"'
  accept_alerts
fi
tap 'id="check-run-notification"'
agent_device home
agent_device open com.apple.springboard
agent_device wait text "$banner" 20000 ||
  echo "The notification banner did not show in the accessibility tree within 20 seconds" >&2
screenshot notification-banner
resume
show 'id="check-run-notification"'
screenshot notification

tap 'id="check-run-health"'
# The Apple Health sheet is not a system alert, so alert accept cannot answer it.
if agent_device wait 'label="Turn On All"' 10000; then
  screenshot health-sheet
  if ! { press_centre 'label="Turn On All"' && press_centre 'label="Allow"'; }; then
    echo "Could not allow Apple Health, so a relaunch closes its sheet" >&2
    relaunch
  fi
fi
agent_device wait 2000
resume
show 'id="check-run-health"'
screenshot health

agent_device settings permission grant location-always ||
  echo "Could not grant location ahead, so the check's own prompts get accepted" >&2
xcrun simctl location "$udid" start --speed=3 --interval=1 "${route[@]}"
tap 'id="check-run-location"'
accept_alerts
agent_device home
agent_device wait 70000
resume
show 'id="check-run-location"'
screenshot location

tap 'id="check-run-chatgpt"'
agent_device wait 3000
screenshot chatgpt-sheet
# The sign-in sheet covers Phone checks, so Cancel is pressed without show.
agent_device alert dismiss || press_centre 'label="Cancel"' ||
  echo "Could not cancel the sign-in sheet, so the relaunch closes it" >&2

relaunch
tap 'id="copy-report"'
agent_device wait 1000
# The checks count any time svett is not in front as locked, so the simulator,
# which cannot lock, stands in with the Home Screen.
note="Simulator: it cannot lock its screen, so GPS ran with svett on the Home Screen. A pass shows recording in the background, not with the screen locked."
[[ "$release" == true ]] ||
  note+=" Debug: when svett comes back on its tab root, the development client reloaded and forgot when svett was away, so GPS and the notification can read WAITING. Run with --release to avoid the reload."
{
  agent_device clipboard read
  echo
  echo "$note"
} >"$out/report.txt"
echo "$note"
echo "Saved $out/report.txt"
screenshot report

echo "Screenshots and the report are in $out"

# Health stays INCONCLUSIVE with no workouts in the simulator, and the script cancels
# the ChatGPT sign-in, so these are the checks the simulator can pass.
unpassed=()
for check in "Keychain after restart" "Notification in the background" "GPS with the screen locked"; do
  grep -qF "$check: PASSED." "$out/report.txt" || unpassed+=("$check")
done
if ((${#unpassed[@]} > 0)); then
  printf 'Did not pass: %s\n' "${unpassed[@]}" >&2
  exit 1
fi
