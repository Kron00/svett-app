#!/usr/bin/env bash
# Proves the coach on rena-devbook. Run it after devbook-build.sh, with the same
# --release choice.
#
# Usage: scripts/sim/coach.sh [--release] [--live] [out-dir]
#
# First it runs the Swift tests, which read the coach's stand-in streams and check
# every request, and saves their output as swift-test.txt. Then it copies the
# 300-workout fixture and the stand-in fixtures into the app's data container and, at
# the largest text size, relaunches svett once per state: signed out, a plan without
# plan usage, "What was my best squat set last month?" answered from the stand-in with
# the tools reading the fixture, and the plan's limit. It asks through
# svett://coach?ask=..., and fails when a state, the answer or the data it read does
# not show. Under the answer it shoots the composer and fails unless it is whole: the
# question field taller than its 44 point minimum, Send a full target under it, and both
# above the tab bar.
#
# --live skips the stand-ins. It asks the same question of OpenAI with a real ChatGPT
# account, signing in first when svett is signed out (a person signs in within 10
# minutes), and records the exchange as coach-live.json in out-dir. That file replaces
# packages/tools/fixtures/coach-best-squat.json, and pnpm test replays it.
#
# Screenshots are numbered PNGs in out-dir, by default ~/svett-proof/<branch>/coach/.
# Like tabs.sh, Debug opens the development client on Metro at SVETT_METRO, --release
# opens the installed Release build, and every step runs through SVETT_DEVICE_CMD when
# it is set.
set -euo pipefail

usage() {
  echo "Usage: $0 [--release] [--live] [out-dir]" >&2
  exit 64
}

release=false
live=false
while [[ "${1:-}" == --* ]]; do
  case $1 in
    --release) release=true ;;
    --live) live=true ;;
    *) usage ;;
  esac
  shift
done
[[ $# -le 1 ]] || usage

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
out=${1:-$HOME/svett-proof/$(git branch --show-current)/coach}
mkdir -p "$out"
out=$(cd "$out" && pwd)
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The You tab showing means the app has loaded and can take a svett:// link.
you_tab='label="You, tab, 5 of 5"'
question="What was my best squat set last month?"
ask_link="svett://coach?ask=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$question")"

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

if [[ "$live" == false ]]; then
  scripts/chatgpt-tests.sh 2>&1 | tee "$out/swift-test.txt"
  echo "Saved $out/swift-test.txt"
fi

# The fixture and the stand-ins go where svett can read them. A fresh copy each run
# means each run starts with no chat.
pnpm fixture --out "$out/svett-fixture.db"
documents="$(xcrun simctl get_app_container "$udid" "$bundle_id" data)/Documents"
mkdir -p "$documents"
database="$documents/svett-fixture.db"
rm -f "$database-wal" "$database-shm"
cp "$out/svett-fixture.db" "$database"
best_squat="$documents/coach-best-squat.json"
plan_limit="$documents/coach-plan-limit.json"
cp packages/tools/fixtures/coach-best-squat.json "$best_squat"
cp packages/tools/fixtures/coach-plan-limit.json "$plan_limit"
recording="$documents/coach-live.json"
rm -f "$recording"

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

# expect <what> <selector or text...>: waits for it on screen, and stops the run when it
# does not show.
expect() {
  local what=$1 timeout=${timeout:-15000}
  shift
  agent_device wait "$@" "$timeout" >/dev/null || {
    agent_device screenshot "$out/missing.png" || true
    echo "Expected $what, which did not show. The screen is in $out/missing.png" >&2
    exit 1
  }
}

# agent-device 0.21.37 refuses a selector press inside screen content on iOS 27, so
# tap presses the centre of the element's frame, as chatgpt.sh does.
tap() {
  local frame point
  frame=$(agent_device get attrs "$1")
  point=$(node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame")
  agent_device press "${point% *}" "${point#* }"
}

# composer_whole fails unless the question field has grown past its 44 point minimum,
# which one line at the largest text size outgrows, Send is a full target under it, and
# both end above the tab bar.
composer_whole() {
  node -e '
    const [field, send, tab] = process.argv.slice(1).map((json) => JSON.parse(json).rect);
    const problems = [];
    if (field.height <= 44) problems.push(`the question field is ${field.height} points tall, so its text is clipped`);
    if (send.height < 44) problems.push(`Send is ${send.height} points tall`);
    if (send.y < field.y + field.height) problems.push("Send overlaps the question field");
    if (send.y + send.height > tab.y) problems.push("Send runs under the tab bar");
    if (problems.length > 0) {
      console.error(`The composer is not whole: ${problems.join("; ")}.`);
      process.exit(1);
    }
  ' "$(agent_device get attrs 'id="coach-input"')" "$(agent_device get attrs 'id="coach-send"')" \
    "$(agent_device get attrs "$you_tab")"
}

# open_coach <link> [launch argument...] relaunches svett on the fixture with the
# arguments, then opens the link.
open_coach() {
  local link=$1 argument flags=(--relaunch ${front_flags[@]+"${front_flags[@]}"})
  shift
  for argument in -svettFixture "$database" "$@"; do
    flags+=("--launch-args=$argument")
  done
  agent_device open "$bundle_id" "${flags[@]}"
  agent_device wait "$you_tab" 120000
  agent_device open "$bundle_id" "$link"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large

if [[ "$live" == true ]]; then
  open_coach svett://coach -svettCoachRecord "$recording"
  timeout=30000 expect "the coach" 'id="coach"'
  if agent_device is visible 'id="coach-signed-out"' >/dev/null 2>&1; then
    agent_device open "$bundle_id" svett://chatgpt
    expect "the ChatGPT settings" 'id="chatgpt"'
    tap 'id="chatgpt-continue"'
    # iOS asks before the sign-in sheet opens a website.
    if agent_device alert wait 10000 >/dev/null 2>&1; then agent_device alert accept; fi
    echo "Sign in with a ChatGPT account in the simulator. Waiting up to 10 minutes."
    timeout=600000 expect "a signed-in account" 'id="chatgpt-state-signedIn"'
  fi
  agent_device open "$bundle_id" "$ask_link"
  for _ in $(seq 90); do
    agent_device is visible 'id="coach-answer"' >/dev/null 2>&1 && break
    agent_device is visible 'id="coach-failure"' >/dev/null 2>&1 && break
    agent_device wait 2000
  done
  screenshot live-answer
  [[ -f "$recording" ]] || {
    echo "svett recorded no exchange in $recording" >&2
    exit 1
  }
  cp "$recording" "$out/coach-live.json"
  echo "Saved $out/coach-live.json"
  if ! agent_device is visible 'id="coach-answer"' >/dev/null 2>&1; then
    echo "The coach did not answer. The screen is in the screenshot above." >&2
    exit 1
  fi
  echo "To make it the stand-in, run: cp $out/coach-live.json packages/tools/fixtures/coach-best-squat.json && pnpm test"
  exit 0
fi

open_coach svett://coach -svettChatGPTStub signedOut
expect "the coach's sign-in offer" 'id="coach-signed-out"'
screenshot signed-out

open_coach svett://coach -svettChatGPTStub noPlanUsage
expect "the plan usage notice" 'id="coach-plan-usage-off"'
expect "the plans that allow plan usage" text "Go, Plus, Pro and Business"
screenshot no-plan-usage

open_coach "$ask_link" -svettChatGPTStub signedIn -svettCoachStub "$best_squat"
timeout=60000 expect "the coach's answer" 'id="coach-answer"'
expect "the best squat set" text "117.5 kg for 8 reps"
expect "what the answer read" 'id="coach-sources"'
expect "the best sets the tools read from the fixture" text "Best sets of Barbell Squat, 2026-10-01 to 2026-10-31"
screenshot answer
expect "the coach's composer" 'id="coach-composer"'
screenshot composer
composer_whole || {
  echo "The screen is in the composer screenshot above." >&2
  exit 1
}

open_coach "$ask_link" -svettChatGPTStub signedIn -svettCoachStub "$plan_limit"
timeout=60000 expect "the plan's limit" 'id="coach-failure-planLimit"'
expect "the plan's wording" text "reached your ChatGPT plan's limit"
expect "the way to ChatGPT's usage settings" 'id="coach-usage-settings"'
screenshot plan-limit

echo "Screenshots and the Swift test output are in $out"
