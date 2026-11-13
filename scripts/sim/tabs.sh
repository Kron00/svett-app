#!/usr/bin/env bash
# Takes the tab and appearance proof screenshots on rena-devbook. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/tabs.sh [--release] [out-dir]
#
# Writes numbered PNGs to out-dir, by default ~/svett-proof/<branch>/. Debug
# reopens the development client on Metro at localhost:8081. --release opens the
# installed Release build with no development server. When SVETT_DEVICE_CMD holds
# the agent-device command from T3 Code's device_open, every step runs through it
# and the T3 session stays open for device_close.
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)}
bundle_id=com.kron00.svett
tabs=(Home Train Progress Coach You)

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

shot=0
screenshot() {
  shot=$((shot + 1))
  local path
  path=$(printf '%s/%02d-%s.png' "$out" "$shot" "$1")
  agent_device screenshot "$path"
  echo "Saved $path"
}

# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
tab_label() {
  printf 'label="%s, tab, %d of %d"' "${tabs[$1]}" $(($1 + 1)) "${#tabs[@]}"
}

mkdir -p "$out"
open_flags=(--relaunch)
[[ "$release" == true ]] || open_flags+=(--metro-host 127.0.0.1 --metro-port 8081)

# Leaves the simulator light and frees its own session, also when a step fails.
if [[ -n "${SVETT_DEVICE_CMD:-}" ]]; then
  trap 'agent_device settings appearance light || true' EXIT
else
  trap 'agent_device settings appearance light || true; agent_device close || true' EXIT
fi

agent_device open "$bundle_id" "${open_flags[@]}"
agent_device settings appearance light
agent_device wait "$(tab_label 0) selected=true" 120000
screenshot launch

for i in "${!tabs[@]}"; do
  agent_device press "$(tab_label "$i")"
  agent_device wait "$(tab_label "$i") selected=true" 10000
  screenshot "$(tr '[:upper:]' '[:lower:]' <<<"${tabs[i]}")"
done

agent_device settings appearance dark
agent_device wait 1500
screenshot dark

echo "Screenshots are in $out"
