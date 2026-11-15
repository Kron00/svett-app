#!/usr/bin/env bash
# Proves the Connected apps screen on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/connected-apps.sh [--release] [out-dir]
#
# At the largest text size it relaunches svett with -svettConnectionsStub one,
# which stands in for the server with one ChatGPT connection that may read and
# propose. It opens the You tab and finds the Connected apps row, then opens the
# screen through svett://connected-apps. It checks the connection says what it may
# do, when it last read and its recent access, presses Revoke, answers svett's own confirmation with
# Revoke access, and checks the connection is gone and the list says no app is
# connected. It fails when a screen, row or result it expects does not show.
#
# The screen scrolls at the largest text size, so it waits for an element at the
# top first and scrolls to every other one. It presses an element at its centre,
# once two reads of its frame agree and clear of the screen's bottom edge, because
# agent-device 0.21.37 refuses a selector press inside screen content on iOS 27.
# Numbered screenshots go to out-dir, by default ~/svett-proof/<branch>/connected-apps/.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/connected-apps}
bundle_id=com.kron00.svett
you_tab='label="You, tab, 5 of 5"'
connection='id="connection-stand-in-chatgpt"'

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
open_flags=(--relaunch --launch-args=-svettConnectionsStub --launch-args=one)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")

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

# expect <selector> <what is missing>: waits for an element at the top of a screen.
expect() {
  agent_device wait "$1" 15000 >/dev/null || fail "$2 did not show."
}

# reveal <selector>: scrolls until the element is on screen, down or up.
reveal() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1" >/dev/null 2>&1
}

# bring <selector> <what is missing>
bring() {
  reveal "$1" || fail "$2 did not show."
}

centre_of() {
  local frame
  frame=$(agent_device get attrs "$1") || return 1
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

# steady_centre <selector>: the element's centre once two reads half a second apart
# agree. iOS takes a tap on a screen still gliding after a scroll as a stop.
steady_centre() {
  local before after
  before=$(centre_of "$1") || return 1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    agent_device wait 500 >/dev/null
    after=$(centre_of "$1") || return 1
    [[ "$after" != "$before" ]] || {
      echo "$after"
      return 0
    }
    before=$after
  done
  return 1
}

# Below this line a press lands on the screen's bottom edge, where iOS 27 keeps the
# home indicator, so a control merely peeking up from there takes no press.
safe_bottom=${SVETT_SAFE_BOTTOM:-840}

# tap <selector> <what is missing>: brings the element on screen, drags it clear of
# the bottom edge, waits for it to settle and presses its centre.
tap() {
  local point drags=0
  bring "$1" "$2"
  point=$(steady_centre "$1") || fail "$2 did not hold still."
  while ((${point#* } > safe_bottom)); do
    ((drags < 3)) || fail "$2 stayed at the bottom edge of the screen."
    agent_device gesture pan 20 600 0 -300 400
    drags=$((drags + 1))
    point=$(steady_centre "$1") || fail "$2 did not hold still."
  done
  agent_device press "${point% *}" "${point#* }"
}

# expect_text <selector> <text>: brings the element on screen and checks it holds the text.
expect_text() {
  local text
  bring "$1" "$1"
  text=$(agent_device get text "$1") || fail "Could not read $1."
  [[ "$text" == *"$2"* ]] || fail "Expected $1 to show \"$2\", but it shows \"$text\"."
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
agent_device open "$bundle_id" "${open_flags[@]}"
agent_device wait "$you_tab" 120000 >/dev/null || fail "svett did not show its tabs."

agent_device press "$you_tab"
agent_device wait "$you_tab selected=true" 10000 >/dev/null || fail "The You tab did not open."
bring 'id="connected-apps-row"' "Connected apps on the You tab"
screenshot you-tab

agent_device open "$bundle_id" svett://connected-apps
expect 'id="connected-apps-screen"' "Connected apps"
bring "$connection" "The stand-in ChatGPT connection"
expect_text 'id="connection-stand-in-chatgpt-access"' \
  "Read your training and propose routines and programs"
expect_text 'id="connection-stand-in-chatgpt-read"' "Last read your data on"
expect_text 'id="connection-stand-in-chatgpt-recent-title"' "Recent access"
expect_text 'id="connection-stand-in-chatgpt-recent-0"' "Listed workouts"
screenshot connection

tap 'id="revoke-stand-in-chatgpt"' "Revoke"
agent_device alert wait 5000 >/dev/null || fail "Revoke asked nothing."
screenshot confirm
# svett's own alert: agent-device's alert accept cannot answer it, so press its button.
tap 'label="Revoke access"' "Revoke access in the confirmation"
bring 'id="connected-apps-empty"' "The list without the revoked connection"
if reveal "$connection"; then fail "The revoked connection is still listed."; fi
screenshot revoked

echo "Connected apps revoked the stand-in ChatGPT connection. Screenshots are in $out"
