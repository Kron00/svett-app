#!/usr/bin/env bash
# Measures the plan's five speed targets again on rena-devbook's simulator and writes
# them as one table. Run it after devbook-build.sh --release, with --release. Only a
# Release build's numbers are judged against the targets.
#
# Usage: scripts/sim/speed.sh [--release] [out-dir]
#
# - Cold start to a usable Train tab: startup.sh, the median of its launches.
# - Marking a set done, until the row shows it: logger.sh, its set-done.txt.
# - History list of 300 workouts with no blank rows: history.sh, which fails when a
#   screen of the list shows no row on the way down to the oldest workout.
# - Importing 300 workouts from a Hevy file: this script. On a new empty database
#   it opens a synthetic Hevy export of 300 workouts, written by
#   scripts/hevy-export.ts, through svett://import?file=...&kind=hevy, presses
#   Import, and reads the time svett measured itself with -svettTiming 1: reading
#   and previewing the file plus saving the import, without the wait for the press.
# - First words of a coach answer: this script. It relaunches on the 300-workout
#   fixture with the coach's stand-in answer, asks through svett://coach?ask=...,
#   and reads the time svett measured from the first words arriving to the frame
#   that showed them.
#
# Every step runs at the largest text size. Each one's screenshots and log go to
# its own folder in out-dir, by default ~/svett-proof/<branch>/speed/, and the
# table goes to speed.md there, with the columns What, Target, Measured, Build
# and Device. A step that fails says so in its row, and the script exits 1 once
# the table is written. SVETT_SPEED_SCRIPTS names the folder that holds
# startup.sh, logger.sh and history.sh, by default scripts/sim. Like tabs.sh,
# Debug opens the development client on Metro at SVETT_METRO, --release opens
# the installed Release build, and every step runs through SVETT_DEVICE_CMD when
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/speed}
sim=${SVETT_SPEED_SCRIPTS:-$repo/scripts/sim}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The You tab showing means the app has loaded and can take a svett:// link.
you_tab='label="You, tab, 5 of 5"'
question="What was my best squat set last month?"

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
release_flag=()
[[ "$release" == false ]] || release_flag=(--release)
launch_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher.
[[ "$release" == true ]] || launch_flags+=(--launch-url "$(dev_client_url "http://$metro")")
build=$([[ "$release" == true ]] && echo Release || echo "Debug, loaded from Metro, not judged")
# The iOS version heads the simulator's section in simctl's list, such as "-- iOS 27.2 --".
ios=$(xcrun simctl list devices available | awk -v udid="$udid" '
  /^-- / { version = $3; next }
  index($0, "(" udid ")") { print version; exit }')
device="$simulator_name simulator, iOS ${ios:-27}"

restore() {
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

shot=0
screenshot() {
  shot=$((shot + 1))
  local path
  path=$(printf '%s/%02d-%s.png' "$1" "$shot" "$2")
  agent_device screenshot "$path" >/dev/null
  echo "Saved $path"
}

# A step's failure ends only that step, and its row says so.
fail() {
  echo "$*" >&2
  exit 1
}

reveal() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1" >/dev/null 2>&1
}

centre_of() {
  local frame
  frame=$(agent_device get attrs "$1") || fail "Could not read where $1 is"
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

label_of() {
  agent_device get attrs "$1" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).label ?? "")'
}

# Below this line a press lands on the screen's bottom edge, where iOS 27 keeps the
# home indicator.
safe_bottom=840

# Brings the element on screen, drags it clear of the bottom edge, waits until two reads
# of its frame agree, because iOS takes a tap on a gliding screen as a stop, and presses
# its centre. agent-device 0.21.37 refuses a selector press inside screen content on
# iOS 27, so the press goes to coordinates.
tap() {
  local point before reads=0 drags=0
  reveal "$1" || fail "$1 was not on screen to press"
  point=$(centre_of "$1") || exit 1
  while ((${point#* } > safe_bottom)); do
    ((drags < 3)) || fail "$1 stayed at the bottom edge of the screen"
    agent_device gesture pan 20 600 0 -300 400 >/dev/null
    drags=$((drags + 1))
    point=$(centre_of "$1") || exit 1
  done
  before=""
  while [[ "$point" != "$before" ]]; do
    ((reads < 10)) || fail "$1 kept moving"
    before=$point
    agent_device wait 250 >/dev/null
    point=$(centre_of "$1") || exit 1
    reads=$((reads + 1))
  done
  agent_device press "${point% *}" "${point#* }" >/dev/null
}

# launch <argument...> relaunches svett with the launch arguments at the largest text size,
# which the scripts run before it put back to the default, and waits for its tabs.
launch() {
  local argument flags=("${launch_flags[@]}")
  agent_device settings text-size accessibility-extra-extra-extra-large >/dev/null
  for argument in "$@"; do
    flags+=("--launch-args=$argument")
  done
  agent_device open "$bundle_id" "${flags[@]}" >/dev/null
  agent_device wait "$you_tab" 120000 >/dev/null || fail "svett did not show its tabs"
}

documents() {
  local data
  data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
  mkdir -p "$data/Documents"
  echo "$data/Documents"
}

# Each step prints its measured value as its last line, or fails. It runs in a subshell,
# so fail and errexit end only that step.

step_startup() {
  "$sim/startup.sh" ${release_flag[@]+"${release_flag[@]}"} "$out/startup" >&2 || fail "startup.sh failed"
  local median
  median=$(sed -nE 's/^Median: cold start ([0-9]+) ms,.*/\1/p' "$out/startup/startup.txt")
  [[ -n "$median" ]] || fail "startup.txt has no median"
  echo "$median ms, the median of $(grep -c '^Launch ' "$out/startup/startup.txt") launches"
}

step_logger() {
  "$sim/logger.sh" ${release_flag[@]+"${release_flag[@]}"} "$out/logger" >&2 || fail "logger.sh failed"
  local ms
  ms=$(sed -nE 's/^Marking a set done until the row showed it: ([0-9]+) ms.*/\1/p' "$out/logger/set-done.txt")
  [[ -n "$ms" ]] || fail "set-done.txt has no time"
  echo "$ms ms"
}

step_history() {
  "$sim/history.sh" ${release_flag[@]+"${release_flag[@]}"} "$out/history" | tee "$out/history/history.log" >&2 ||
    fail "history.sh failed"
  local screens
  screens=$(sed -nE 's/^The history list showed rows on all ([0-9]+) screens down to the oldest workout$/\1/p' \
    "$out/history/history.log")
  [[ -n "$screens" ]] || fail "history.sh did not say how many screens showed rows"
  echo "No blank rows on any of $screens screens"
}

step_hevy() {
  local dir=$out/hevy file=svett-speed-hevy.csv folder database timing
  mkdir -p "$dir"
  node scripts/hevy-export.ts --out "$dir/$file" >&2
  folder=$(documents)
  cp "$dir/$file" "$folder/$file"
  database="$folder/svett-speed-hevy.db"
  # A journal left by an earlier run would be replayed onto the new file.
  rm -f "$database" "$database-wal" "$database-shm"
  launch -svettFixture "$database" -svettTiming 1
  agent_device open "$bundle_id" "svett://import?file=$file&kind=hevy" >/dev/null
  # The summary sits at the top of the preview, and Import below it.
  agent_device wait 'id="hevy-summary"' 120000 >/dev/null || fail "The Hevy export showed no preview"
  screenshot "$dir" preview >&2
  tap 'id="import-apply"'
  agent_device wait 'id="import-done"' 300000 >/dev/null || fail "The import did not finish"
  reveal 'id="import-timing"' || fail "The import result shows no time"
  screenshot "$dir" imported >&2
  timing=$(label_of 'id="import-timing"') || fail "Could not read the import's time"
  echo "$timing" >"$dir/hevy-import.txt"
  [[ "$timing" =~ ^Read\ and\ previewed\ in\ ([0-9]+)\ ms,\ imported\ in\ ([0-9]+)\ ms$ ]] ||
    fail "The import result says \"$timing\""
  echo "$((BASH_REMATCH[1] + BASH_REMATCH[2])) ms: ${BASH_REMATCH[1]} ms to read and preview, ${BASH_REMATCH[2]} ms to import"
}

step_coach() {
  local dir=$out/coach folder stub timing link
  mkdir -p "$dir"
  pnpm fixture --out "$dir/svett-fixture.db" >&2
  folder=$(documents)
  rm -f "$folder/svett-speed-coach.db" "$folder/svett-speed-coach.db-wal" "$folder/svett-speed-coach.db-shm"
  cp "$dir/svett-fixture.db" "$folder/svett-speed-coach.db"
  stub="$folder/coach-best-squat.json"
  cp packages/tools/fixtures/coach-best-squat.json "$stub"
  launch -svettFixture "$folder/svett-speed-coach.db" -svettTiming 1 \
    -svettChatGPTStub signedIn -svettCoachStub "$stub"
  link="svett://coach?ask=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$question")"
  agent_device open "$bundle_id" "$link" >/dev/null
  agent_device wait 'id="coach-answer"' 60000 >/dev/null || fail "The coach did not answer"
  reveal 'id="coach-first-words-timing"' || fail "The coach shows no time for its first words"
  screenshot "$dir" answer >&2
  timing=$(label_of 'id="coach-first-words-timing"') || fail "Could not read the coach's time"
  echo "$timing" >"$dir/first-words.txt"
  [[ "$timing" =~ ^First\ words\ shown\ ([0-9]+)\ ms\ after\ they\ arrived$ ]] ||
    fail "The coach says \"$timing\""
  echo "${BASH_REMATCH[1]} ms from arriving to the frame that showed them"
}

# row <step> <what> <target> <limit in ms or empty> runs the step and adds its row.
rows=()
failed=0
row() {
  local measured verdict="" ms status
  mkdir -p "$out/$1"
  # A step runs in its own subshell with errexit, so its first failure ends only that step.
  set +e
  (
    set -e
    step_"$1"
  ) >"$out/$1/measured.txt" 2>>"$out/$1/$1.log"
  status=$?
  set -e
  measured=$(tail -1 "$out/$1/measured.txt")
  if [[ "$status" == 0 && -n "$measured" ]]; then
    ms=$(sed -nE 's/^([0-9]+) ms.*/\1/p' <<<"$measured")
    if [[ "$release" == true && -n "$4" && -n "$ms" ]]; then
      if ((ms < $4)); then verdict=", meets the target"; else verdict=", over the target"; fi
    fi
  else
    failed=1
    measured="Not measured: $(tail -1 "$out/$1/$1.log" 2>/dev/null || echo "the step failed"). See $1/$1.log"
  fi
  echo "$2: $measured$verdict"
  rows+=("| $2 | $3 | $measured$verdict | $build | $device |")
}

row startup "Cold start to a usable Train tab" "Under 2 seconds" 2000
row logger "Marking a set done, until the row shows it" "Under 100 milliseconds" 100
row history "History list of 300 workouts" "No blank rows while scrolling" ""
row hevy "Importing 300 workouts from a Hevy file" "Under 10 seconds" 10000
row coach "First words of a coach answer" "Shown as soon as OpenAI sends them, within 100 milliseconds" 100

{
  echo "| What | Target | Measured | Build | Device |"
  echo "| --- | --- | --- | --- | --- |"
  printf '%s\n' "${rows[@]}"
} >"$out/speed.md"
cat "$out/speed.md"
echo "Saved $out/speed.md"
exit "$failed"
