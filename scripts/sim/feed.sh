#!/usr/bin/env bash
# Proves svett's feed, posts and inbox on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice, on a build made with
# EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set to a Clerk development instance's key,
# against a server that runs S4 with Clerk set up.
#
# Usage: scripts/sim/feed.sh [--release] [out-dir]
#
# It needs the posts `SVETT_PROOF_KEEP=1 node apps/server/src/feed-proof.ts` leaves
# on the same server: two accounts that follow each other, feed_proof_a with a
# lifting session and feed_proof_b with a run whose start time and heart rate are
# hidden. SVETT_FEED_POSTS names the two post IDs the proof prints, the lifting
# session's first. Without it, the script runs the proof itself, which needs
# CLERK_SECRET_KEY and reaches SVETT_SERVER like the proof does.
#
# The script signs in as each account in turn, at the largest text size, after
# resetting the simulator's Keychain and svett's data. Signed in as one, it opens
# Home through svett://feed, scrolls to the other's post and checks its numbers,
# then opens the post through svett://post/<id> and checks its detail:
# the run's route, distance and pace, with no heart rate and its start time hidden,
# or the lifting session's exercises and muscle split, with its calories named as
# hidden. Last it opens the inbox through svett://inbox. It fails when any screen,
# post, number or note it expects does not show, or a hidden field does.
#
# The accounts are Clerk test addresses, whose code is always 424242, so no email
# is read. SVETT_FEED_EMAILS overrides them, the lifter's first. Screenshots go to
# out-dir, by default ~/svett-proof/<branch>/feed/. Like checks.sh, Debug opens the
# development client on Metro at SVETT_METRO, --release opens the installed
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/feed}
bundle_id=com.kron00.svett
read -r lifter_email runner_email <<<"${SVETT_FEED_EMAILS:-svett-feed-a+clerk_test@example.com svett-feed-b+clerk_test@example.com}"
lifter=feed_proof_a
runner=feed_proof_b
proof=apps/server/src/feed-proof.ts
test_code=424242
progress_tab='label="Progress, tab, 3 of 5"'

if command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
fi

read -r lifting_id run_id <<<"${SVETT_FEED_POSTS:-}" || true
if [[ -z "${run_id:-}" ]]; then
  [[ -n "${CLERK_SECRET_KEY:-}" ]] || {
    echo "Set SVETT_FEED_POSTS to the two post IDs $proof prints, or CLERK_SECRET_KEY so this script runs it." >&2
    exit 64
  }
  proof_output=$(SVETT_PROOF_KEEP=1 node "$proof") || {
    echo "$proof_output" >&2
    exit 1
  }
  echo "$proof_output"
  lifting_id=$(sed -nE 's#^Lifting post: svett://post/([0-9a-f-]+)$#\1#p' <<<"$proof_output")
  run_id=$(sed -nE 's#^Run: svett://post/([0-9a-f-]+)$#\1#p' <<<"$proof_output")
fi
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "$lifting_id" =~ $uuid && "$run_id" =~ $uuid ]] || {
  echo "Expected two post IDs, got \"$lifting_id\" and \"$run_id\"" >&2
  exit 1
}

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

# Prints element $1's centre once two reads a moment apart agree, as iOS takes a
# press on a screen still gliding after a drag as a stop, not a press.
settled_centre() {
  local before after
  before=$(centre "$1") || return 1
  for _ in 1 2 3 4 5; do
    sleep 0.3
    after=$(centre "$1") || return 1
    [[ "$after" == "$before" ]] && break
    before=$after
  done
  echo "$after"
}

# Presses the centre of element $1. Below about y=840 the press would land on the
# home indicator, so the screen is dragged up first.
tap() {
  local point
  reveal "$1"
  point=$(settled_centre "$1")
  if ((${point#* } > 840)); then
    agent_device scroll down >/dev/null 2>&1 || true
    point=$(settled_centre "$1")
  fi
  agent_device press "${point% *}" "${point#* }"
}

# fill <field> <text> replaces the text of the field. The keyboard then covers the
# lower screen, yet what it covers still counts as visible, so a drag closes it
# before the next press.
fill() {
  local point
  reveal "$1"
  point=$(settled_centre "$1")
  agent_device fill "${point% *}" "${point#* }" "$2"
  agent_device scroll down >/dev/null 2>&1 || true
}

open_link() {
  agent_device open "$bundle_id" "$1"
  agent_device wait "$2" 30000
}

# expect_label <element> <label> <what> scrolls to the element and waits for it to
# read the label.
expect_label() {
  reveal "$1" || {
    echo "$3 is not on the screen" >&2
    exit 1
  }
  agent_device wait "$1 label=\"$2\"" 30000 || {
    echo "$3 should read \"$2\", but it reads: $(agent_device get text "$1" 2>&1 || true)" >&2
    exit 1
  }
  echo "$3 reads \"$2\""
}

# expect_shown <element> <what> scrolls to the element, and fails when it is not there.
expect_shown() {
  reveal "$1" || {
    echo "$2 is not on the screen" >&2
    exit 1
  }
  echo "$2 shows"
}

# expect_hidden <element> <what> fails when the screen holds the element anywhere.
expect_hidden() {
  if reveal "$1" >/dev/null 2>&1; then
    echo "$2 shows, but the owner hid it" >&2
    exit 1
  fi
  echo "$2 does not show"
}

# sign_in <email> starts svett with no session and no data, and signs in with email.
# svett is stopped first, so it holds none of these files open.
sign_in() {
  xcrun simctl terminate "$udid" "$bundle_id" || true
  xcrun simctl keychain "$udid" reset
  local data
  data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
  mkdir -p "$data/Documents/SQLite"
  rm -f "$data/Documents/SQLite"/svett-anonymous.db* "$data/Documents/SQLite"/svett-account-*.db* \
    "$data/Documents/SQLite"/ExpoSQLiteStorage*
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
  fill 'id="email-field"' "$1"
  tap 'id="send-code"'
  agent_device wait 'id="sign-in-code"' 30000
  fill 'id="code-field"' "$test_code"
  tap 'id="check-code"'
  agent_device wait 'id="signed-in"' 60000
  echo "Signed in as $1"
}

# open_feed_post <id> <what> opens Home and scrolls to the post.
open_feed_post() {
  open_link svett://feed 'id="feed"'
  reveal "id=\"post-$1\"" || {
    echo "Home has no $2. Run SVETT_PROOF_KEEP=1 node $proof against this server, and pass the post IDs it prints." >&2
    exit 1
  }
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large

sign_in "$lifter_email"
open_feed_post "$run_id" "run from $runner"
expect_label "id=\"post-numbers-$run_id\"" "4.44 km · 5:38 /km" "The run's distance and pace on Home"
expect_shown "id=\"post-route-$run_id\"" "The run's route on Home"
screenshot lifter-feed
open_link "svett://post/$run_id" 'id="post-title"'
expect_label 'id="post-title"' "Feed proof, river loop" "The run's title"
expect_shown 'id="post-route"' "The run's route"
screenshot run-route
expect_label 'id="post-distance"' "Distance, 4.44 km" "The run's distance"
expect_label 'id="post-pace"' "Pace, 5:38 /km" "The run's pace"
expect_shown 'id="post-split-4"' "The run's fourth split"
expect_label 'id="post-line"' "Run · 25 min · Start time hidden" "The line under the run's title"
expect_label 'id="post-hidden"' "$runner hides heart rate and start time." "The run's hidden note"
expect_hidden 'id="post-heart-rate"' "The run's heart rate"
screenshot run-detail
open_link svett://inbox 'id="inbox"'
agent_device wait 'id="inbox-items"' 30000
screenshot lifter-inbox

sign_in "$runner_email"
open_feed_post "$lifting_id" "lifting post from $lifter"
expect_label "id=\"post-numbers-$lifting_id\"" "2 exercises · 6 sets · 2,700 kg" "The lifting post's numbers on Home"
expect_label "id=\"post-muscles-$lifting_id\"" "Quadriceps 60% · Chest 40%" "The lifting post's muscles on Home"
screenshot runner-feed
open_link "svett://post/$lifting_id" 'id="post-title"'
expect_label 'id="post-title"' "Feed proof, legs and bench" "The lifting post's title"
expect_label 'id="post-hidden"' "$lifter hides calories." "The lifting post's hidden note"
expect_shown 'id="muscle-split"' "The lifting post's muscle split"
screenshot lifting-split
expect_shown 'id="post-exercises"' "The lifting post's exercises"
screenshot lifting-sets
open_link svett://inbox 'id="inbox"'
agent_device wait 'id="inbox-items"' 30000
screenshot runner-inbox

echo "Screenshots are in $out"
