#!/usr/bin/env bash
# Proves svett's profiles, username search, follows and follow requests on
# rena-devbook's simulator. Run it after devbook-build.sh, with the same --release
# choice, on a build made with EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a Clerk
# development instance's key, against a server that runs S3 with Clerk set up.
#
# Usage: scripts/sim/social.sh [--release] [out-dir]
#
# Run `node apps/server/src/social-proof.ts` against the same server first. It
# leaves its owner account with the private profile social_proof_a, which this
# script finds and asks to follow. SVETT_SOCIAL_OTHER names another profile.
#
# It resets the simulator's Keychain and svett's data, signs in with email as a
# Clerk test account, and at the largest text size chooses the username
# SVETT_SOCIAL_USERNAME (social_proof_c by default) through
# svett://profile/edit?username=<name> and Save. It checks Profile shows that
# username, searches the start of the other profile's username, opens it from the
# results, asks to follow it, checks the button reads Requested, takes the request
# back, and opens the followers list and the follow requests. It fails when any
# screen, row or button state it expects does not show.
#
# The account is a Clerk test address, whose code is always 424242, so no email
# is read. SVETT_SOCIAL_EMAIL overrides it. Screenshots go to out-dir, by default
# ~/svett-proof/<branch>/social/. Like checks.sh, Debug opens the development
# client on Metro at SVETT_METRO, --release opens the installed Release build, and
# every step runs through SVETT_DEVICE_CMD when it is set.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/social}
bundle_id=com.kron00.svett
email=${SVETT_SOCIAL_EMAIL:-svett-social-c+clerk_test@example.com}
username=${SVETT_SOCIAL_USERNAME:-social_proof_c}
other=${SVETT_SOCIAL_OTHER:-social_proof_a}
other_id=$(tr '[:upper:]' '[:lower:]' <<<"$other")
# Search by the start of the name, so the result proves a prefix search.
prefix=${other:0:$((${#other} - 1))}
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

# The phone starts with no session and no data, so signing in offers no move.
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

# Presses the centre of element $1. Below about y=840 the press would land on the
# home indicator, so the screen is dragged up first.
tap() {
  local point
  reveal "$1"
  point=$(centre "$1")
  if ((${point#* } > 840)); then
    agent_device scroll down >/dev/null 2>&1 || true
    point=$(centre "$1")
  fi
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

# expect_label <element> <label> <what> waits for the element to read the label.
expect_label() {
  agent_device wait "$1 label=\"$2\"" 30000 || {
    echo "$3 should read \"$2\", but it reads: $(agent_device get text "$1" 2>&1 || true)" >&2
    exit 1
  }
  echo "$3 reads \"$2\""
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
agent_device open "$bundle_id" "${open_flags[@]}"
agent_device wait "$progress_tab" 120000

open_link svett://account 'id="account"'
if agent_device is visible 'id="accounts-off"' >/dev/null 2>&1; then
  echo "This build has no Clerk key. Build it with EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a development instance's publishable key." >&2
  exit 1
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
screenshot edit-profile
tap 'id="save-profile"'
agent_device wait absent 'id="username-field"' 30000 || {
  echo "Saving the username $username failed: $(agent_device get text 'id="username-field"' 2>&1 || true)" >&2
  exit 1
}

open_link svett://profile 'id="own-username"'
expect_label 'id="own-username"' "$username" "Profile's username"
reveal 'id="requests-row"'
screenshot own-profile

open_link "svett://people?q=$prefix" 'id="people-search"'
agent_device wait "id=\"person-$other_id\"" 30000 || {
  echo "Searching \"$prefix\" did not find $other. Run apps/server/src/social-proof.ts against this server first." >&2
  exit 1
}
screenshot search
tap "id=\"person-$other_id\""
agent_device wait 'id="profile-username"' 30000
expect_label 'id="profile-username"' "$other" "The opened profile's username"
expect_label 'id="follow-button"' "Ask to follow" "The follow button on a private profile"
tap 'id="follow-button"'
expect_label 'id="follow-button"' "Requested" "The follow button after asking"
screenshot requested
tap 'id="follow-button"'
expect_label 'id="follow-button"' "Ask to follow" "The follow button after taking the request back"

open_link "svett://people/$username/followers" 'id="connections"'
agent_device wait 'id="connections-empty"' 30000
screenshot followers

open_link svett://profile/requests 'id="requests"'
agent_device wait 'id="requests-empty"' 30000
screenshot requests

echo "Screenshots are in $out"
