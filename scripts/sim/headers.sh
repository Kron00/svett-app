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
# screen under a large title: Home, Train, Progress and You through the tab bar,
# then Exercises, Your data and the design gallery through their svett:// links,
# because agent-device refuses taps in screen content on iOS 27. It checks the
# Progress tab counts the fixture's 300 workouts and the Train tab lists its
# routines. It shoots each screen at rest, scrolls it down 60% of the screen and
# shoots it again. Scrolled, the title should sit collapsed in the bar with the
# content blurred under it, not drawn over the content. Home is shorter than the
# phone, so it need not move.
#
# Coach comes last, because the keyboard it raises covers the tab bar. svett
# relaunches on the fixture signed in on the ChatGPT stand-in, with the coach
# answering from coach-best-squat.json, as coach.sh does. It asks three
# questions through svett://coach?ask=..., and fails when New chat at the top of
# the chat still shows once the chat has scrolled to its end, since then the
# chat fits on the screen. The composer fills the bottom of the screen at the
# largest text size, so the chat is dragged only inside its own frame, never
# with scroll, whose swipe starts in the composer. It shoots the chat from the
# top with the title expanded, then dragged with the title collapsed over the
# chat. Then it presses the question field, types a few characters and fails
# unless the field took them, the composer rose above the keyboard and stays
# whole on screen, and the latest answer is dragged into view above the
# composer. It shoots that.
#
# It fails when a screen does not show, when the fixture did not open, or when a
# screen longer than the phone looks the same after the scroll. It presses screen
# content only at an element's centre once two reads of its frame agree, and only
# clear of the screen's bottom edge. Screenshots are NN-<screen>-<state>.png in
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
coach_stub="$data/Documents/coach-best-squat.json"
cp packages/tools/fixtures/coach-best-squat.json "$coach_stub"

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

fail() {
  echo "$1" >&2
  exit 1
}

# frame <selector> prints the element's frame as "x y width height".
frame() {
  local attrs
  attrs=$(agent_device get attrs "$1") || return 1
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log([x, y, width, height].map(Math.round).join(" "));
  ' "$attrs"
}

# steady_frame <selector> prints the element's frame once two reads half a second
# apart agree. iOS takes a tap on a screen still gliding after a drag as a stop.
steady_frame() {
  local before after
  before=$(frame "$1") || return 1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    agent_device wait 500 >/dev/null
    after=$(frame "$1") || return 1
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

# ask <question> asks through the coach's link and waits until it is answered. The
# question showing means the coach took the link, so the next link is not lost.
ask() {
  agent_device open "$bundle_id" "svett://coach?ask=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1")"
  agent_device wait text "$1" 15000 >/dev/null || fail "The coach did not take the question \"$1\"."
  agent_device wait absent 'id="coach-pending"' 60000 >/dev/null || fail "The coach did not answer \"$1\"."
  agent_device wait 'id="coach-answer"' 10000 >/dev/null || fail "The coach's answer to \"$1\" did not show."
}

# drag_chat <up|down> drags the chat to show what is above or below, with a pan that
# starts and ends in the lower 60% of the chat's frame, below the large title and
# above the composer, and clear of the bottom edge. It reads the frame each time,
# because the chat shrinks when the keyboard rises.
drag_chat() {
  local x y height start travel
  # The navigation bar answers to id="coach" too, so the chat is picked by its role.
  read -r x y _ height < <(frame 'role="other" id="coach"') || fail "The chat did not show."
  start=$((y + height - height / 10))
  travel=$((height * 45 / 100))
  ((start <= safe_bottom)) ||
    fail "The chat's drag would start at y=$start, on the screen's bottom edge, where a touch does not land."
  if [[ "$1" == down ]]; then
    agent_device gesture pan $((x + 8)) "$start" 0 "-$travel" 800
  else
    agent_device gesture pan $((x + 8)) $((start - travel)) 0 "$travel" 800
  fi
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
# relaunch [app-argument...] relaunches svett on the fixture and waits for its tabs.
relaunch() {
  local flags=()
  [[ "$release" == false ]] || flags=(--release)
  scripts/sim/launch.sh ${flags[@]+"${flags[@]}"} -svettFixture "$fixture" "$@"
  agent_device wait "$(tab_label 0) selected=true" 120000
}

relaunch

# Coach is index 3 and comes last, below.
for i in 0 1 2 4; do
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

# Signed in on the stand-in, the coach answers from coach-best-squat.json, with its
# read tools on the fixture. The relaunch also leaves the gallery for the tabs.
relaunch -svettChatGPTStub signedIn -svettCoachStub "$coach_stub"
agent_device press "$(tab_label 3)"
agent_device wait "$(tab_label 3) selected=true" 10000
agent_device wait 'id="coach-composer"' 30000 >/dev/null || fail "The signed-in coach did not show."
ask "What was my best squat set last month?"
ask "Remind me, what was my best squat set last month?"
ask "Once more, what was my best squat set last month?"
# The chat scrolls to its end after each answer, so New chat at its top is off the
# screen only when the chat is longer than the screen.
if agent_device is visible 'id="coach-new"' >/dev/null 2>&1; then
  fail "The chat still fits on the screen after three answers, so the coach's title has nothing to collapse over."
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  agent_device is visible 'id="coach-new"' >/dev/null 2>&1 && break
  drag_chat up
done
agent_device is visible 'id="coach-new"' >/dev/null 2>&1 || fail "Dragging the chat did not reach its top."
# One more drag pulls the chat fully down, so the title shows expanded.
drag_chat up
read -r _ rest_y _ _ < <(steady_frame 'id="coach-new"') || fail "The chat did not hold still at its top."
screenshot coach-top
top=$last
drag_chat down
read -r _ dragged_y _ _ < <(steady_frame 'id="coach-new"') || fail "The chat did not hold still after the drag."
screenshot coach-scrolled
if cmp -s "$top" "$last"; then
  fail "coach: the scrolled screenshot matches the one at rest, so the screen did not scroll"
fi
((dragged_y < rest_y)) || fail "coach: New chat stayed at y=$dragged_y after the drag, so the chat did not scroll"

read -r input_x input_y input_width input_height < <(steady_frame 'id="coach-input"') ||
  fail "The question field did not hold still."
read -r _ composer_y _ composer_height < <(frame 'id="coach-composer"') ||
  fail "The composer did not show."
input_centre=$((input_y + input_height / 2))
((input_centre <= safe_bottom)) ||
  fail "The question field's centre is at y=$input_centre, on the screen's bottom edge, where a press does not land."
agent_device press $((input_x + input_width / 2)) "$input_centre"
typed=Bench
agent_device type "$typed"
agent_device wait 1000
field=$(agent_device get text 'id="coach-input"') || fail "Could not read the question field."
[[ "$field" == *"$typed"* ]] ||
  fail "The question field did not take the typed \"$typed\", so the keyboard is not up: it shows \"$field\"."
read -r _ raised_y _ raised_height < <(steady_frame 'id="coach-composer"') ||
  fail "The composer did not hold still above the keyboard."
# The keyboard is far taller than the tab bar it covers, so a composer that avoids it
# rises well above where it sat.
((composer_y - raised_y >= 150)) ||
  fail "The composer stayed at y=$raised_y under the keyboard instead of rising from y=$composer_y."
((raised_y >= 0 && raised_y + raised_height <= composer_y + composer_height)) ||
  fail "The composer at y=$raised_y, $raised_height points tall, is not whole on the screen above the keyboard."
for _ in 1 2 3 4 5 6 7 8 9 10; do
  agent_device is visible 'id="coach-answer"' >/dev/null 2>&1 && break
  drag_chat down
done
agent_device is visible 'id="coach-answer"' >/dev/null 2>&1 ||
  fail "The latest answer did not scroll into view above the keyboard."
read -r _ answer_y _ _ < <(steady_frame 'id="coach-answer"') || fail "The latest answer did not hold still."
((answer_y < raised_y)) ||
  fail "The latest answer starts at y=$answer_y, behind the composer at y=$raised_y."
screenshot coach-keyboard

echo "Screenshots are in $out"
