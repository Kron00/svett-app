#!/usr/bin/env bash
# Builds a branch of svett for the iOS Simulator on rena-devbook and opens it.
#
# Usage: scripts/devbook-build.sh [--release] [--native] <branch> [metro-host[:port]]
#
# Debug (default) builds a development client, starts Metro on this Mac at
# localhost:8081 unless another host is given, and opens the app on that server.
# --release builds the Release configuration with the JS bundle embedded and
# launches it with no development server.
#
# The native build runs only when the Expo fingerprint of the native inputs
# differs from the last successful build of that configuration, and prebuild and
# pod install only when it differs from the generated project. --native forces
# both. SVETT_SIMULATOR picks the simulator (see scripts/sim/simulator.sh).
set -euo pipefail

usage() {
  echo "Usage: $0 [--release] [--native] <branch> [metro-host[:port]]" >&2
  exit 64
}

configuration=Debug
force_native=false
while [[ "${1:-}" == --* ]]; do
  case $1 in
    --release) configuration=Release ;;
    --native) force_native=true ;;
    *) usage ;;
  esac
  shift
done
[[ $# -ge 1 && $# -le 2 ]] || usage

branch=$1
metro=${2:-localhost}
metro_host=${metro%%:*}
metro_port=8081
[[ "$metro" == *:* ]] && metro_port=${metro##*:}

repo_url=https://github.com/Kron00/svett-app.git
checkout=${SVETT_CHECKOUT:-$HOME/svett-app}
bundle_id=com.kron00.svett
# Outside apps/mobile/ios, which `expo prebuild --clean` deletes.
build_dir="$HOME/svett-app-build/$configuration"
derived_data="$build_dir/DerivedData"
fingerprint_file="$build_dir/fingerprint"
# The generated project and Pods are shared by Debug and Release, so they carry
# their own fingerprint. It is written after pod install, and `expo prebuild
# --clean` deletes it with the rest of ios/.
project_stamp=apps/mobile/ios/.svett-fingerprint
app_path="$derived_data/Build/Products/$configuration-iphonesimulator/svett.app"
metro_pid_file="$checkout/.metro.pid"
metro_log="$checkout/metro.log"

step() { printf '\n==> %s\n' "$*"; }

step "Syncing $checkout to origin/$branch"
[[ -d "$checkout/.git" ]] || git clone "$repo_url" "$checkout"
cd "$checkout"
git fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch"
git checkout --force -B "$branch" "origin/$branch"
git log -1 --format='%h %s'

if command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
fi
node_version=$(node --version)
[[ "v$(cat .node-version)" == "$node_version" ]] || {
  echo "Node $(cat .node-version) is required, found $node_version" >&2
  exit 1
}

step "Installing packages"
pnpm install --frozen-lockfile

step "Finding the simulator"
# shellcheck source=scripts/sim/simulator.sh
source scripts/sim/simulator.sh
udid=$(ensure_simulator)
echo "$simulator_name ($udid)"

step "Fingerprinting the native inputs"
fingerprint=$(
  cd apps/mobile
  pnpm exec fingerprint fingerprint:generate --platform ios |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).hash))'
)
last_fingerprint=$(cat "$fingerprint_file" 2>/dev/null || true)
project_fingerprint=$(cat "$project_stamp" 2>/dev/null || true)
echo "Current $fingerprint, last $configuration build ${last_fingerprint:-none}, iOS project ${project_fingerprint:-none}"

# A Release app embeds the JS bundle, so it is rebuilt even when native inputs match.
if [[ "$force_native" == false && "$configuration" == Debug && "$fingerprint" == "$last_fingerprint" && -d "$app_path" ]]; then
  echo "Native build: skipped, the fingerprint matches $app_path"
else
  if [[ "$force_native" == false && "$fingerprint" == "$project_fingerprint" ]]; then
    echo "Native build: xcodebuild only, the iOS project matches the fingerprint"
  else
    echo "Native build: full (prebuild, pod install, xcodebuild)"
    command -v pod >/dev/null || {
      echo "CocoaPods (pod) is not on PATH" >&2
      exit 1
    }
    step "Generating the iOS project"
    rm -f "$project_stamp"
    scripts/ios-prebuild.sh
    (cd apps/mobile/ios && pod install)
    echo "$fingerprint" >"$project_stamp"
  fi

  step "Building $configuration for $simulator_name"
  mkdir -p "$build_dir"
  rm -f "$fingerprint_file"
  xcodebuild build \
    -workspace apps/mobile/ios/svett.xcworkspace \
    -scheme svett \
    -configuration "$configuration" \
    -sdk iphonesimulator \
    -destination "id=$udid" \
    -derivedDataPath "$derived_data" \
    CODE_SIGNING_ALLOWED=NO \
    -quiet
  echo "$fingerprint" >"$fingerprint_file"
fi

step "Installing on $simulator_name"
xcrun simctl bootstatus "$udid" -b
# By path, because Xcode may not be at /Applications/Xcode.app where `open -a` looks.
open "$(xcode-select -p)/Applications/Simulator.app" --args -CurrentDeviceUDID "$udid" ||
  echo "Simulator did not open, so the build continues headless" >&2
xcrun simctl terminate "$udid" "$bundle_id" 2>/dev/null || true
xcrun simctl install "$udid" "$app_path"

if [[ "$configuration" == Release ]]; then
  step "Launching the Release build"
  xcrun simctl launch "$udid" "$bundle_id"
  exit 0
fi

if [[ "$metro_host" == localhost ]]; then
  step "Starting Metro on localhost:$metro_port"
  if [[ -f "$metro_pid_file" ]] && kill -0 "$(cat "$metro_pid_file")" 2>/dev/null; then
    # pnpm does not always pass the signal on, so the Metro listener is stopped too.
    { cat "$metro_pid_file"; lsof -ti "tcp:$metro_port" -sTCP:LISTEN; } | xargs kill 2>/dev/null || true
    for _ in $(seq 1 15); do
      lsof -ti "tcp:$metro_port" -sTCP:LISTEN >/dev/null || break
      sleep 1
    done
  fi
  if lsof -ti "tcp:$metro_port" -sTCP:LISTEN >/dev/null; then
    echo "Port $metro_port is taken by a process this script did not start" >&2
    exit 1
  fi
  nohup pnpm --filter @svett/mobile start --port "$metro_port" </dev/null >"$metro_log" 2>&1 &
  echo $! >"$metro_pid_file"
  disown
fi

metro_url="http://$metro_host:$metro_port"
step "Waiting for Metro at $metro_url"
for _ in $(seq 1 60); do
  curl -fsS "$metro_url/status" 2>/dev/null | grep -q packager-status:running && break
  sleep 2
done
curl -fsS "$metro_url/status" | grep -q packager-status:running || {
  echo "Metro is not answering at $metro_url (log: $metro_log)" >&2
  exit 1
}

step "Opening the app on $metro_url"
# Skips the dev menu's first-run sheet, which would cover the app.
xcrun simctl spawn "$udid" defaults write "$bundle_id" EXDevMenuIsOnboardingFinished -bool YES
encoded_url=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$metro_url")
xcrun simctl openurl "$udid" "svett://expo-development-client/?url=$encoded_url"
echo "Metro log: $metro_log"
