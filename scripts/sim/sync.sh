#!/usr/bin/env bash
# Proves sync on rena-devbook with two simulators signed in to one svett account.
# Run it after devbook-build.sh has installed the same build, with the same
# --release choice, on both simulators. The build needs
# EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a Clerk development instance's key, and
# the svett server it syncs with must run S2's sync.
#
# Usage: scripts/sim/sync.sh [--release] [out-dir]
#
# It resets both simulators' Keychains and svett's files, so each starts signed
# out with no data. At the largest text size it signs both in to one account and
# syncs each. Then it relaunches both offline, pointed at a server address nothing
# answers on, and saves a different custom exercise on each, which each phone
# says it cannot upload yet. Then it relaunches both online and syncs phone A,
# phone B and phone A again. Each phone must then find both exercises. It fails
# when any of those does not show.
#
# The account is a Clerk test address, whose code is always 424242, so no email
# is read. SVETT_SYNC_EMAIL overrides it. SVETT_SYNC_STAMP names this run's
# exercises, by default the time. SVETT_OFFLINE_SERVER is the address that keeps
# a phone offline, by default http://127.0.0.1:9.
#
# Phone A is SVETT_SIMULATOR, as in the other scripts. Phone B is
# SVETT_SIMULATOR_B, by default "svett iPhone 16 Pro Max B". Inside T3 Code,
# SVETT_DEVICE_CMD drives phone A and SVETT_DEVICE_CMD_B phone B, each the command
# device_open returned for that simulator. Screenshots go to out-dir, by default
# ~/svett-proof/<branch>/sync/, named a-* and b-* by phone.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/sync}
bundle_id=com.kron00.svett
email=${SVETT_SYNC_EMAIL:-svett-sync-proof+clerk_test@example.com}
stamp=${SVETT_SYNC_STAMP:-$(date +%Y%m%d-%H%M%S)}
offline_server=${SVETT_OFFLINE_SERVER:-http://127.0.0.1:9}
test_code=424242
train_tab='label="Train, tab, 2 of 5"'

if [[ -n "${SVETT_DEVICE_CMD:-}" && -z "${SVETT_DEVICE_CMD_B:-}" ]]; then
  echo "SVETT_DEVICE_CMD_B must hold device_open's command for phone B when SVETT_DEVICE_CMD is set" >&2
  exit 64
fi

if command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
fi

# shellcheck source=scripts/sim/simulator.sh
source scripts/sim/simulator.sh
name_a=$simulator_name
name_b=${SVETT_SIMULATOR_B:-"$default_simulator B"}
udid_a=$(simulator_udid "$name_a")
udid_b=$(simulator_udid "$name_b")
for pair in "$name_a:$udid_a" "$name_b:$udid_b"; do
  [[ -n "${pair#*:}" ]] || {
    echo "No available iOS 27 simulator named \"${pair%%:*}\". Run scripts/devbook-build.sh for it first." >&2
    exit 1
  }
done

mkdir -p "$out"
out=$(cd "$out" && pwd)
open_flags=(--relaunch)
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")

# Every phone step runs on the phone named here, a or b.
phone=a
on() { phone=$1; }

agent() {
  local command udid session
  if [[ "$phone" == a ]]; then
    command=${SVETT_DEVICE_CMD:-} udid=$udid_a session=svett-proof
  else
    command=${SVETT_DEVICE_CMD_B:-} udid=$udid_b session=svett-proof-b
  fi
  if [[ -n "$command" ]]; then
    eval "$command $(printf '%q ' "$@")"
  else
    npx --yes agent-device@0.21.37 "$@" --platform ios --udid "$udid" --session "$session"
  fi
}

fail() {
  echo "Phone $phone: $1" >&2
  exit 1
}

# Each phone starts signed out, with no svett data and no answer to the move
# offer. svett is stopped first, so it holds none of its files open.
for udid in "$udid_a" "$udid_b"; do
  xcrun simctl terminate "$udid" "$bundle_id" || true
  xcrun simctl keychain "$udid" reset
  sqlite="$(xcrun simctl get_app_container "$udid" "$bundle_id" data)/Documents/SQLite"
  mkdir -p "$sqlite"
  rm -f "$sqlite"/svett-*.db* "$sqlite"/ExpoSQLiteStorage*
done

restore() {
  local each
  for each in a b; do
    on "$each"
    agent settings text-size large || true
    [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent close || true
  done
}
trap restore EXIT

shot=0
screenshot() {
  shot=$((shot + 1))
  local path
  path=$(printf '%s/%02d-%s-%s.png' "$out" "$shot" "$phone" "$1")
  agent screenshot "$path"
  echo "Saved $path"
}

encode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

# Scrolls the screen until the element $1 is on screen.
reveal() {
  agent is visible "$1" >/dev/null 2>&1 ||
    agent scroll down --until "$1" >/dev/null 2>&1 ||
    agent scroll up --until "$1" >/dev/null 2>&1 ||
    fail "$1 never came on screen"
}

# Prints the centre of element $1's frame. agent-device 0.21.37 refuses a selector
# press inside screen content on iOS 27 as covered, because it reads UIKit's
# touch-transparent floating bar containers as toolbars over the whole screen. A
# press or fill at coordinates skips that check.
centre() {
  local frame
  frame=$(agent get attrs "$1") || fail "$1 is not on screen"
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

# Presses the centre of element $1. A centre in the home indicator area at the
# screen's bottom edge, below about y=840, is dragged up first.
tap() {
  local point
  reveal "$1"
  point=$(centre "$1")
  if ((${point#* } > 840)); then
    agent scroll down >/dev/null 2>&1 || true
    point=$(centre "$1")
  fi
  agent press "${point% *}" "${point#* }"
}

fill() {
  local point
  reveal "$1"
  point=$(centre "$1")
  agent fill "${point% *}" "${point#* }" "$2"
  agent scroll down >/dev/null 2>&1 || true
}

# relaunch [online|offline] restarts svett. Offline points it at a server address
# nothing answers on. iOS keeps launch arguments for that launch only.
relaunch() {
  local flags=("${open_flags[@]}")
  [[ "$1" == online ]] || flags+=("--launch-args=-svettServer" "--launch-args=$offline_server")
  agent open "$bundle_id" "${flags[@]}"
  agent wait "$train_tab" 120000 || fail "svett did not show its tabs after the relaunch"
}

open_account() {
  agent open "$bundle_id" svett://account
  agent wait 'id="account"' 30000 || fail "Account did not open"
  if agent is visible 'id="accounts-off"' >/dev/null 2>&1; then
    fail "This build has no Clerk key. Build it with EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a development instance's publishable key."
  fi
}

sign_in() {
  agent wait 'id="sign-in-choose"' 30000 || fail "Account did not offer the sign-in choices"
  tap 'id="continue-with-email"'
  agent wait 'id="sign-in-email"' 10000 || fail "The email step did not show"
  fill 'id="email-field"' "$email"
  tap 'id="send-code"'
  agent wait 'id="sign-in-code"' 30000 || fail "The code step did not show"
  fill 'id="code-field"' "$test_code"
  tap 'id="check-code"'
  agent wait 'id="signed-in"' 60000 || fail "Signing in as $email did not finish"
}

# sync_reads <status> presses Sync now on Account and waits until the sync
# status reads exactly <status>.
sync_reads() {
  local text="" tries
  open_account
  agent wait 'id="signed-in"' 30000 || fail "Account is not signed in"
  tap 'id="sync-now"'
  reveal 'id="sync-status"'
  for tries in $(seq 60); do
    text=$(agent get text 'id="sync-status"' 2>/dev/null || true)
    [[ "$text" == "$1" ]] && break
    agent wait 1000 >/dev/null
  done
  [[ "$text" == "$1" ]] || fail "The sync status should read \"$1\", but it reads \"$text\" after $tries tries"
  echo "Phone $phone: $text"
}

# add_exercise <name> saves a custom exercise through the new exercise form.
add_exercise() {
  agent open "$bundle_id" "svett://exercises/new?name=$(encode "$1")&muscle=chest&equipment=cable"
  agent wait 'id="exercise-form"' 10000 || fail "The new exercise form did not open"
  tap 'id="save-exercise"'
  agent wait "id=\"exercise-name\" label=\"$1\"" 10000 || fail "Saving \"$1\" did not open its detail"
}

# finds <name> searches the library and fails unless its first result is <name>.
finds() {
  local attrs label
  agent open "$bundle_id" "svett://exercises?q=$(encode "$1")"
  agent wait 'id="exercise-library"' 10000 || fail "The exercise library did not open"
  attrs=$(agent get attrs 'id="exercise-result-0"' 2>/dev/null) || fail "The search for \"$1\" showed no result"
  label=$(node -e 'console.log(JSON.parse(process.argv[1]).label ?? "")' "$attrs")
  [[ "$label" == "$1" || "$label" == "$1,"* ]] || fail "The search for \"$1\" did not find it. Its first result is \"$label\"."
  echo "Phone $phone finds \"$1\""
}

a_name="Sync A $stamp"
b_name="Sync B $stamp"
up_to_date="Up to date"
waiting="Cannot reach svett. 1 change waits on this phone, and sync tries again soon."

for each in a b; do
  on "$each"
  # Proof is at the largest text size. A running app adopts it only when it relaunches.
  agent settings text-size accessibility-extra-extra-extra-large
  relaunch online
  open_account
  sign_in
  if agent is visible 'id="move-offer"' >/dev/null 2>&1; then
    fail "svett offered to move data into the account, but the phone had none"
  fi
  sync_reads "$up_to_date"
  screenshot signed-in
done

on a
relaunch offline
add_exercise "$a_name"
sync_reads "$waiting"
screenshot offline-edit

on b
relaunch offline
add_exercise "$b_name"
sync_reads "$waiting"
screenshot offline-edit

for each in a b a; do
  on "$each"
  relaunch online
  sync_reads "$up_to_date"
  screenshot synced
done

for each in a b; do
  on "$each"
  finds "$a_name"
  screenshot finds-a
  finds "$b_name"
  screenshot finds-b
done

echo "Both phones hold both offline edits. Screenshots are in $out"
