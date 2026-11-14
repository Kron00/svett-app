#!/usr/bin/env bash
# Proves svett's block and account deletion on rena-devbook's simulator. Run it
# after devbook-build.sh, with the same --release choice, on a build made with
# EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a Clerk development instance's key,
# against a server that runs S5 with Clerk set up, CLERK_SECRET_KEY included.
#
# Usage: scripts/sim/safety.sh [--release] [out-dir]
#
# Run `node apps/server/src/safety-proof.ts` against the same server first. It
# leaves the public profile safety_proof_a, which this script blocks.
# SVETT_SAFETY_OTHER names another profile.
#
# It resets the simulator's Keychain and svett's data, signs in with email as a
# Clerk test account, and at the largest text size chooses the username
# SVETT_SAFETY_USERNAME (safety_proof_d by default) and saves a custom exercise
# named SVETT_SAFETY_EXERCISE in the account's data. It opens the other profile,
# presses Block in the navigation bar and confirms, checks the profile says it is
# blocked and Blocked accounts lists it, and unblocks it. Then on Account it
# presses Delete account, chooses Keep a copy on this phone and confirms. It
# checks svett signs out and the custom exercise is still on the phone with no
# account. It fails when any screen, row or result it expects does not show.
#
# Deleting the account deletes its Clerk user, so each run signs up again with
# the same test address. The address's code is always 424242, so no email is
# read. SVETT_SAFETY_EMAIL overrides it. Screenshots go to out-dir, by default
# ~/svett-proof/<branch>/safety/. Like checks.sh, Debug opens the development
# client on Metro at SVETT_METRO, --release opens the installed Release build,
# and every step runs through SVETT_DEVICE_CMD when it is set.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/safety}
bundle_id=com.kron00.svett
email=${SVETT_SAFETY_EMAIL:-svett-safety-d+clerk_test@example.com}
username=${SVETT_SAFETY_USERNAME:-safety_proof_d}
other=${SVETT_SAFETY_OTHER:-safety_proof_a}
other_id=$(tr '[:upper:]' '[:lower:]' <<<"$other")
exercise=${SVETT_SAFETY_EXERCISE:-Safety proof press}
test_code=424242
progress_tab='label="Progress, tab, 3 of 5"'

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
open_flags=(--relaunch)
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")

# The phone starts with no session and no data, so signing in offers no move, and
# the exercise found after the deletion can only be the account's kept copy.
# svett is stopped first, so it holds none of these files open.
xcrun simctl terminate "$udid" "$bundle_id" || true
xcrun simctl keychain "$udid" reset
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
sqlite="$data/Documents/SQLite"
mkdir -p "$sqlite"
rm -f "$sqlite"/svett-anonymous.db* "$sqlite"/svett-account-*.db* "$sqlite"/ExpoSQLiteStorage*
echo "Removed svett's databases and sign-in from the simulator"

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

encode() {
  node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"
}

# Scrolls the screen until the element $1 is on screen.
reveal() {
  agent_device is visible "$1" >/dev/null 2>&1 ||
    agent_device scroll down --until "$1" >/dev/null 2>&1 ||
    agent_device scroll up --until "$1"
}

# Prints the centre of element $1's frame. agent-device 0.21.37 refuses a selector
# press inside screen content on iOS 27 as covered, because it reads UIKit's
# touch-transparent floating bar containers as toolbars over the whole screen. A
# press or fill at coordinates skips that check.
centre() {
  local frame
  frame=$(agent_device get attrs "$1") || return 1
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

# Presses the centre of element $1 once two reads of its frame agree, since iOS
# takes a tap on a gliding screen as a stop. Below about y=840 the press would land
# on the home indicator, so the screen is dragged up first.
tap() {
  local point again
  reveal "$1" || fail "$1 never came on screen"
  point=$(centre "$1") || fail "$1 is not on screen"
  if ((${point#* } > 840)); then
    agent_device scroll down >/dev/null 2>&1 || true
    point=$(centre "$1") || fail "$1 is not on screen"
  fi
  again=$(centre "$1") || fail "$1 is not on screen"
  while [[ "$again" != "$point" ]]; do
    point=$again
    again=$(centre "$1") || fail "$1 is not on screen"
  done
  agent_device press "${point% *}" "${point#* }"
}

# fill <field> <text> replaces the text of the field. The keyboard then covers the
# lower screen, yet what it covers still counts as visible, so a drag closes it
# before the next press.
fill() {
  local point
  reveal "$1"
  point=$(centre "$1")
  agent_device fill "${point% *}" "${point#* }" "$2"
  agent_device scroll down >/dev/null 2>&1 || true
}

open_link() {
  agent_device open "$bundle_id" "$1"
  agent_device wait "$2" 30000
}

# expect <selector> <what is missing, for the failure message>
expect() {
  agent_device wait "$1" 30000 >/dev/null || fail "$2"
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
agent_device open "$bundle_id" "${open_flags[@]}"
agent_device wait "$progress_tab" 120000

open_link svett://account 'id="account"'
if agent_device is visible 'id="accounts-off"' >/dev/null 2>&1; then
  fail "This build has no Clerk key. Build it with EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a development instance's publishable key."
fi
agent_device wait 'id="sign-in-choose"' 30000
tap 'id="continue-with-email"'
agent_device wait 'id="sign-in-email"' 10000
fill 'id="email-field"' "$email"
tap 'id="send-code"'
agent_device wait 'id="sign-in-code"' 30000
fill 'id="code-field"' "$test_code"
tap 'id="check-code"'
agent_device wait 'id="signed-in"' 60000
echo "Signed in as $email"

open_link "svett://profile/edit?username=$username" 'id="username-field"'
tap 'id="save-profile"'
agent_device wait absent 'id="username-field"' 30000 ||
  fail "Saving the username $username failed: $(agent_device get text 'id="username-field"' 2>&1 || true)"

open_link "svett://exercises/new?name=$(encode "$exercise")&muscle=chest&equipment=cable" 'id="exercise-form"'
tap 'id="save-exercise"'
expect "id=\"exercise-name\" label=\"$exercise\"" "Saving the exercise \"$exercise\" did not open its detail"
echo "Saved the custom exercise \"$exercise\" in the account's data"

open_link "svett://people/$other" 'id="profile-username"'
expect "id=\"profile-username\" label=\"$other\"" "$other's profile did not open. Run apps/server/src/safety-proof.ts against this server first."
screenshot profile
tap "label=\"Block $other\""
# svett's own confirmation, which alert accept cannot answer.
tap 'label="Block"'
expect 'id="profile-blocked"' "Blocking $other did not finish: $(agent_device get text 'id="block-problem"' 2>&1 || true)"
screenshot blocked
echo "Blocked $other from the profile's navigation bar"

open_link svett://profile/blocked 'id="blocks"'
expect "id=\"blocked-$other_id\"" "Blocked accounts does not list $other"
screenshot blocked-accounts
tap "id=\"unblock-$other_id\""
expect 'id="blocks-empty"' "Unblocking $other did not empty Blocked accounts"
echo "Unblocked $other from Blocked accounts"

open_link svett://account 'id="signed-in"'
tap 'id="delete-account"'
expect 'id="delete-keep-copy"' "Delete account did not ask what happens to this phone's copy"
reveal 'id="delete-erase-copy"' || fail "Delete account did not offer to erase this phone's copy"
screenshot delete-choice
tap 'id="delete-keep-copy"'
# svett's own confirmation, which alert accept cannot answer.
tap 'label="Delete account"'
agent_device wait 'id="sign-in-choose"' 60000 ||
  fail "Deleting the account did not sign out: $(agent_device get text 'id="sign-in-problem"' 2>&1 || true)"
screenshot signed-out
echo "Deleted the account, and svett signed out"

open_link "svett://exercises?q=$(encode "$exercise")" 'id="exercise-library"'
attrs=$(agent_device get attrs 'id="exercise-result-0"') ||
  fail "\"$exercise\" is not on the phone after the deletion kept a copy"
node -e '
  const { label } = JSON.parse(process.argv[1]);
  if (label !== process.argv[2] && !String(label).startsWith(`${process.argv[2]},`)) {
    console.error(`The first result was not "${process.argv[2]}". Its label is "${label}".`);
    process.exit(1);
  }
' "$attrs" "$exercise" || exit 1
screenshot kept-copy
echo "The kept copy holds \"$exercise\" with no account. Screenshots are in $out"
