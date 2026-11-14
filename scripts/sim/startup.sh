#!/usr/bin/env bash
# Times svett's cold start on rena-devbook's simulator. Run it after
# devbook-build.sh --release, with --release.
#
# Usage: scripts/sim/startup.sh [--release] [out-dir]
#
# At the largest text size it relaunches svett 5 times on the 300-workout
# fixture with -svettTiming 1, opens the Train tab through svett://train each
# time, and reads the cold start svett measured itself from the Train tab:
# svett's own time, which the plan's 2 second target judges, and the time of
# each step since the launch's origin. The origin is the process start, or
# main() when iOS prewarmed the launch. It prints every step of every launch,
# then the median of each over the launches that recorded it. The plan's
# target is judged on a Release build only. SVETT_LAUNCHES sets the number of
# launches.
#
# It reads the text of a build from main before this script too, whose steps
# are fewer and timed from the process start, so the same script times svett
# before and after a change.
#
# It generates the fixture into out-dir with pnpm fixture and copies it into
# the app's data container, as routines.sh does. SVETT_FIXTURE, the absolute
# path of a fixture database already in the data container, skips that and
# uses it instead. Each launch's text goes to launch-<n>.txt, its screenshot to
# <nn>-launch-<n>.png, and the report to startup.txt, in out-dir, by default
# ~/svett-proof/<branch>/startup/. Like tabs.sh, Debug opens the development
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
out=${1:-$HOME/svett-proof/$(git branch --show-current)/startup}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
train_tab='label="Train, tab, 2 of 5"'
launches=${SVETT_LAUNCHES:-5}
[[ "$launches" =~ ^[1-9][0-9]*$ ]] || {
  echo "SVETT_LAUNCHES must be a whole number above 0, got \"$launches\"" >&2
  exit 64
}

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
fixture=${SVETT_FIXTURE:-}
if [[ -z "$fixture" ]]; then
  pnpm fixture --out "$out/svett-fixture.db"
  data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
  fixture="$data/Documents/svett-fixture.db"
  mkdir -p "$data/Documents"
  # A journal left by an earlier run would be replayed onto the fresh copy.
  rm -f "$fixture-wal" "$fixture-shm"
  cp "$out/svett-fixture.db" "$fixture"
  echo "Copied the fixture to $fixture"
fi
open_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")
open_flags+=(--launch-args=-svettFixture "--launch-args=$fixture" --launch-args=-svettTiming --launch-args=1)

# Leaves the simulator at the default text size, also when a step fails, and
# frees its own session.
restore() {
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

fail() {
  echo "$1" >&2
  exit 1
}

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
for ((n = 1; n <= launches; n++)); do
  agent_device open "$bundle_id" "${open_flags[@]}"
  agent_device wait "$train_tab" 120000 >/dev/null || fail "Launch $n: svett did not show its tabs"
  agent_device open "$bundle_id" "svett://train"
  agent_device wait 'id="routine-list"' 10000 >/dev/null || fail "Launch $n: the Train tab did not list the routines"
  # The time sits below the routines, off screen at the largest text size.
  agent_device is visible 'id="cold-start-timing"' >/dev/null 2>&1 ||
    agent_device scroll down --until 'id="cold-start-timing"' >/dev/null 2>&1 ||
    fail "Launch $n: the Train tab did not show svett's own cold start time"
  agent_device get attrs 'id="cold-start-timing"' |
    node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).label ?? "")' \
      >"$out/launch-$n.txt"
  agent_device screenshot "$(printf '%s/%02d-launch-%d.png' "$out" "$n" "$n")"
done

build=$([[ "$release" == true ]] && echo Release || echo "Debug, loaded from Metro, which the 2 second target does not judge")
# shellcheck disable=SC2016 # The ${...} are JavaScript template literals.
node -e '
  const fs = require("fs");
  const [out, count, build] = process.argv.slice(1);
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  const launches = [];
  for (let n = 1; n <= Number(count); n++) {
    const text = fs.readFileSync(`${out}/launch-${n}.txt`, "utf8");
    const own = /^svett.s own cold start: (-?\d+) ms\./.exec(text);
    const listed = /Steps since ([^:]+): (.*) ms\.$/.exec(text);
    if (own === null || listed === null) {
      console.error(`Launch ${n}: the Train tab shows "${text}", which is not svett\x27s own cold start time`);
      process.exit(1);
    }
    const steps = listed[2].split(", ").map((entry) => {
      const step = /^(.+) (-?\d+)$/.exec(entry);
      if (step === null) {
        console.error(`Launch ${n}: the step "${entry}" has no time`);
        process.exit(1);
      }
      return { name: step[1], ms: Number(step[2]) };
    });
    launches.push({ own: Number(own[1]), origin: listed[1], steps });
  }
  const origins = [...new Set(launches.map(({ origin }) => origin))];
  const names = [];
  for (const { steps } of launches) for (const { name } of steps) if (!names.includes(name)) names.push(name);
  const medians = names.map((name) => {
    const values = launches.flatMap(({ steps }) => steps.filter((s) => s.name === name).map((s) => s.ms));
    const share = values.length === launches.length ? "" : ` (${values.length} of ${launches.length} launches)`;
    return { name, ms: median(values), share };
  }).sort((a, b) => a.ms - b.ms);
  const lines = [
    `${launches.length} cold launches of a ${build} build, on the 300-workout fixture at the largest text size.`,
    ...launches.map(({ own, origin, steps }, i) =>
      `Launch ${i + 1}: svett\x27s own cold start ${own} ms, steps since ${origin}: ` +
      `${steps.map(({ name, ms }) => `${name} ${ms}`).join(", ")} ms.`),
    `Median: svett\x27s own cold start ${median(launches.map(({ own }) => own))} ms, which the plan\x27s 2 second target judges.`,
    `Median of each step since ${origins.length === 1 ? origins[0] : "each launch\x27s own origin"}: ${medians.map(({ name, ms, share }) => `${name} ${ms}${share}`).join(", ")} ms.`,
  ];
  fs.writeFileSync(`${out}/startup.txt`, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
' "$out" "$launches" "$build"
