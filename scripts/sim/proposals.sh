#!/usr/bin/env bash
# Proves the coach's proposals on rena-devbook. Run it after devbook-build.sh, with the
# same --release choice.
#
# Usage: scripts/sim/proposals.sh [--release] [out-dir]
#
# It copies the 300-workout fixture and the three proposal stand-ins from
# packages/tools/fixtures into the app's data container. At the largest text size it
# relaunches svett signed in on the ChatGPT stand-in, once per stand-in, and asks the
# stand-in's question through svett://coach?ask=...:
#
# - a routine: the Train tab does not list it, Preview shows it, Apply adds it to the
#   Train tab, and Undo takes it off again;
# - a program of three routines: the same, for its folder and each of its routines;
# - a malformed routine: the chat shows why svett refused it, and no proposal shows.
#
# It fails when a screen, a state, a routine, the folder or the refusal does not show,
# or when the Train tab lists a routine before Apply or after Undo.
#
# It reaches every element by scrolling, because at the largest text size most screens
# are taller than the phone. It presses an element at the centre of its frame, as
# checks.sh does, only once two reads of the frame agree, so a scroll has settled, and
# drags the screen up first when the centre is at the bottom edge. Apply and Undo are
# native bar items, pressed by label. Nothing here opens an alert or a sheet.
#
# Screenshots are numbered PNGs in out-dir, by default ~/svett-proof/<branch>/proposals/.
# Like tabs.sh, Debug opens the development client on Metro at SVETT_METRO, --release
# opens the installed Release build, and every step runs through SVETT_DEVICE_CMD when
# it is set.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/proposals}
mkdir -p "$out"
out=$(cd "$out" && pwd)
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The You tab showing means the app has loaded and can take a svett:// link.
you_tab='label="You, tab, 5 of 5"'

# The stand-ins' questions, and what the Train tab lists once each is applied.
# packages/tools/src/coach.test.ts checks these rows against the stand-ins.
routine_question="Plan an upper body routine for me"
routine_title="Upper body strength"
routine_row="$routine_title, Barbell Bench Press - Medium Grip, Bent Over Barbell Row, Standing Military Press"
program_question="Plan a three-day push, pull and legs program for me"
program_folder="Coach 3-day split"
program_rows=(
  "Day 1 Push, Barbell Bench Press - Medium Grip, Standing Military Press, Dips - Triceps Version"
  "Day 2 Pull, Barbell Deadlift, Pullups, Seated Cable Rows"
  "Day 3 Legs, Barbell Squat, Romanian Deadlift, Lying Leg Curls"
)
malformed_question="Plan a leg day for me"
malformed_title="Leg day"

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

front_flags=()
[[ "$release" == true ]] || front_flags=(--launch-url "$(dev_client_url "http://$metro")")

# A fresh copy of the fixture each run means each run starts with no chat and no
# proposal.
pnpm fixture --out "$out/svett-fixture.db"
documents="$(xcrun simctl get_app_container "$udid" "$bundle_id" data)/Documents"
mkdir -p "$documents"
database="$documents/svett-fixture.db"
rm -f "$database-wal" "$database-shm"
cp "$out/svett-fixture.db" "$database"
for stand_in in routine program malformed; do
  cp "packages/tools/fixtures/coach-propose-$stand_in.json" "$documents/coach-propose-$stand_in.json"
done

restore() {
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

fail() {
  agent_device screenshot "$out/failed.png" >/dev/null 2>&1 || true
  echo "$1 The screen is in $out/failed.png" >&2
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

encode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

open_link() {
  agent_device open "$bundle_id" "$1"
}

# expect <selector> <what is missing>: waits for a screen's top element.
expect() {
  agent_device wait "$1" "${timeout:-15000}" >/dev/null || fail "$2 did not show."
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

# nowhere <selector> <what is wrongly there>: fails when a scroll down or up finds it.
nowhere() {
  if reveal "$1"; then fail "$2"; fi
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
  local before after reads
  before=$(centre_of "$1") || return 1
  for reads in 1 2 3 4 5 6 7 8 9 10; do
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

# expect_text <selector> <text>: reads the element until it holds the text, for up to
# 10 seconds, because a press takes a moment to save and show.
expect_text() {
  local text attempt
  bring "$1" "$1"
  for attempt in $(seq 10); do
    text=$(agent_device get text "$1") || fail "Could not read $1."
    [[ "$text" != *"$2"* ]] || return 0
    ((attempt == 10)) || agent_device wait 1000 >/dev/null
  done
  fail "Expected $1 to show \"$2\", but it shows \"$text\"."
}

# ask <stand-in> <question>: relaunches svett on the fixture with the stand-in and asks.
ask() {
  local flags=(--relaunch ${front_flags[@]+"${front_flags[@]}"})
  local argument
  for argument in -svettFixture "$database" -svettChatGPTStub signedIn \
    -svettCoachStub "$documents/coach-propose-$1.json"; do
    flags+=("--launch-args=$argument")
  done
  agent_device open "$bundle_id" "${flags[@]}"
  agent_device wait "$you_tab" 120000 >/dev/null || fail "svett did not show its tabs."
  open_link "svett://coach?ask=$(encode "$2")"
  timeout=60000 expect 'id="coach-answer"' "The coach's answer to \"$2\""
}

open_train() {
  open_link "svett://train"
  expect 'id="routine-list"' "The Train tab's routines"
}

# preview <title>: opens the proposal's preview from its card in the chat.
preview() {
  open_link "svett://coach"
  expect 'id="coach"' "The coach"
  tap "label=\"Preview $1\"" "The card for the proposal \"$1\""
  expect 'id="proposal"' "The preview of \"$1\""
  expect_text 'id="proposal-title"' "$1"
}

# press_bar <label>: presses Apply or Undo in the preview's header and waits for its result.
press_bar() {
  local item="label=\"$1\""
  expect "$item" "$1 in the preview's header"
  tap "$item" "$1 in the preview's header"
}

row() {
  echo "id=\"routine-row\" label=\"$1\""
}

folder() {
  echo "id=\"folder-name\" label=\"$1\""
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large

# A routine.
ask routine "$routine_question"
bring "label=\"Preview $routine_title\"" "The card for \"$routine_title\" under the answer"
screenshot routine-answer
open_train
nowhere "$(row "$routine_row")" "The Train tab lists \"$routine_title\" before Apply."
preview "$routine_title"
expect_text 'id="proposal-status"' "Not applied"
screenshot routine-preview
bring 'id="proposal-set-0-2-2"' "The third set of the routine's third exercise"
bring 'id="proposal-end"' "The end of the preview"
screenshot routine-preview-end
press_bar Apply
expect_text 'id="proposal-status"' "Applied"
screenshot routine-applied
open_train
bring "$(row "$routine_row")" "\"$routine_title\" on the Train tab after Apply"
screenshot routine-on-train
preview "$routine_title"
press_bar Undo
expect_text 'id="proposal-status"' "Undone"
screenshot routine-undone
open_train
nowhere "$(row "$routine_row")" "The Train tab still lists \"$routine_title\" after Undo."
screenshot routine-gone

# A program of three routines in a new folder.
ask program "$program_question"
bring "label=\"Preview $program_folder\"" "The card for \"$program_folder\" under the answer"
screenshot program-answer
open_train
nowhere "$(folder "$program_folder")" "The Train tab shows the folder \"$program_folder\" before Apply."
preview "$program_folder"
expect_text 'id="proposal-status"' "Not applied"
screenshot program-preview
for routine in 0 1 2; do
  bring "id=\"proposal-routine-$routine\"" "Routine $((routine + 1)) of the program in the preview"
done
bring 'id="proposal-end"' "The end of the preview"
screenshot program-preview-end
press_bar Apply
expect_text 'id="proposal-status"' "Applied"
open_train
bring "$(folder "$program_folder")" "The folder \"$program_folder\" on the Train tab after Apply"
for program_row in "${program_rows[@]}"; do
  bring "$(row "$program_row")" "\"${program_row%%,*}\" on the Train tab after Apply"
done
screenshot program-on-train
preview "$program_folder"
press_bar Undo
expect_text 'id="proposal-status"' "Undone"
open_train
nowhere "$(folder "$program_folder")" "The Train tab still shows the folder \"$program_folder\" after Undo."
for program_row in "${program_rows[@]}"; do
  nowhere "$(row "$program_row")" "The Train tab still lists \"${program_row%%,*}\" after Undo."
done
screenshot program-gone

# A malformed routine: svett refuses it, stores nothing and says why.
ask malformed "$malformed_question"
bring 'id="coach-proposal-error"' "Why svett refused the malformed routine"
expect_text 'id="coach-proposal-error"' "svett refused a proposal from the coach, so nothing was saved."
screenshot malformed
nowhere "label=\"Preview $malformed_title\"" "The chat shows a card for the malformed \"$malformed_title\"."

echo "The routine and the program each showed on the Train tab only after Apply and left it after Undo, and svett refused the malformed routine. Screenshots are in $out"
