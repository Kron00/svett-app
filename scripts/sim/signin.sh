#!/usr/bin/env bash
# Proves the svett account sign-in on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice, on a build made with
# EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a Clerk development instance's key.
#
# Usage: scripts/sim/signin.sh [--release] [out-dir]
#
# It resets the simulator's Keychain, which drops any Clerk session, and puts the
# fixture's 300 workouts on the phone as one Hevy import with no owner. At the
# largest text size it shows those workouts on the Progress tab, then opens Account
# through svett://account, shows both sign-in choices, and signs in with email as a
# new account. It moves the phone's data into that account and shows the account
# holds all 300 workouts. Then it signs out, shows the phone's own data is gone,
# and signs in as a second account, which sees none of that history and gets no
# second offer. It fails when any of those does not show.
#
# The accounts are Clerk test addresses, whose code is always 424242, so no email
# is read. A development instance accepts them; a production one does not.
# SVETT_SIGNIN_EMAILS overrides the two addresses, separated by a space.
# Screenshots go to out-dir, by default ~/svett-proof/<branch>/signin/. Like
# checks.sh, Debug opens the development client on Metro at SVETT_METRO, --release
# opens the installed Release build, and every step runs through SVETT_DEVICE_CMD
# when it is set.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/signin}
bundle_id=com.kron00.svett
read -r first_email second_email <<<"${SVETT_SIGNIN_EMAILS:-svett-proof-a+clerk_test@example.com svett-proof-b+clerk_test@example.com}"
[[ -n "$first_email" && -n "$second_email" ]] || {
  echo "SVETT_SIGNIN_EMAILS needs two addresses separated by a space" >&2
  exit 64
}
test_code=424242
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
progress_tab='label="Progress, tab, 3 of 5"'
counts='id="workout-counts"'

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

pnpm fixture --out "$out/svett-imported.db" --imported

# The phone starts with no session, no answer to the move offer, no account
# databases, and the imported history in the database with no owner. svett is
# stopped first, so it holds none of these files open.
xcrun simctl terminate "$udid" "$bundle_id" || true
xcrun simctl keychain "$udid" reset
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
sqlite="$data/Documents/SQLite"
mkdir -p "$sqlite"
rm -f "$sqlite"/svett-anonymous.db* "$sqlite"/svett-account-*.db* "$sqlite"/ExpoSQLiteStorage*
cp "$out/svett-imported.db" "$sqlite/svett-anonymous.db"
echo "Put the imported history in $sqlite/svett-anonymous.db"

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

tap() {
  local point
  reveal "$1"
  point=$(centre "$1")
  agent_device press "${point% *}" "${point#* }"
}

# fill <field> <text> replaces the text of the field. The keyboard then covers the
# lower screen, yet what it covers still counts as visible, so a drag closes it
# before the next press. Account closes the keyboard on any drag.
fill() {
  local point
  reveal "$1"
  point=$(centre "$1")
  agent_device fill "${point% *}" "${point#* }" "$2"
  agent_device scroll down >/dev/null 2>&1 || true
}

relaunch() {
  agent_device open "$bundle_id" "${open_flags[@]}"
  agent_device wait "$progress_tab" 120000
}

# expect_counts <pattern> <what> <shot> relaunches, opens the Progress tab and
# fails unless its counts match the extended regex.
expect_counts() {
  local text
  relaunch
  agent_device press "$progress_tab"
  agent_device wait "$counts" 10000
  agent_device wait absent "$counts label=\"Opening the database\"" 30000
  text=$(agent_device get text "$counts")
  grep -qE "$1" <<<"$text" || {
    echo "The Progress tab should show $2, but it reads: $text" >&2
    exit 1
  }
  echo "The Progress tab shows $2: $text"
  screenshot "$3"
}

open_account() {
  agent_device open "$bundle_id" svett://account
  agent_device wait 'id="account"' 30000
  if agent_device is visible 'id="accounts-off"' >/dev/null 2>&1; then
    echo "This build has no Clerk key. Build it with EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a development instance's publishable key." >&2
    exit 1
  fi
}

# sign_in <email> goes from the two choices to the end of the email code.
sign_in() {
  agent_device wait 'id="sign-in-choose"' 30000
  tap 'id="continue-with-email"'
  agent_device wait 'id="sign-in-email"' 10000
  fill 'id="email-field"' "$1"
  tap 'id="send-code"'
  agent_device wait 'id="sign-in-code"' 30000
  fill 'id="code-field"' "$test_code"
  tap 'id="check-code"'
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
expect_counts '^300 workouts, ' "the imported 300 workouts before anyone signs in" phone-data

open_account
agent_device wait 'id="sign-in-choose"' 30000
reveal 'id="continue-with-chatgpt"'
reveal 'id="continue-with-email"'
screenshot choices

sign_in "$first_email"
agent_device wait 'id="move-offer"' 60000
screenshot move-offer
tap 'id="move-data"'
agent_device wait 'id="signed-in"' 60000
screenshot first-account
expect_counts '^300 workouts, ' "all 300 workouts in the first account" first-account-data

open_account
agent_device wait 'id="signed-in"' 30000
tap 'id="sign-out"'
agent_device wait 'id="sign-in-choose"' 30000
expect_counts '^0 workouts, 0 sets' "no workouts on the phone once they moved and nobody is signed in" signed-out-data

open_account
sign_in "$second_email"
agent_device wait 'id="signed-in"' 60000
if agent_device is visible 'id="move-offer"' >/dev/null 2>&1; then
  echo "The second account got the move offer, which the phone gives only once" >&2
  exit 1
fi
screenshot second-account
expect_counts '^0 workouts, 0 sets' "none of the first account's history in the second account" second-account-data

echo "Screenshots are in $out"
