#!/usr/bin/env bash
# Takes the large-title proof screenshots on rena-devbook. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/headers.sh [--release] [out-dir]
#
# It generates the 300-workout fixture into out-dir with pnpm fixture and copies
# it into the app's data container, as progress.sh does, so every screen has
# real content under its title whatever an earlier run left in the container.
# At the largest text size it relaunches svett on the fixture and opens each
# screen under a large title: the five tabs through the tab bar, then Exercises,
# Your data and the design gallery through their svett:// links, because
# agent-device refuses taps in screen content on iOS 27. It checks the Progress
# tab counts the fixture's 300 workouts and the Train tab lists its routines.
# It shoots each screen at rest, scrolls it down 60% of the screen and shoots it
# again. Scrolled, the title should sit collapsed in the bar with the content
# blurred under it, not drawn over the content. It fails when a screen does not
# show, when the fixture did not open, or when a screen longer than the phone
# looks the same after the scroll. Home and Coach show only a short summary, so
# they have nothing to scroll. Screenshots are NN-<screen>-<top|scrolled>.png in
# out-dir, by default ~/svett-proof/<branch>/headers/. Like tabs.sh, Debug opens
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/headers}
bundle_id=com.kron00.svett
tabs=(Home Train Progress Coach You)

if command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
fi

# shellcheck source=scripts/sim/simulator.sh
source scripts/sim/simulator.sh
# simctl only finds the app's data container.
udid=$(simulator_udid "$simulator_name")
[[ -n "$udid" ]] || {
  echo "No available iOS 27 simulator named \"$simulator_name\". Run scripts/devbook-build.sh first." >&2
  exit 1
}

mkdir -p "$out"
out=$(cd "$out" && pwd)
pnpm fixture --out "$out/svett-fixture.db"
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
fixture="$data/Documents/svett-fixture.db"
mkdir -p "$data/Documents"
# A journal left by an earlier run would be replayed onto the fresh copy.
rm -f "$fixture-wal" "$fixture-shm"
cp "$out/svett-fixture.db" "$fixture"
echo "Copied the fixture to $fixture"

restore() {
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

shot=0
screenshot() {
  shot=$((shot + 1))
  last=$(printf '%s/%02d-%s.png' "$out" "$shot" "$1")
  agent_device screenshot "$last"
  echo "Saved $last"
}

# shoot <screen> <long|short> shoots the screen in front, scrolls it down 60% of
# the screen and shoots it again. That is further than the large title is tall
# at the largest text size, so content sits under the collapsed title. A long
# screen must have moved.
shoot() {
  local top
  agent_device wait 1000
  screenshot "$1-top"
  top=$last
  agent_device scroll down 0.6
  agent_device wait 1000
  screenshot "$1-scrolled"
  if [[ "$2" == long ]] && cmp -s "$top" "$last"; then
    echo "$1: the scrolled screenshot matches the one at rest, so the screen did not scroll" >&2
    exit 1
  fi
}

# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
tab_label() {
  printf 'label="%s, tab, %d of %d"' "${tabs[$1]}" $(($1 + 1)) "${#tabs[@]}"
}

# link <screen> <url> <root id> opens a pushed screen through its link.
link() {
  agent_device open "$bundle_id" "$2"
  agent_device wait "id=\"$3\"" 10000
  shoot "$1" long
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
if [[ "$release" == true ]]; then
  scripts/sim/launch.sh --release -svettFixture "$fixture"
else
  scripts/sim/launch.sh -svettFixture "$fixture"
fi
agent_device wait "$(tab_label 0) selected=true" 120000

for i in "${!tabs[@]}"; do
  name=$(tr '[:upper:]' '[:lower:]' <<<"${tabs[i]}")
  # The tab bar takes selector presses.
  agent_device press "$(tab_label "$i")"
  agent_device wait "$(tab_label "$i") selected=true" 10000
  case ${tabs[i]} in
    Progress)
      agent_device wait 'id="progress"' 10000
      agent_device wait absent 'id="workout-counts" label="Opening the database"' 30000
      counts=$(agent_device get text 'id="workout-counts"')
      [[ "$counts" == *"300 workouts"* ]] || {
        echo "The Progress tab did not show the fixture's 300 workouts: $counts" >&2
        exit 1
      }
      shoot "$name" long
      ;;
    Train)
      agent_device wait 'id="routine-list"' 30000
      shoot "$name" long
      ;;
    You) shoot "$name" long ;;
    *) shoot "$name" short ;;
  esac
done

link exercises svett://exercises exercise-library
link data svett://data data
link gallery svett://gallery gallery

echo "Screenshots are in $out"
