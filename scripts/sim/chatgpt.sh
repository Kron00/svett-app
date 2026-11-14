#!/usr/bin/env bash
# Proves the ChatGPT sign-in on rena-devbook. Run it after devbook-build.sh, with the
# same --release choice.
#
# Usage: scripts/sim/chatgpt.sh [--release] [--live] [out-dir]
#
# First it runs the Swift tests, which replay every answer OpenAI documents against a
# stand-in, and saves their output as swift-test.txt. Then, at the largest text size,
# it relaunches svett once per -svettChatGPTStub scenario, opens the ChatGPT settings
# through svett://chatgpt and walks each state against the stand-in: sign in through the
# sheet, sign out keeping the account, allow plan usage, a renewed and a lapsed sign-in,
# identity tokens refused for a bad signature, a wrong audience and a past expiry, an
# unconfirmed revocation, a return to the earlier of two saved accounts, and a sign-in
# through Safari. It fails when a state or message
# it expects does not show.
#
# --live skips all that and signs in with a real ChatGPT account, which a person types
# into the simulator within 10 minutes, then signs out. It runs only on request.
#
# Screenshots are numbered PNGs in out-dir, by default ~/svett-proof/<branch>/chatgpt/.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/chatgpt}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The You tab showing means the app has loaded and can take the svett://chatgpt link.
you_tab='label="You, tab, 5 of 5"'

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
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
front_flags=()
[[ "$release" == true ]] || front_flags=(--launch-url "$(dev_client_url "http://$metro")")

if [[ "$live" == false ]]; then
  scripts/chatgpt-tests.sh 2>&1 | tee "$out/swift-test.txt"
  echo "Saved $out/swift-test.txt"
fi

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

# Brings the element $1 on screen and presses its centre.
tap() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1"
  press_centre "$1"
}

# Relaunches svett with the stand-in scenario $1, or none, and opens the ChatGPT settings.
open_chatgpt() {
  local flags=(--relaunch ${front_flags[@]+"${front_flags[@]}"})
  [[ -z "${1:-}" ]] || flags+=(--launch-args=-svettChatGPTStub "--launch-args=$1")
  agent_device open "$bundle_id" "${flags[@]}"
  agent_device wait "$you_tab" 120000
  agent_device open "$bundle_id" svett://chatgpt
  expect "the ChatGPT settings" 'id="chatgpt"'
}

# iOS asks before the sign-in sheet opens a website. A sign-in that reuses Safari's
# session may not ask.
allow_sheet() {
  agent_device alert wait 10000 >/dev/null 2>&1 || return 0
  agent_device alert accept
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large

if [[ "$live" == true ]]; then
  open_chatgpt
  if agent_device is visible 'id="chatgpt-state-signedIn"' >/dev/null 2>&1; then
    tap 'id="chatgpt-sign-out"'
    expect "the signed-out state" 'id="chatgpt-state-signedOut"'
  fi
  screenshot live-signed-out
  tap 'id="chatgpt-continue"'
  allow_sheet
  echo "Sign in with a ChatGPT account in the simulator. Waiting up to 10 minutes."
  timeout=600000 expect "a signed-in account" 'id="chatgpt-state-signedIn"'
  expect "plan usage allowed" text "Allowed"
  screenshot live-signed-in
  tap 'id="chatgpt-sign-out"'
  expect "the signed-out state" 'id="chatgpt-state-signedOut"'
  if agent_device is visible 'id="chatgpt-message"' >/dev/null 2>&1; then
    screenshot live-revocation-unconfirmed
    echo "OpenAI did not confirm the revocation" >&2
    exit 1
  fi
  screenshot live-signed-out-again
  echo "Live sign-in and sign-out passed. Screenshots are in $out"
  exit 0
fi

open_chatgpt signedOut
expect "the signed-out state" 'id="chatgpt-state-signedOut"'
screenshot signed-out
tap 'id="chatgpt-continue"'
allow_sheet
expect "a signed-in account" 'id="chatgpt-state-signedIn"'
expect "the stand-in's account" text "you@example.com"
screenshot signed-in
tap 'id="chatgpt-sign-out"'
expect "the signed-out state" 'id="chatgpt-state-signedOut"'
expect "the kept account, offered again" 'id="chatgpt-another"'
screenshot signed-out-keeps-account

open_chatgpt noPlanUsage
expect "plan usage not allowed" 'id="chatgpt-allow"'
screenshot no-plan-usage
tap 'id="chatgpt-allow"'
allow_sheet
expect "plan usage allowed" 'id="chatgpt-manage"'
screenshot plan-usage-allowed

open_chatgpt renews
expect "a renewed sign-in" text "Renewed at"
screenshot renewed

open_chatgpt lapsed
expect "the signed-out state" 'id="chatgpt-state-signedOut"'
expect "the lapsed notice" text "lapsed"
screenshot lapsed

for refusal in "badSignature:does not match OpenAI's published keys" \
  "wrongAudience:was made for another app" "expiredToken:has expired"; do
  scenario=${refusal%%:*}
  open_chatgpt "$scenario"
  tap 'id="chatgpt-continue"'
  allow_sheet
  expect "the $scenario refusal" text "${refusal#*:}"
  expect "nothing saved after $scenario" 'id="chatgpt-state-signedOut"'
  screenshot "refused-$scenario"
done

open_chatgpt revokeFails
tap 'id="chatgpt-sign-out"'
expect "the unconfirmed revocation" text "did not confirm"
expect "the signed-out state" 'id="chatgpt-state-signedOut"'
screenshot revocation-unconfirmed

# The stand-in's account was used before another one, so it is the earlier account.
open_chatgpt twoAccounts
expect "the earlier account, offered on its own" 'id="chatgpt-account-0"'
screenshot two-accounts
tap 'id="chatgpt-account-0"'
allow_sheet
expect "a signed-in account" 'id="chatgpt-state-signedIn"'
expect "the earlier account" text "you@example.com"
screenshot returned-to-earlier-account

# Safari answers the listener while svett waits in the background. Coming back can
# reload a Debug build, so the link opens the settings again either way.
open_chatgpt signedOut
tap 'id="chatgpt-safari"'
agent_device wait 5000
screenshot safari
agent_device open "$bundle_id" ${front_flags[@]+"${front_flags[@]}"}
for _ in $(seq 30); do
  agent_device is visible 'id="chatgpt-state-signedIn"' >/dev/null 2>&1 && break
  agent_device is visible "$you_tab" >/dev/null 2>&1 && agent_device open "$bundle_id" svett://chatgpt
  agent_device wait 2000
done
expect "a sign-in finished through Safari" 'id="chatgpt-state-signedIn"'
screenshot safari-signed-in

echo "Screenshots and the Swift test output are in $out"
