#!/usr/bin/env bash
# Relaunches svett on rena-devbook with extra launch arguments, for example a
# fixture: scripts/sim/launch.sh -svettFixture /path/to/fixture.json
# Run it after devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/launch.sh [--release] [app-argument...]
#
# Debug opens the development client on Metro at SVETT_METRO. --release opens
# the installed Release build with no development server. Like tabs.sh, it uses
# SVETT_DEVICE_CMD when set and its own agent-device session otherwise. It leaves
# the app running.
set -euo pipefail

release=false
if [[ "${1:-}" == --release ]]; then
  release=true
  shift
fi

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
bundle_id=com.kron00.svett

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

open_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")
# The = form keeps agent-device from reading an argument such as -svettFixture as a flag.
for argument in "$@"; do
  open_flags+=("--launch-args=$argument")
done

agent_device open "$bundle_id" "${open_flags[@]}"
