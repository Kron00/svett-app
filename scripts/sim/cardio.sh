#!/usr/bin/env bash
# Records a run on rena-devbook's simulator along a GPS route of known length and
# checks what svett saved. Run it after devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/cardio.sh [--release] [out-dir]
#
# At the largest text size, it opens Record through svett://record and starts a
# run at the route's first waypoint. The simulator plays the first leg of
# scripts/sim/cardio-route.json with svett on the Home Screen, which stands in for
# a locked screen. Back in svett it pauses, resumes, plays the second leg with
# svett in front, pauses and finishes. It screenshots each step and every page of
# the saved activity, then reads the activity from the app's database and writes
# proof.txt. It fails unless the saved distance is within 1% of the route's
# length and the splits add up to the distance and the moving time.
# Screenshots are numbered PNGs. Both go to out-dir, by default
# ~/svett-proof/<branch>/cardio/. Like checks.sh, Debug opens the development
# client on Metro at SVETT_METRO, --release opens the installed Release build,
# and every step runs through SVETT_DEVICE_CMD when it is set. The route goes
# through simctl location, because agent-device sets only a fixed point.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/cardio}
bundle_id=com.kron00.svett
route=scripts/sim/cardio-route.json
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
train_tab='label="Train, tab, 2 of 5"'
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

leg() { node scripts/cardio-proof.ts leg "$route" "$1"; }
leg_seconds() { node scripts/cardio-proof.ts seconds "$route" "$1"; }
speed=$(node scripts/cardio-proof.ts speed "$route")
read -r -a first_leg <<<"$(leg 1)"
read -r -a second_leg <<<"$(leg 2)"

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

# Scrolls the screen until the element $1 is on screen.
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
  frame=$(agent_device get attrs "$1") || return 1
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
  reveal "$1" || {
    echo "Could not bring $1 on screen" >&2
    exit 1
  }
  point=$(centre_of "$1") || {
    echo "Could not read where $1 is" >&2
    exit 1
  }
  while ((${point#* } > safe_bottom)); do
    ((drags < 3)) || {
      echo "$1 stayed at the bottom edge of the screen" >&2
      exit 1
    }
    agent_device gesture pan 20 600 0 -300 400
    drags=$((drags + 1))
    point=$(centre_of "$1") || {
      echo "Could not read where $1 is" >&2
      exit 1
    }
  done
  agent_device press "${point% *}" "${point#* }"
}

# Presses the Record screen's button $1 and waits for the button $2 that replaces it.
press() {
  agent_device is visible 'id="record-cardio"' >/dev/null 2>&1 || {
    echo "svett is not in the foreground on Record, so the script stops before it presses $1" >&2
    exit 1
  }
  tap "$1"
  agent_device wait "$2" 10000 || {
    echo "$2 did not show after pressing $1" >&2
    exit 1
  }
}

# Accepts the permission prompts Start raises, when there are any.
accept_alerts() {
  for _ in 1 2 3; do
    agent_device alert wait 5000 >/dev/null 2>&1 || return 0
    agent_device alert accept || return 0
  done
}

# Brings svett back from the Home Screen without a relaunch, so the recording
# carries on. A Debug build can come back on its tab root after the development
# client reloads, so it opens Record again through its link then.
resume() {
  agent_device open "$bundle_id" ${front_flags[@]+"${front_flags[@]}"}
  for _ in $(seq 60); do
    agent_device is visible 'id="record-cardio"' >/dev/null 2>&1 && return 0
    if agent_device is visible "$train_tab" >/dev/null 2>&1; then
      agent_device open "$bundle_id" svett://record
      agent_device wait 'id="record-cardio"' 10000
      return 0
    fi
    agent_device wait 2000
  done
  echo "svett did not come back to the foreground within 2 minutes" >&2
  exit 1
}

# Plays leg $1 of the route and waits until the simulator has reached its end.
play_leg() {
  local -a waypoints
  if [[ "$1" == 1 ]]; then waypoints=("${first_leg[@]}"); else waypoints=("${second_leg[@]}"); fi
  xcrun simctl location "$udid" start --speed="$speed" --interval=1 "${waypoints[@]}"
  agent_device wait $((($(leg_seconds "$1") + 10) * 1000))
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
agent_device settings permission grant location-always ||
  echo "Could not grant location ahead, so Start's own prompts get accepted" >&2
xcrun simctl location "$udid" set "${first_leg[0]}"
agent_device open "$bundle_id" "${open_flags[@]}"
agent_device wait "$train_tab" 120000
agent_device open "$bundle_id" svett://record
agent_device wait 'id="record-start"' 10000
screenshot start

started_after=$(($(date +%s) * 1000))
tap 'id="record-start"'
accept_alerts
agent_device wait 'id="record-pause"' 10000 || {
  echo "The recording did not start" >&2
  exit 1
}
screenshot recording

# The simulator cannot lock its screen, so the first leg runs with svett on the Home Screen.
agent_device home
play_leg 1
resume
screenshot after-home-screen

press 'id="record-pause"' 'id="record-resume"'
screenshot paused
agent_device wait 5000
press 'id="record-resume"' 'id="record-pause"'

play_leg 2
screenshot second-leg
press 'id="record-pause"' 'id="record-finish"'
press 'id="record-finish"' 'id="activity"'
agent_device wait 'id="activity-distance"' 10000
# Map tiles load after the screen shows.
agent_device wait 3000

page=1
while true; do
  screenshot "$(printf 'activity-%02d' "$page")"
  agent_device is visible 'id="activity-hide"' >/dev/null 2>&1 && break
  ((page < max_pages)) || {
    echo "The activity's hide setting was not on screen after $max_pages pages" >&2
    exit 1
  }
  # Scrolling less than a screen overlaps the pages, so nothing falls between two.
  agent_device scroll down 0.6
  page=$((page + 1))
done

data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
status=0
node scripts/cardio-proof.ts check "$route" "$data/Documents/SQLite/svett-anonymous.db" "$started_after" \
  >"$out/proof.txt" || status=$?
cat "$out/proof.txt"
echo "Screenshots and proof.txt are in $out"
exit "$status"
