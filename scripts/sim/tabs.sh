#!/usr/bin/env bash
# Takes the tab and appearance proof screenshots on rena-devbook. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/tabs.sh [--release] [out-dir]
#
# Writes numbered PNGs to out-dir, by default ~/svett-proof/<branch>/. Debug
# reopens the development client on Metro at localhost:8081. --release opens the
# installed Release build with no development server.
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
udid=$(simulator_udid "$simulator_name")
[[ -n "$udid" ]] || {
  echo "No available iOS 27 simulator named \"$simulator_name\". Run scripts/devbook-build.sh first." >&2
  exit 1
}

device() {
  npx --yes agent-device@0.21.37 "$@" --platform ios --udid "$udid" --session svett-proof
}

shot=0
screenshot() {
  shot=$((shot + 1))
  local path
  path=$(printf '%s/%02d-%s.png' "$out" "$shot" "$1")
  device screenshot "$path"
  echo "Saved $path"
}

# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
tab_label() {
  printf 'label="%s, tab, %d of %d"' "${tabs[$1]}" $(($1 + 1)) "${#tabs[@]}"
}

mkdir -p "$out"
open_flags=(--relaunch)
[[ "$release" == true ]] || open_flags+=(--metro-host 127.0.0.1 --metro-port 8081)

# Leaves the simulator light and frees the session, also when a step fails.
trap 'device settings appearance light || true; device close || true' EXIT

device open "$bundle_id" "${open_flags[@]}"
device settings appearance light
device wait "$(tab_label 0) selected=true" 120000
screenshot launch

for i in "${!tabs[@]}"; do
  device press "$(tab_label "$i")"
  device wait "$(tab_label "$i") selected=true" 10000
  screenshot "$(tr '[:upper:]' '[:lower:]' <<<"${tabs[i]}")"
done

device settings appearance dark
device wait 1500
screenshot dark

echo "Screenshots are in $out"
