#!/usr/bin/env bash
# Runs scripts/devbook-build.sh and the sim/ scripts on Linux against fake
# Xcode, CocoaPods, pnpm, Expo and agent-device tools. It checks which native
# build steps run, which native inputs the installed app was built from, that
# Xcode signs it locally and codesign never runs, which simulator it lands on, where fnm and CocoaPods are found, and that the T3 Code
# bound device command replaces simctl launch and openurl.
#
# Usage: scripts/test/devbook-build.test.sh
set -euo pipefail
# Git exports these to commands it runs, such as `git rebase -x`. Left set, the
# test's git calls would act on the repo under test instead of its temp repos.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

repo=$(cd "$(dirname "$0")/../.." && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

fake="$root/bin"
pod_bin="$root/pod-bin"
mkdir -p "$fake" "$pod_bin" "$root/home"

# Each branch's native inputs are the contents of apps/mobile/native-inputs, which
# the fake fingerprint returns as the hash.
cat >"$fake/pnpm" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "install --frozen-lockfile") ;;
  "exec fingerprint") printf '{"hash":"%s"}' "$(cat native-inputs)" ;;
  "fixture --out")
    if [[ -n "${FAKE_FIXTURE_DB:-}" ]]; then cp "$FAKE_FIXTURE_DB" "$3"; else printf '%s\n' "fake fixture" "${@:4}" >"$3"; fi ;;
  "exec expo")
    rm -rf ios
    mkdir -p ios
    cp native-inputs ios/generated-from
    ;;
  *) echo "fake pnpm: unexpected $*" >&2; exit 1 ;;
esac
EOF

cat >"$pod_bin/pod" <<'EOF'
#!/usr/bin/env bash
[[ -z "${FAKE_POD_FAIL:-}" ]] || { echo "fake pod install failed" >&2; exit 1; }
mkdir -p Pods
cp generated-from Pods/
EOF

cat >"$fake/xcodebuild" <<'EOF'
#!/usr/bin/env bash
settings=()
while [[ $# -gt 0 ]]; do
  case $1 in
    -configuration) configuration=$2; shift ;;
    -derivedDataPath) derived_data=$2; shift ;;
    *=*) settings+=("$1") ;;
  esac
  shift
done
[[ -z "${FAKE_XCODEBUILD_FAIL:-}" ]] || { echo "fake xcodebuild failed" >&2; exit 65; }
[[ "$(cat apps/mobile/ios/generated-from)" == "$(cat apps/mobile/ios/Pods/generated-from)" ]] || {
  echo "fake xcodebuild: Pods do not match the project" >&2
  exit 65
}
app="$derived_data/Build/Products/$configuration-iphonesimulator/svett.app"
mkdir -p "$app"
cp apps/mobile/ios/generated-from "$app/built-from"
printf '%s\n' "${settings[@]}" >"$app/build-settings"
EOF

cat >"$fake/codesign" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/codesign-calls"
EOF

cat >"$fake/xcrun" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/simctl-calls"
case "\$2" in
  list) printf -- '%s\n' \
    '-- iOS 27.0 --' '    iPhone 16 Pro Max (STOCK-UDID) (Shutdown)' \
    '-- iOS 26.0 --' '    svett iPhone 16 Pro Max (OLD-UDID) (Shutdown)' \
    '-- iOS 27.2 --' '    svett iPhone 16 Pro Max (FAKE-UDID) (Booted)' ;;
  install)
    cat "\$4/built-from" >"$root/installed"
    cat "\$4/build-settings" >"$root/installed-settings" ;;
  get_app_container) echo "$root/data container" ;;
esac
EOF

cat >"$fake/xcode-select" <<'EOF'
#!/usr/bin/env bash
echo /Applications/Xcode-27.2.0.app/Contents/Developer
EOF

cat >"$fake/open" <<EOF
#!/usr/bin/env bash
echo "\$*" >"$root/open-args"
exit 1
EOF

# Stands in for the command that T3 Code's device_open returns. The gallery's end
# marker counts as on screen after FAKE_GALLERY_SCROLLS drags since the last open.
# Each element fills a 440 by 956 point screen. A drag moves the gallery only when
# it starts in the left gutter, and with FAKE_GALLERY_STALL only that many times,
# and a screenshot shows how far it moved.
cat >"$fake/bound-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
moved() {
  awk -v stall="\${FAKE_GALLERY_STALL:-1000}" '
    / open / { n = 0 }
    / gesture pan 8 765 0 -574 400$/ && n < stall { n++ }
    END { print n + 0 }' "$root/bound-calls"
}
args=" \$* "
case "\$args" in
  *" is visible "*) (("\$(moved)" >= \${FAKE_GALLERY_SCROLLS:-0})) ;;
  *" get attrs "*) echo '{"rect": {"x": 0, "y": 0, "width": 440, "height": 956}}' ;;
  *" screenshot "*) echo "gallery moved \$(moved) times" >"\${@: -1}" ;;
esac
EOF

printf '#!/usr/bin/env bash\n' >"$fake/fnm"
# Stand-ins for fnm and CocoaPods in their install folders, outside PATH.
fnm_home="$root/home/.local/share/fnm"
mise_ruby="$root/home/.local/share/mise/installs/ruby"
mkdir -p "$fnm_home" "$mise_ruby/3.3.6/bin" "$mise_ruby/3.10.0/bin"
printf '#!/usr/bin/env bash\necho "$*" >>"%s"\n' "$root/home-fnm-calls" >"$fnm_home/fnm"
chmod +x "$fnm_home/fnm"
printf '#!/usr/bin/env bash\necho packager-status:running\n' >"$fake/curl"
chmod +x "$fake"/* "$pod_bin"/*

git_() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"; }

work="$root/work"
mkdir -p "$work/apps/mobile" "$work/scripts/sim"
cp "$repo/scripts/ios-prebuild.sh" "$work/scripts/"
cp "$repo/scripts/sim/simulator.sh" "$work/scripts/sim/"
node --version | sed 's/^v//' >"$work/.node-version"
echo native-main >"$work/apps/mobile/native-inputs"
echo apps/mobile/ios/ >"$work/.gitignore"
git_ -C "$work" init -q -b main
git_ -C "$work" add -A
git_ -C "$work" commit -q -m main
for branch in a b; do
  git_ -C "$work" checkout -q -b "$branch" main
  echo "native-$branch" >"$work/apps/mobile/native-inputs"
  git_ -C "$work" add -A
  git_ -C "$work" commit -q -m "$branch"
done
git_ clone -q --bare "$work" "$root/origin.git"
git_ clone -q "$root/origin.git" "$root/checkout"

passed=0
output="$root/output"

# run_build [VAR=value...] [devbook-build.sh args...]
run_build() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  env HOME="$root/home" SVETT_CHECKOUT="$root/checkout" PATH="$fake:$pod_bin:$PATH" "${vars[@]}" \
    "$repo/scripts/devbook-build.sh" "$@" >"$output" 2>&1
}

# build <expected native build line> <expected installed inputs> [devbook-build.sh args...]
build() {
  local expected_line=$1 expected_inputs=$2 installed
  shift 2
  rm -f "$root/installed" "$root/installed-settings" "$root/codesign-calls"
  run_build "$@" || fail "devbook-build.sh $* failed"
  grep -qxF "Native build: $expected_line" "$output" ||
    fail "devbook-build.sh $* did not print \"Native build: $expected_line\""
  installed=$(cat "$root/installed" 2>/dev/null || true)
  [[ "$installed" == "$expected_inputs" ]] ||
    fail "devbook-build.sh $* installed an app built from \"$installed\", not \"$expected_inputs\""
  for setting in CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES DEVELOPMENT_TEAM=; do
    grep -qxF -- "$setting" "$root/installed-settings" ||
      fail "devbook-build.sh $* installed an app Xcode built without $setting"
  done
  [[ ! -e "$root/codesign-calls" ]] || fail "devbook-build.sh $* ran codesign: $(cat "$root/codesign-calls")"
}

# build_fails <expected message> [VAR=value...] [devbook-build.sh args...]
build_fails() {
  local message=$1
  shift
  ! run_build "$@" || fail "devbook-build.sh $* succeeded"
  grep -qF "$message" "$output" || fail "devbook-build.sh $* did not print \"$message\""
}

fail() {
  echo "not ok - $case_name: $1" >&2
  sed 's/^/    /' "$output" >&2
  exit 1
}

check() {
  case_name=$1
  shift
  "$@" || fail "$* failed"
  passed=$((passed + 1))
  echo "ok $passed - $case_name"
}

metro="SVETT_METRO=metro.invalid:8081"
skipped="skipped, the fingerprint matches $root/home/svett-app-build/Debug/DerivedData/Build/Products/Debug-iphonesimulator/svett.app"
xcodebuild_only="xcodebuild only, the iOS project matches the fingerprint"
full="full (prebuild, pod install, xcodebuild)"

check "first Release build runs the full native build" build "$full" native-a --release a
check "unchanged Release rebuild reuses the iOS project" build "$xcodebuild_only" native-a --release a
check "Debug after Release with the same inputs reuses the iOS project" build "$xcodebuild_only" native-a "$metro" a
check "unchanged Debug rebuild skips the native build" build "$skipped" native-a "$metro" a
check "switching to a branch with other native inputs regenerates the iOS project" build "$full" native-b "$metro" b
check "Release after a Debug build of other inputs regenerates the iOS project" build "$full" native-a --release a
check "Debug after a Release build of other inputs reuses its own app" build "$skipped" native-b "$metro" b

# An app left by an earlier script that built it unsigned and recorded only the fingerprint.
debug_build="$root/home/svett-app-build/Debug"
echo native-b >"$debug_build/fingerprint"
echo CODE_SIGNING_ALLOWED=NO >"$debug_build/DerivedData/Build/Products/Debug-iphonesimulator/svett.app/build-settings"
check "an unsigned Debug app with a matching fingerprint is rebuilt with Xcode local signing, not reused" \
  build "$full" native-b "$metro" b

git_ -C "$work" checkout -q a
echo native-a2 >"$work/apps/mobile/native-inputs"
git_ -C "$work" commit -q -am "change a's native inputs"
git_ -C "$work" push -q "$root/origin.git" a
check "changed native inputs regenerate the iOS project" build "$full" native-a2 "$metro" a

check "interrupted xcodebuild fails" build_fails "fake xcodebuild failed" FAKE_XCODEBUILD_FAIL=1 "$metro" --native a
check "Debug after an interrupted xcodebuild rebuilds the app on the same iOS project" build "$xcodebuild_only" native-a2 "$metro" a

check "interrupted pod install fails" build_fails "fake pod install failed" FAKE_POD_FAIL=1 --release b
check "Release after an interrupted pod install regenerates the iOS project" build "$full" native-b --release b

check "--native forces the full native build" build "$full" native-b --release --native b

check "Simulator opens from the selected Xcode" grep -qxF \
  "/Applications/Xcode-27.2.0.app/Contents/Developer/Applications/Simulator.app --args -CurrentDeviceUDID FAKE-UDID" "$root/open-args"
check "a failed Simulator open continues headless" grep -qxF "Simulator did not open, so the build continues headless" "$output"

case_name="no pod outside the fakes"
! PATH="$fake:$PATH" command -v pod >/dev/null || fail "pod is on PATH"
check "a full build without CocoaPods stops early" build_fails "CocoaPods (pod) is not on PATH" PATH="$fake:$PATH" --release a

cp "$pod_bin/pod" "$mise_ruby/3.10.0/bin/pod"
printf '#!/usr/bin/env bash\necho "pod from the older Ruby ran" >&2\nexit 1\n' >"$mise_ruby/3.3.6/bin/pod"
chmod +x "$mise_ruby"/*/bin/pod
check "CocoaPods off PATH is found in the newest mise Ruby" build "$full" native-a2 PATH="$fake:$PATH" --release --native a

# PATH without fnm, so only the copy in fnm's install folder can be found.
bare="$root/bare-bin"
mkdir -p "$bare"
for tool in "$fake"/*; do
  [[ "${tool##*/}" == fnm ]] || ln -s "$tool" "$bare/"
done
ln -s "$(command -v node)" "$bare/node"
case_name="fnm off PATH"
rm -f "$root/home-fnm-calls"
run_build PATH="$bare:$pod_bin:/usr/bin:/bin" --release a || fail "devbook-build.sh failed without fnm on PATH"
check "fnm off PATH is found in its install folder" grep -qxF "use --install-if-missing" "$root/home-fnm-calls"

check "a Metro address after the branch is refused" build_fails "Usage:" b metro.invalid:8081

bound_cmd="bound-device --session 't3-test session' --device FAKE-UDID"
bound_prefix="--session t3-test session --device FAKE-UDID"
dev_client_url="svett://expo-development-client/?url=http%3A%2F%2Fmetro.invalid%3A8081"

# routed [VAR=value...] [devbook-build.sh args...]
routed() {
  rm -f "$root/simctl-calls" "$root/bound-calls"
  run_build "$@" || fail "devbook-build.sh $* failed"
}

no_simctl_launch_or_openurl() {
  if grep -E '^simctl (launch|openurl)' "$root/simctl-calls" >>"$output"; then
    fail "simctl launch or openurl ran although SVETT_DEVICE_CMD was set"
  fi
}

bound_got() {
  grep -qxF -- "$1" "$root/bound-calls" 2>/dev/null || {
    { echo "bound command calls:"; cat "$root/bound-calls" 2>/dev/null; } >>"$output"
    fail "the bound command did not receive \"$1\""
  }
}

simctl_got() {
  grep -qxF -- "$1" "$root/simctl-calls" || fail "simctl did not receive \"$1\""
}

# only_simctl <call>... checks the simctl calls were exactly these, in order.
only_simctl() {
  local expected
  expected=$(printf '%s\n' "$@")
  [[ "$(cat "$root/simctl-calls" 2>/dev/null)" == "$expected" ]] || {
    { echo "simctl calls:"; cat "$root/simctl-calls" 2>/dev/null; } >>"$output"
    fail "simctl did not get exactly these calls: $expected"
  }
}

release_app="$root/home/svett-app-build/Release/DerivedData/Build/Products/Release-iphonesimulator/svett.app"

# only_svett_ios27 checks no simctl call touched the stock or the iOS 26 simulator.
only_svett_ios27() {
  if grep -E 'STOCK-UDID|OLD-UDID' "$root/simctl-calls" >>"$output"; then
    fail "simctl targeted a simulator other than the iOS 27 svett iPhone 16 Pro Max"
  fi
}

case_name="Release without SVETT_DEVICE_CMD"
routed --release b
check "Release without SVETT_DEVICE_CMD launches with simctl" simctl_got "simctl launch FAKE-UDID com.kron00.svett"
check "the iOS 27 svett simulator gets the install, not the stock or iOS 26 one" \
  simctl_got "simctl install FAKE-UDID $release_app"
check "no simctl call targets the stock or iOS 26 simulator" only_svett_ios27

case_name="Release with SVETT_DEVICE_CMD"
routed SVETT_DEVICE_CMD="$bound_cmd" --release b
check "Release with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl
check "Release with SVETT_DEVICE_CMD relaunches through the bound command" \
  bound_got "$bound_prefix open com.kron00.svett --relaunch"
check "Release with SVETT_DEVICE_CMD still installs with simctl" simctl_got "simctl install FAKE-UDID $release_app"

case_name="Debug without SVETT_DEVICE_CMD"
routed "$metro" b
check "Debug without SVETT_DEVICE_CMD opens the dev client with simctl openurl" \
  simctl_got "simctl openurl FAKE-UDID $dev_client_url"

case_name="Debug with SVETT_DEVICE_CMD"
routed SVETT_DEVICE_CMD="$bound_cmd" "$metro" b
check "Debug with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl
check "Debug with SVETT_DEVICE_CMD opens the dev client URL through the bound command" \
  bound_got "$bound_prefix open com.kron00.svett --relaunch --launch-url $dev_client_url"

local_dev_client_url="svett://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"

# sim_script <script> [args...] runs a sim/ script through the bound command.
sim_script() {
  rm -f "$root/simctl-calls" "$root/bound-calls"
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="$bound_cmd" "$repo/scripts/sim/$1" "${@:2}" >"$output" 2>&1 ||
    fail "$1 ${*:2} failed"
}

# only_open <expected open arguments>... checks the script opened the app once
# per argument, in order, with exactly those arguments.
only_open() {
  local opens expected
  opens=$(grep -F -- "$bound_prefix open " "$root/bound-calls" || true)
  expected=$(printf '%s\n' "${@/#/$bound_prefix open }")
  [[ "$opens" == "$expected" ]] || {
    { echo "bound command opens:"; echo "$opens"; } >>"$output"
    fail "the bound command did not get exactly these opens: $expected"
  }
}

case_name="tabs.sh Debug with SVETT_DEVICE_CMD"
sim_script tabs.sh "$root/proof-debug"
check "tabs.sh Debug relaunches into the dev client on Metro, not a bare relaunch" \
  only_open "com.kron00.svett --relaunch --launch-url $local_dev_client_url"
check "tabs.sh with SVETT_DEVICE_CMD never calls simctl" test ! -e "$root/simctl-calls"

case_name="tabs.sh Release with SVETT_DEVICE_CMD"
sim_script tabs.sh --release "$root/proof-release"
check "tabs.sh Release relaunches the installed app without Metro" only_open "com.kron00.svett --relaunch"

case_name="launch.sh Debug with SVETT_DEVICE_CMD"
sim_script launch.sh -svettFixture "$root/fixture one.json"
check "launch.sh Debug relaunches into the dev client with the launch arguments" only_open \
  "com.kron00.svett --relaunch --launch-url $local_dev_client_url --launch-args=-svettFixture --launch-args=$root/fixture one.json"

case_name="tabs.sh and launch.sh with SVETT_METRO"
SVETT_METRO=metro.invalid:8081 sim_script tabs.sh "$root/proof-metro"
check "tabs.sh Debug opens the dev client on SVETT_METRO" \
  only_open "com.kron00.svett --relaunch --launch-url $dev_client_url"
SVETT_METRO=metro.invalid:8081 sim_script launch.sh
check "launch.sh Debug opens the dev client on SVETT_METRO" \
  only_open "com.kron00.svett --relaunch --launch-url $dev_client_url"

case_name="tabs.sh and launch.sh with a SVETT_METRO host and no port"
SVETT_METRO=metro.invalid sim_script tabs.sh "$root/proof-metro-host"
check "tabs.sh Debug opens the dev client on port 8081 of a SVETT_METRO host" \
  only_open "com.kron00.svett --relaunch --launch-url $dev_client_url"
SVETT_METRO=metro.invalid sim_script launch.sh
check "launch.sh Debug opens the dev client on port 8081 of a SVETT_METRO host" \
  only_open "com.kron00.svett --relaunch --launch-url $dev_client_url"

case_name="launch.sh with SVETT_DEVICE_CMD"
rm -f "$root/simctl-calls" "$root/bound-calls"
env PATH="$fake:$PATH" SVETT_DEVICE_CMD="$bound_cmd" \
  "$repo/scripts/sim/launch.sh" --release -svettFixture "$root/fixture one.json" >"$output" 2>&1 ||
  fail "launch.sh failed"
check "launch.sh passes launch arguments through the bound command" bound_got \
  "$bound_prefix open com.kron00.svett --relaunch --launch-args=-svettFixture --launch-args=$root/fixture one.json"
check "launch.sh with SVETT_DEVICE_CMD never calls simctl" test ! -e "$root/simctl-calls"

container_fixture="$root/data container/Documents/svett-fixture.db"

case_name="fixture.sh Debug with SVETT_DEVICE_CMD"
sim_script fixture.sh "$root/proof fixture"
check "fixture.sh copies the generated fixture into the app's data container" \
  grep -qxF "fake fixture" "$container_fixture"
check "fixture.sh launches plainly, then with -svettFixture on the copied file, through the bound command" only_open \
  "com.kron00.svett --relaunch --launch-url $local_dev_client_url" \
  "com.kron00.svett --relaunch --launch-url $local_dev_client_url --launch-args=-svettFixture --launch-args=$container_fixture"
check "fixture.sh screenshots the fixture's counts" bound_got "$bound_prefix screenshot $root/proof fixture/02-fixture.png"
check "fixture.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

# only_calls <pattern> <expected call>... checks the bound command calls that
# start with the extended regex are exactly these, in order, without the prefix.
only_calls() {
  local pattern=$1 calls expected
  shift
  calls=$(grep -E -- "^$bound_prefix ($pattern)" "$root/bound-calls" | sed "s/^$bound_prefix //" || true)
  expected=$(printf '%s\n' "$@")
  [[ "$calls" == "$expected" ]] || {
    { echo "bound command calls matching $pattern:"; echo "$calls"; } >>"$output"
    fail "the bound command did not get exactly these calls: $expected"
  }
}

debug_open="com.kron00.svett --relaunch --launch-url $local_dev_client_url"
debug_front="com.kron00.svett --launch-url $local_dev_client_url"

case_name="gallery.sh Debug with SVETT_DEVICE_CMD"
FAKE_GALLERY_SCROLLS=2 sim_script gallery.sh "$root/gallery"
gallery_links=("com.kron00.svett svett://gallery" "com.kron00.svett svett://gallery?sheet=open")
check "gallery.sh relaunches into the dev client on Metro once per pass, then opens the gallery links" \
  only_open "$debug_open" "${gallery_links[@]}" "$debug_open" "${gallery_links[@]}"
check "gallery.sh sets each pass's text size before relaunching, then restores it" \
  only_calls "settings|open" \
  "settings text-size large" "open $debug_open" \
  "open ${gallery_links[0]}" "open ${gallery_links[1]}" \
  "settings text-size accessibility-extra-extra-extra-large" "open $debug_open" \
  "open ${gallery_links[0]}" "open ${gallery_links[1]}" \
  "settings text-size large"
check "gallery.sh never sets the appearance, since the app is dark only" only_calls "settings appearance"
check "gallery.sh pages each pass down to the end marker, then shoots the sheet" \
  only_calls "screenshot" \
  "screenshot $root/gallery/dark-01.png" "screenshot $root/gallery/dark-02.png" \
  "screenshot $root/gallery/dark-03.png" "screenshot $root/gallery/dark-sheet.png" \
  "screenshot $root/gallery/largest-text-01.png" "screenshot $root/gallery/largest-text-02.png" \
  "screenshot $root/gallery/largest-text-03.png" "screenshot $root/gallery/largest-text-sheet.png"
check "gallery.sh presses nothing in screen content, which agent-device refuses as covered on iOS 27" \
  only_calls "press"
check "gallery.sh with SVETT_DEVICE_CMD never calls simctl" test ! -e "$root/simctl-calls"

case_name="gallery.sh Release with SVETT_DEVICE_CMD"
sim_script gallery.sh --release "$root/gallery-release"
check "gallery.sh Release relaunches the installed app without Metro" \
  only_open "com.kron00.svett --relaunch" "${gallery_links[@]}" "com.kron00.svett --relaunch" "${gallery_links[@]}"

case_name="gallery.sh without an end marker"
rm -f "$root/bound-calls"
! env PATH="$fake:$PATH" SVETT_DEVICE_CMD="$bound_cmd" FAKE_GALLERY_SCROLLS=1000 \
  "$repo/scripts/sim/gallery.sh" "$root/gallery-endless" >"$output" 2>&1 || fail "gallery.sh succeeded"
check "gallery.sh stops after 40 pages when the end marker never shows" \
  grep -qF "The gallery's end marker was not on screen after 40 pages" "$output"
check "gallery.sh restores the default text size after a failure" \
  only_calls "settings" "settings text-size large" "settings text-size large"

case_name="gallery.sh when the gallery stops moving"
rm -f "$root/bound-calls"
! env PATH="$fake:$PATH" SVETT_DEVICE_CMD="$bound_cmd" FAKE_GALLERY_SCROLLS=1000 FAKE_GALLERY_STALL=4 \
  "$repo/scripts/sim/gallery.sh" "$root/gallery-stalled" >"$output" 2>&1 || fail "gallery.sh succeeded"
check "gallery.sh stops at the first page that matches the one before it" \
  grep -qxF "dark-06.png matches dark-05.png, so the drag at 8,765 did not move the gallery" "$output"
check "gallery.sh shoots no page after the stalled one" \
  only_calls "screenshot" "$(printf "screenshot $root/gallery-stalled/dark-%02d.png\n" 1 2 3 4 5 6)"
check "gallery.sh drags in the gallery's left gutter, not down the middle where a control can keep the touch" \
  only_calls "scroll|gesture" "$(printf 'gesture pan 8 765 0 -574 400\n%.0s' 1 2 3 4 5)"

# Stands in for the bound command on Phone checks. It tracks what is in front:
# the Home Screen, or svett on its tab root, the You tab or Phone checks. Like the
# iOS 27 simulator, a Debug open by bundle id alone leaves the Home Screen in
# front. A Release open by bundle id, or a Debug open of the dev client URL,
# brings svett back on the screen it left, or on its tab root with FAKE_RELOAD,
# or not at all with FAKE_STAYS_HOME. A scroll or press while the Home Screen is
# in front fails and is logged. Every element has the same frame, the clipboard
# holds a report whose notification check reads FAKE_NOTIFICATION, by default
# PASSED, no permission prompt shows, and the Apple Health sheet shows
# only with FAKE_HEALTH_SHEET. FAKE_NO_GRANT refuses a permission grant ahead.
# With FAKE_CHATGPT_SHEET the ChatGPT sign-in sheet covers Phone checks, refuses
# alert dismiss and closes on a Cancel press.
cat >"$fake/checks-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
screen=\$(cat "$root/screen" 2>/dev/null || echo home)
left=\$(cat "$root/svett-screen" 2>/dev/null || echo tabs)
show() {
  echo "\$1" >"$root/screen"
  [[ "\$1" == home ]] || echo "\$1" >"$root/svett-screen"
}
refuse_on_home() {
  [[ "\$screen" == home ]] || return 0
  echo "\$*" >>"$root/home-screen-actions"
  echo "fake device: \$* while the Home Screen is in front" >&2
  exit 1
}
in_svett() { [[ "\$screen" != home ]]; }
args=" \$* "
case "\$args" in
  *" home "* | *" open com.apple.springboard "*) show home ;;
  *" open com.kron00.svett --relaunch "*) show tabs ;;
  *" open com.kron00.svett "*)
    if [[ -n "\${FAKE_STAYS_HOME:-}" ]] || [[ -z "\${FAKE_RELEASE:-}" && "\$args" != *" --launch-url "* ]]; then
      :
    elif [[ -n "\${FAKE_RELOAD:-}" ]]; then
      show tabs
    else
      show "\$left"
    fi ;;
  *" scroll "*) refuse_on_home scroll ;;
  *' press label="You, tab, 5 of 5" '*) refuse_on_home press You tab; show you ;;
  *" press "*)
    refuse_on_home press
    attrs=\$(cat "$root/last-attrs")
    [[ "\$screen" != you || "\$attrs" != *phone-checks-row* ]] || show checks
    [[ -z "\${FAKE_CHATGPT_SHEET:-}" || "\$attrs" != *check-run-chatgpt* ]] || show sheet
    [[ "\$screen" != sheet || "\$attrs" != *Cancel* ]] || show checks ;;
  *" alert dismiss "*) [[ -z "\${FAKE_CHATGPT_SHEET:-}" ]] ;;
  *" settings permission grant "*) [[ -z "\${FAKE_NO_GRANT:-}" ]] ;;
  *" get attrs "*)
    echo "\$*" >"$root/last-attrs"
    echo '{"label": "Run", "rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *' label="You, tab, 5 of 5" '*) in_svett ;;
  *' id="phone-checks-row" '*) [[ "\$screen" == you ]] ;;
  *' label="Turn On All" '*) [[ -n "\${FAKE_HEALTH_SHEET:-}" ]] ;;
  *" is visible "* | *' wait id='*) [[ "\$screen" == checks ]] ;;
  *" clipboard read "*)
    echo "fake phone check report"
    echo "Keychain after restart: PASSED. Read back."
    echo "Notification in the background: \${FAKE_NOTIFICATION:-PASSED}. Arrived."
    echo "GPS with the screen locked: PASSED. 70 points." ;;
  *" alert wait "*) exit 1 ;;
esac
EOF
chmod +x "$fake/checks-device"

# run_checks [VAR=value...] [checks.sh args...] leaves the exit status in checks_status.
run_checks() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -f "$root/simctl-calls" "$root/bound-calls" "$root/screen" "$root/svett-screen" "$root/home-screen-actions"
  checks_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="checks-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/checks.sh" "$@" >"$output" 2>&1 || checks_status=$?
}

# checks_sh [VAR=value...] [checks.sh args...]
checks_sh() {
  run_checks "$@"
  [[ "$checks_status" == 0 ]] || fail "checks.sh $* failed"
}

never_acts_on_home_screen() {
  [[ ! -e "$root/home-screen-actions" ]] ||
    fail "checks.sh acted on the Home Screen: $(tr '\n' ';' <"$root/home-screen-actions")"
}

# leaves_after_notification_run checks svett goes to the Home Screen in the call
# right after the last press on the notification check's Run, which is due 10
# seconds later.
leaves_after_notification_run() {
  local after
  after=$(sed "s/^$bound_prefix //" "$root/bound-calls" |
    grep -A2 -xF 'get attrs id="check-run-notification"' | tail -1)
  [[ "$after" == home ]] || fail "after Run on the notification check came \"$after\", not home"
}

you_tab_press='press label="You, tab, 5 of 5"'
centre_press="press 80 320"

case_name="checks.sh Debug with SVETT_DEVICE_CMD"
checks_sh "$root/checks"
check "checks.sh never scrolls or presses while the Home Screen is in front" never_acts_on_home_screen
check "checks.sh relaunches into the dev client, reopens it without a relaunch after each step that leaves svett, and relaunches for the report" \
  only_open "$debug_open" "$debug_open" com.apple.springboard "$debug_front" "$debug_front" "$debug_front" "$debug_open"
check "checks.sh presses tabs by selector and screen content only at an element's centre, which agent-device does not refuse on iOS 27" \
  only_calls "press" \
  "$you_tab_press" "$centre_press" "$centre_press" "$you_tab_press" "$centre_press" "$centre_press" \
  "$centre_press" "$centre_press" "$centre_press" "$you_tab_press" "$centre_press" "$centre_press"
check "checks.sh opens Phone checks, resets, runs each check and copies the report, in that order" \
  only_calls "get attrs" \
  'get attrs id="phone-checks-row"' 'get attrs id="reset-checks"' 'get attrs id="phone-checks-row"' \
  'get attrs id="check-run-notification"' 'get attrs id="check-run-health"' \
  'get attrs id="check-run-location"' 'get attrs id="check-run-chatgpt"' \
  'get attrs id="phone-checks-row"' 'get attrs id="copy-report"'
check "checks.sh grants notifications ahead, so no prompt holds svett in front after Run" \
  bound_got "$bound_prefix settings permission grant notifications"
check "checks.sh leaves svett straight after pressing Run on the notification check" \
  leaves_after_notification_run
check "checks.sh waits for the banner on the Home Screen, then keeps svett away for over a minute for GPS" \
  only_calls "home|wait text|wait [0-9]{5,}" \
  "home" "wait text The background notification check worked. 20000" "home" "wait 70000"
check "checks.sh moves the simulator along a route for the GPS check" grep -qE \
  '^simctl location FAKE-UDID start --speed=3 --interval=1( -?[0-9.]+,-?[0-9.]+){2,}$' "$root/simctl-calls"
check "checks.sh clears the simulated route when it ends" simctl_got "simctl location FAKE-UDID clear"
check "checks.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size|settings appearance" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "checks.sh cancels the ChatGPT sign-in sheet" bound_got "$bound_prefix alert dismiss"
check "checks.sh saves the copied report" grep -qxF "fake phone check report" "$root/checks/report.txt"
check "checks.sh says in the report that GPS ran on the Home Screen, since the simulator cannot lock" \
  grep -qF "Simulator: it cannot lock its screen, so GPS ran with svett on the Home Screen." "$root/checks/report.txt"
check "checks.sh says in a Debug report that a development client reload forgets when svett was away" \
  grep -qF "Debug: when svett comes back on its tab root" "$root/checks/report.txt"
check "checks.sh screenshots each check, the banner and the sign-in sheet" \
  only_calls "screenshot" \
  "screenshot $root/checks/01-reset.png" "screenshot $root/checks/02-keychain.png" \
  "screenshot $root/checks/03-notification-banner.png" "screenshot $root/checks/04-notification.png" \
  "screenshot $root/checks/05-health.png" "screenshot $root/checks/06-location.png" \
  "screenshot $root/checks/07-chatgpt-sheet.png" "screenshot $root/checks/08-report.png"
check "checks.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="checks.sh Release with SVETT_DEVICE_CMD"
checks_sh FAKE_RELEASE=1 --release "$root/checks-release"
check "checks.sh Release relaunches the installed app without Metro and reopens it by bundle id" \
  only_open "com.kron00.svett --relaunch" "com.kron00.svett --relaunch" com.apple.springboard \
  com.kron00.svett com.kron00.svett com.kron00.svett "com.kron00.svett --relaunch"
check "checks.sh Release never scrolls or presses while the Home Screen is in front" never_acts_on_home_screen
check "checks.sh Release notes the simulator in the report" \
  grep -qF "Simulator: it cannot lock its screen" "$root/checks-release/report.txt"
check "checks.sh Release leaves out the Debug reload note" \
  test "$(grep -cF "Debug:" "$root/checks-release/report.txt")" -eq 0

case_name="checks.sh when the dev client reloads on its way back"
checks_sh FAKE_RELOAD=1 "$root/checks-reload"
check "checks.sh reopens Phone checks from the You tab before each check after svett comes back on its tab root" \
  only_calls "get attrs" \
  'get attrs id="phone-checks-row"' 'get attrs id="reset-checks"' 'get attrs id="phone-checks-row"' \
  'get attrs id="check-run-notification"' 'get attrs id="phone-checks-row"' 'get attrs id="check-run-health"' \
  'get attrs id="phone-checks-row"' 'get attrs id="check-run-location"' 'get attrs id="phone-checks-row"' \
  'get attrs id="check-run-chatgpt"' 'get attrs id="phone-checks-row"' 'get attrs id="copy-report"'
check "checks.sh still saves the report after reloads" grep -qxF "fake phone check report" "$root/checks-reload/report.txt"

case_name="checks.sh when svett stays in the background"
run_checks FAKE_STAYS_HOME=1 "$root/checks-home"
check "checks.sh fails when svett does not come back" test "$checks_status" -ne 0
check "checks.sh says svett did not come back" grep -qF "svett did not come back to the foreground" "$output"
check "checks.sh does not scroll or press on the Home Screen when svett stays away" never_acts_on_home_screen

case_name="checks.sh with the Apple Health sheet"
checks_sh FAKE_HEALTH_SHEET=1 "$root/checks-health"
check "checks.sh screenshots the Apple Health sheet and allows every type" \
  only_calls "screenshot $root/checks-health/0[56]|get attrs label" \
  "screenshot $root/checks-health/05-health-sheet.png" 'get attrs label="Turn On All"' \
  'get attrs label="Allow"' "screenshot $root/checks-health/06-health.png"

case_name="checks.sh when notifications cannot be granted ahead"
checks_sh FAKE_NO_GRANT=1 "$root/checks-no-grant"
check "checks.sh presses Run once to answer the notification prompt, then again to leave straight after" \
  test "$(grep -cxF -- "$bound_prefix get attrs id=\"check-run-notification\"" "$root/bound-calls")" -eq 2
check "checks.sh leaves svett straight after the second Run" leaves_after_notification_run

case_name="checks.sh when the ChatGPT sign-in sheet refuses alert dismiss"
checks_sh FAKE_CHATGPT_SHEET=1 "$root/checks-chatgpt"
check "checks.sh presses Cancel on the sheet that covers Phone checks" \
  only_calls "get attrs label" 'get attrs label="Cancel"'
check "checks.sh still saves the report after cancelling the sheet" \
  grep -qxF "fake phone check report" "$root/checks-chatgpt/report.txt"

case_name="checks.sh when the notification check did not pass"
run_checks FAKE_RELEASE=1 FAKE_NOTIFICATION=WAITING --release "$root/checks-unpassed"
check "checks.sh fails when a check the simulator can pass did not" test "$checks_status" -ne 0
check "checks.sh names the check that did not pass" \
  grep -qxF "Did not pass: Notification in the background" "$output"
check "checks.sh still saves the report when a check did not pass" \
  grep -qF "Notification in the background: WAITING." "$root/checks-unpassed/report.txt"
check "checks.sh still screenshots the report when a check did not pass" \
  bound_got "$bound_prefix screenshot $root/checks-unpassed/08-report.png"

# Stands in for the bound command on the Progress screens. A screen's closing
# element, whose id ends in -end, is on screen after FAKE_PROGRESS_SCROLLS scrolls
# since the last open, by default 1. Every other element is on screen, except the
# one FAKE_HIDDEN names. The workout counts read FAKE_COUNTS.
cat >"$fake/progress-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
case "\$*" in
  *' is visible id="'*'-end"')
    scrolls=\$(awk '/ open / { n = 0 } / scroll down 0[.]6$/ { n++ } END { print n + 0 }' "$root/bound-calls")
    ((scrolls >= \${FAKE_PROGRESS_SCROLLS:-1})) ;;
  *" is visible "*) [[ -z "\${FAKE_HIDDEN:-}" || "\$*" != *"id=\"\$FAKE_HIDDEN\""* ]] ;;
  *" get text "*) echo "\${FAKE_COUNTS:-300 workouts, 6012 sets}" ;;
esac
EOF
chmod +x "$fake/progress-device"

# run_progress [VAR=value...] [progress.sh args...] leaves the exit status in progress_status.
run_progress() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -f "$root/simctl-calls" "$root/bound-calls" "$container_fixture"
  progress_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="progress-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/progress.sh" "$@" >"$output" 2>&1 || progress_status=$?
}

progress_fails() {
  [[ "$progress_status" != 0 ]] || fail "progress.sh succeeded"
  grep -qF -- "$1" "$output" || fail "progress.sh did not print \"$1\""
}

bench_id=76d53b4c-195c-578c-8797-16475c947397
progress_links=(
  "com.kron00.svett svett://progress/exercise/$bench_id?range=all"
  "com.kron00.svett svett://progress/muscles?week=2026-10-26"
  "com.kron00.svett svett://progress/measurements?kind=body_weight&range=all"
  "com.kron00.svett svett://progress/measurements?kind=body_weight&range=all&sheet=open"
)
largest_text="settings text-size accessibility-extra-extra-extra-large"

case_name="progress.sh Debug with SVETT_DEVICE_CMD"
proof="$root/proof progress"
run_progress "$proof"
[[ "$progress_status" == 0 ]] || fail "progress.sh failed"
check "progress.sh copies the generated fixture into the app's data container" \
  grep -qxF "fake fixture" "$container_fixture"
check "progress.sh relaunches into the dev client on the fixture, then opens each chart's link" only_open \
  "com.kron00.svett --relaunch --launch-url $local_dev_client_url --launch-args=-svettFixture --launch-args=$container_fixture" \
  "${progress_links[@]}"
check "progress.sh shoots at the largest text size and restores the default" \
  only_calls "settings" "$largest_text" "settings text-size large"
check "progress.sh pages each screen down to its closing rule, then shoots the add sheet" \
  only_calls "screenshot" \
  "screenshot $proof/01-progress-01.png" "screenshot $proof/01-progress-02.png" \
  "screenshot $proof/02-bench-01.png" "screenshot $proof/02-bench-02.png" \
  "screenshot $proof/03-muscles-01.png" "screenshot $proof/03-muscles-02.png" \
  "screenshot $proof/04-body-weight-01.png" "screenshot $proof/04-body-weight-02.png" \
  "screenshot $proof/05-add-measurement.png"
check "progress.sh looks for each chart on the first page it shoots of the screen" \
  only_calls 'is visible id="chart' \
  'is visible id="chart-best_one_rep_max"' 'is visible id="chart-heaviest_weight"' \
  'is visible id="chart-session_volume"' 'is visible id="chart-muscle-weeks"' \
  'is visible id="chart-measurement"'
check "progress.sh presses only the Progress tab, since agent-device refuses presses in screen content" \
  only_calls "press" 'press label="Progress, tab, 3 of 5"'
check "progress.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="progress.sh Release with SVETT_DEVICE_CMD"
run_progress --release "$root/proof-progress-release"
[[ "$progress_status" == 0 ]] || fail "progress.sh --release failed"
check "progress.sh Release relaunches the installed app on the fixture without Metro" only_open \
  "com.kron00.svett --relaunch --launch-args=-svettFixture --launch-args=$container_fixture" \
  "${progress_links[@]}"

case_name="progress.sh when the fixture does not open"
run_progress FAKE_COUNTS="0 workouts, 0 sets" "$root/proof-progress-empty"
check "progress.sh fails when the Progress tab does not show the fixture's 300 workouts" \
  progress_fails "The Progress tab did not show the fixture's 300 workouts: 0 workouts, 0 sets"
check "progress.sh restores the default text size after a failure" \
  only_calls "settings" "$largest_text" "settings text-size large"

case_name="progress.sh when a chart does not draw"
run_progress FAKE_HIDDEN=chart-heaviest_weight "$root/proof-progress-hidden"
check "progress.sh fails naming a chart that was on none of the pages" \
  progress_fails "02-bench: never on screen: chart-heaviest_weight"

case_name="progress.sh without a closing rule"
run_progress FAKE_PROGRESS_SCROLLS=1000 "$root/proof-progress-endless"
check "progress.sh stops after 40 pages when a screen's closing rule never shows" \
  progress_fails "01-progress: progress-end was not on screen after 40 pages"

# Stands in for the bound command on the large-title screens. A screenshot shows
# the screen in front, the one the last tab press or open brought up, and how far
# it has scrolled since then. As on iOS, a swipe or pan scrolls only when it
# starts inside the scrolling view: the whole screen, or on Coach the chat above
# the composer, which ends at y=FAKE_CHAT_BOTTOM, by default 590, and at y=360
# once the composer rises above the keyboard. So scroll down 0.6, which starts at
# y=765, moves every screen but the chat. The chat opens scrolled to its end, New
# chat shows within 200 points of its top and the latest answer within 300 of its
# end. FAKE_STUCK names a press or open whose screen never scrolls down. A wait for
# FAKE_MISSING times out. The Progress tab counts FAKE_COUNTS, by default the
# fixture's. On Coach, New chat stays on screen with FAKE_SHORT_CHAT, the question
# field sits at y=FAKE_INPUT_Y, and once text is typed the composer rises above
# the keyboard, unless FAKE_COVERED leaves it under the keyboard.
cat >"$fake/headers-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
typed() { grep -q ' type ' "$root/bound-calls"; }
raised() { typed && [[ -z "\${FAKE_COVERED:-}" ]]; }
rect() { printf '{"rect":{"x":%s,"y":%s,"width":%s,"height":%s}}\n' "\$@"; }
offset() {
  awk -v stuck="\${FAKE_STUCK:-}" -v bottom="\${FAKE_CHAT_BOTTOM:-590}" -v covered="\${FAKE_COVERED:-}" '
    function drag(y, dy) {
      if (y < 0 || y > (chat ? (typed && covered == "" ? 360 : bottom) : 956)) return
      if (dy < 0 && stuck != "" && index(screen, stuck) > 0) return
      n -= dy
      n = n < 0 ? 0 : n > 1000 ? 1000 : n
    }
    / press label=| open / { screen = \$0; chat = index(screen, "svett://coach") > 0; n = chat ? 1000 : 0 }
    / type / { typed = 1 }
    / scroll down 0[.]6$/ { drag(765, -574) }
    / scroll up 0[.]6$/ { drag(191, 574) }
    / gesture pan / { drag(\$(NF - 3), \$(NF - 1)) }
    END { print screen, "scrolled", n }' "$root/bound-calls"
}
scrolled() { local state; state=\$(offset); echo "\${state##* }"; }
case "\$*" in
  *" wait "*) [[ -z "\${FAKE_MISSING:-}" || "\$*" != *"\$FAKE_MISSING"* ]] ;;
  *' get text id="workout-counts"') echo "\${FAKE_COUNTS:-300 workouts, 6,012 sets}" ;;
  *' get text id="coach-input"') if typed; then echo Bench; fi ;;
  *' is visible id="coach-new"') [[ -n "\${FAKE_SHORT_CHAT:-}" ]] || ((\$(scrolled) < 200)) ;;
  *' is visible id="coach-answer"') ((\$(scrolled) > 700)) ;;
  *' get attrs id="coach"')
    echo 'Error (AMBIGUOUS_MATCH): Selector matched 2 elements: id="coach"' >&2
    exit 1 ;;
  *' get attrs role="other" id="coach"')
    if raised; then rect 0 0 440 360; else rect 0 0 440 "\${FAKE_CHAT_BOTTOM:-590}"; fi ;;
  *' get attrs id="coach-new"') rect 20 \$((205 - \$(scrolled))) 400 60 ;;
  *' get attrs id="coach-answer"') rect 20 120 400 200 ;;
  *' get attrs id="coach-input"')
    if raised; then rect 20 370 400 80; else rect 20 "\${FAKE_INPUT_Y:-700}" 400 80; fi ;;
  *' get attrs id="coach-composer"')
    if raised; then rect 0 360 440 160; else rect 0 690 440 160; fi ;;
  *" screenshot "*) offset >"\${@: -1}" ;;
esac
EOF
chmod +x "$fake/headers-device"

# run_headers [VAR=value...] [headers.sh args...] leaves the exit status in headers_status.
run_headers() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -f "$root/simctl-calls" "$root/bound-calls" "$container_fixture"
  headers_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="headers-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/headers.sh" "$@" >"$output" 2>&1 || headers_status=$?
}

header_links=(
  "com.kron00.svett svett://exercises"
  "com.kron00.svett svett://data"
  "com.kron00.svett svett://gallery"
)
coach_stub="$root/data container/Documents/coach-best-squat.json"
coach_args="--launch-args=-svettChatGPTStub --launch-args=signedIn --launch-args=-svettCoachStub --launch-args=$coach_stub"
coach_asks=(
  "com.kron00.svett svett://coach?ask=What%20was%20my%20best%20squat%20set%20last%20month%3F"
  "com.kron00.svett svett://coach?ask=Remind%20me%2C%20what%20was%20my%20best%20squat%20set%20last%20month%3F"
  "com.kron00.svett svett://coach?ask=Once%20more%2C%20what%20was%20my%20best%20squat%20set%20last%20month%3F"
)
header_presses=(
  'press label="Home, tab, 1 of 5"' 'press label="Train, tab, 2 of 5"'
  'press label="Progress, tab, 3 of 5"' 'press label="You, tab, 5 of 5"'
  'press label="Coach, tab, 4 of 5"' 'press 220 740'
)
header_shots=()
shot_number=0
for screen in home train progress you exercises data gallery coach; do
  for state in top scrolled; do
    shot_number=$((shot_number + 1))
    header_shots+=("$(printf 'screenshot %s/proof headers/%02d-%s-%s.png' "$root" "$shot_number" "$screen" "$state")")
  done
done
header_shots+=("$(printf 'screenshot %s/proof headers/17-coach-keyboard.png' "$root")")

fixture_launch="--launch-args=-svettFixture --launch-args=$container_fixture"

# headers_fails <message> checks headers.sh stopped with exactly that line.
headers_fails() {
  [[ "$headers_status" != 0 ]] || fail "headers.sh succeeded"
  grep -qxF -- "$1" "$output" || fail "headers.sh did not print \"$1\""
}

case_name="headers.sh Debug with SVETT_DEVICE_CMD"
run_headers "$root/proof headers"
[[ "$headers_status" == 0 ]] || fail "headers.sh failed"
check "headers.sh copies the generated fixture and the coach's stand-in into the app's data container" \
  grep -qxF "fake fixture" "$container_fixture"
check "headers.sh copies the coach's stand-in unchanged" \
  cmp -s "$repo/packages/tools/fixtures/coach-best-squat.json" "$coach_stub"
check "headers.sh relaunches on the fixture, opens each pushed screen's link, then relaunches signed in on the stand-ins and asks three questions" \
  only_open "$debug_open $fixture_launch" "${header_links[@]}" \
  "$debug_open $fixture_launch $coach_args" "${coach_asks[@]}"
check "headers.sh shoots at the largest text size and restores the default" \
  only_calls "settings" "$largest_text" "settings text-size large"
check "headers.sh presses the tab buttons, then the question field at its centre" \
  only_calls "press" "${header_presses[@]}"
pull='gesture pan 8 266 0 265 800' push='gesture pan 8 531 0 -265 800' raised_push='gesture pan 8 324 0 -162 800'
check "headers.sh shoots every large-title screen at rest and after scrolling 60% of the screen, then drags the chat inside its frame and shoots the composer above the keyboard" \
  only_calls "screenshot|scroll|gesture|type" \
  "${header_shots[0]}" "scroll down 0.6" "${header_shots[1]}" \
  "${header_shots[2]}" "scroll down 0.6" "${header_shots[3]}" \
  "${header_shots[4]}" "scroll down 0.6" "${header_shots[5]}" \
  "${header_shots[6]}" "scroll down 0.6" "${header_shots[7]}" \
  "${header_shots[8]}" "scroll down 0.6" "${header_shots[9]}" \
  "${header_shots[10]}" "scroll down 0.6" "${header_shots[11]}" \
  "${header_shots[12]}" "scroll down 0.6" "${header_shots[13]}" \
  "$pull" "$pull" "$pull" "$pull" "$pull" \
  "${header_shots[14]}" "$push" "${header_shots[15]}" \
  "type Bench" "$raised_push" "$raised_push" "$raised_push" "${header_shots[16]}"
check "headers.sh waits for each tab to be selected, each screen's content and each answer" \
  only_calls 'wait (absent )?(label|id|text)' \
  'wait label="Home, tab, 1 of 5" selected=true 120000' \
  'wait label="Home, tab, 1 of 5" selected=true 10000' \
  'wait label="Train, tab, 2 of 5" selected=true 10000' 'wait id="routine-list" 30000' \
  'wait label="Progress, tab, 3 of 5" selected=true 10000' 'wait id="progress" 10000' \
  'wait absent id="workout-counts" label="Opening the database" 30000' \
  'wait label="You, tab, 5 of 5" selected=true 10000' \
  'wait id="exercise-library" 10000' 'wait id="data" 10000' 'wait id="gallery" 10000' \
  'wait label="Home, tab, 1 of 5" selected=true 120000' \
  'wait label="Coach, tab, 4 of 5" selected=true 10000' 'wait id="coach-composer" 30000' \
  'wait text What was my best squat set last month? 15000' 'wait absent id="coach-pending" 60000' \
  'wait id="coach-answer" 10000' \
  'wait text Remind me, what was my best squat set last month? 15000' \
  'wait absent id="coach-pending" 60000' 'wait id="coach-answer" 10000' \
  'wait text Once more, what was my best squat set last month? 15000' \
  'wait absent id="coach-pending" 60000' 'wait id="coach-answer" 10000'
check "headers.sh checks the chat is longer than the screen, the field took the text and the latest answer shows" \
  only_calls 'is visible|get text id="coach' \
  'is visible id="coach-new"' 'is visible id="coach-new"' 'is visible id="coach-new"' \
  'is visible id="coach-new"' 'is visible id="coach-new"' 'is visible id="coach-new"' \
  'is visible id="coach-new"' 'get text id="coach-input"' \
  'is visible id="coach-answer"' 'is visible id="coach-answer"' 'is visible id="coach-answer"' \
  'is visible id="coach-answer"' 'is visible id="coach-answer"'
check "headers.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="headers.sh Release with SVETT_DEVICE_CMD"
run_headers --release "$root/proof-headers-release"
[[ "$headers_status" == 0 ]] || fail "headers.sh --release failed"
check "headers.sh Release relaunches the installed app on the fixture without Metro, both times" \
  only_open "com.kron00.svett --relaunch $fixture_launch" "${header_links[@]}" \
  "com.kron00.svett --relaunch $fixture_launch $coach_args" "${coach_asks[@]}"

case_name="headers.sh when a short tab does not scroll"
run_headers FAKE_STUCK="Home, tab" "$root/proof-headers-short"
check "headers.sh accepts a tab whose content fits on the screen" test "$headers_status" -eq 0

case_name="headers.sh when the coach's title does not collapse"
run_headers FAKE_STUCK=svett://coach "$root/proof-headers-coach-stuck"
check "headers.sh fails when the long chat does not move under the title" \
  headers_fails "coach: the scrolled screenshot matches the one at rest, so the screen did not scroll"

# Round 3 scrolled the chat with scroll down 0.6, whose swipe starts at y=765 in the
# composer, so r3-15 and r3-16 came out the same. A copy of headers.sh that does
# that again must fail the same way on the fake device.
r3_repo="$root/r3-repo"
mkdir -p "$r3_repo/scripts/sim" "$r3_repo/packages/tools/fixtures"
cp "$repo/scripts/sim/simulator.sh" "$repo/scripts/sim/launch.sh" "$r3_repo/scripts/sim/"
cp "$repo/packages/tools/fixtures/coach-best-squat.json" "$r3_repo/packages/tools/fixtures/"
awk '{ if (after_top && $0 == "drag_chat down") $0 = "agent_device scroll down 0.6"; after_top = ($0 == "top=$last"); print }' \
  "$repo/scripts/sim/headers.sh" >"$r3_repo/scripts/sim/headers.sh"
chmod +x "$r3_repo/scripts/sim/headers.sh"
case_name="headers.sh with round 3's scroll down on the chat"
grep -qxF "agent_device scroll down 0.6" "$r3_repo/scripts/sim/headers.sh" ||
  fail "the round 3 copy of headers.sh does not scroll down"
rm -f "$root/simctl-calls" "$root/bound-calls" "$container_fixture"
headers_status=0
env PATH="$fake:$PATH" SVETT_DEVICE_CMD="headers-device --session 't3-test session' --device FAKE-UDID" \
  "$r3_repo/scripts/sim/headers.sh" "$root/proof-headers-r3" >"$output" 2>&1 || headers_status=$?
check "a scroll down that starts in the composer leaves the chat where it was, as in r3-15 and r3-16" \
  headers_fails "coach: the scrolled screenshot matches the one at rest, so the screen did not scroll"
check "the pan inside the chat's frame moves it, so headers.sh passes where round 3 failed" \
  cmp -s <(printf 'scrolled 0\nscrolled 265\n') \
  <(sed 's/.* scrolled /scrolled /' "$root/proof headers/15-coach-top.png" "$root/proof headers/16-coach-scrolled.png")

case_name="headers.sh when the chat reaches the bottom edge"
run_headers FAKE_CHAT_BOTTOM=950 "$root/proof-headers-coach-tall"
check "headers.sh never drags the chat from the screen's bottom edge" \
  headers_fails "The chat's drag would start at y=855, on the screen's bottom edge, where a touch does not land."
check "headers.sh makes no drag when the chat reaches the bottom edge" \
  only_calls "gesture" ""

case_name="headers.sh when the chat fits on the screen"
run_headers FAKE_SHORT_CHAT=1 "$root/proof-headers-coach-short"
short_shots=("${header_shots[@]/proof headers/proof-headers-coach-short}")
check "headers.sh fails when New chat still shows after three answers" \
  headers_fails "The chat still fits on the screen after three answers, so the coach's title has nothing to collapse over."
check "headers.sh shoots no coach screen when the chat is short" \
  only_calls "screenshot" "${short_shots[@]:0:14}"

case_name="headers.sh when the keyboard hides the composer"
run_headers FAKE_COVERED=1 "$root/proof-headers-coach-covered"
covered_shots=("${header_shots[@]/proof headers/proof-headers-coach-covered}")
check "headers.sh fails when the composer does not rise above the keyboard" \
  headers_fails "The composer stayed at y=690 under the keyboard instead of rising from y=690."
check "headers.sh shoots no keyboard screen when the composer is hidden" \
  only_calls "screenshot" "${covered_shots[@]:0:16}"
check "headers.sh restores the default text size after the composer check fails" \
  only_calls "settings" "$largest_text" "settings text-size large"

case_name="headers.sh when the question field is at the bottom edge"
run_headers FAKE_INPUT_Y=820 "$root/proof-headers-coach-low"
check "headers.sh never presses the question field on the bottom edge" \
  headers_fails "The question field's centre is at y=860, on the screen's bottom edge, where a press does not land."
check "headers.sh presses only the tab buttons when the question field is on the bottom edge" \
  only_calls "press" "${header_presses[@]:0:5}"

case_name="headers.sh when a coach answer does not arrive"
run_headers FAKE_MISSING='id="coach-pending"' "$root/proof-headers-coach-pending"
check "headers.sh fails naming the question the coach did not answer" \
  headers_fails 'The coach did not answer "What was my best squat set last month?".'

case_name="headers.sh when a long screen does not scroll"
run_headers FAKE_STUCK=svett://data "$root/proof-headers-stuck"
check "headers.sh fails when a screen longer than the phone does not move" test "$headers_status" -ne 0
check "headers.sh names the screen that did not scroll" \
  grep -qxF "data: the scrolled screenshot matches the one at rest, so the screen did not scroll" "$output"
check "headers.sh restores the default text size after a failure" \
  only_calls "settings" "$largest_text" "settings text-size large"

case_name="headers.sh when the Train tab does not scroll"
run_headers FAKE_STUCK="Train, tab" "$root/proof-headers-train"
check "headers.sh fails when the Train tab's routines do not move under the title" \
  grep -qxF "train: the scrolled screenshot matches the one at rest, so the screen did not scroll" "$output"

case_name="headers.sh when the fixture does not open"
run_headers FAKE_COUNTS="0 workouts, 0 sets" "$root/proof-headers-empty"
check "headers.sh fails when the Progress tab does not show the fixture's 300 workouts" \
  grep -qxF "The Progress tab did not show the fixture's 300 workouts: 0 workouts, 0 sets" "$output"
check "headers.sh shoots nothing on Progress when the fixture did not open" \
  only_calls "screenshot" "$(printf "screenshot $root/proof-headers-empty/%02d-%s.png\n" \
    1 home-top 2 home-scrolled 3 train-top 4 train-scrolled)"

case_name="headers.sh when the routines do not show"
run_headers FAKE_MISSING='id="routine-list"' "$root/proof-headers-routines"
check "headers.sh fails when the Train tab does not list the fixture's routines" \
  test "$headers_status" -ne 0
check "headers.sh shoots nothing on Train when its routines do not show" \
  only_calls "screenshot" "$(printf "screenshot $root/proof-headers-routines/%02d-%s.png\n" \
    1 home-top 2 home-scrolled)"

case_name="headers.sh when a screen does not show"
run_headers FAKE_MISSING='id="exercise-library"' "$root/proof-headers-missing"
check "headers.sh fails when a large-title screen does not show" test "$headers_status" -ne 0
check "headers.sh shoots nothing after the missing screen" \
  only_calls "screenshot" "$(printf "screenshot $root/proof-headers-missing/%02d-%s.png\n" \
    1 home-top 2 home-scrolled 3 train-top 4 train-scrolled 5 progress-top 6 progress-scrolled \
    7 you-top 8 you-scrolled)"
check "headers.sh restores the default text size when a screen does not show" \
  only_calls "settings" "$largest_text" "settings text-size large"

# Stands in for the bound command on the exercise library. It tracks the screen in
# front and the saved custom exercises, which a relaunch keeps unless FAKE_FORGETS
# is set. The bundled library holds FAKE_LIBRARY, by default "Barbell Squat".
# A search link lists the exercises whose name starts with its text, ignoring case.
# A press on the library opens the first result. A press on the form saves it.
# The detail's "From" row starts below the fold, so only a scroll finds it.
cat >"$fake/exercises-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
screen=\$(cat "$root/screen" 2>/dev/null || echo home)
state() { cat "$root/\$1" 2>/dev/null || true; }
names() {
  echo "\${FAKE_LIBRARY:-Barbell Squat}"
  state custom
}
first_result() {
  local query
  query=\$(state query)
  names | awk -v q="\$query" 'index(tolower(\$0), tolower(q)) == 1 { print; exit }'
}
decode() { node -e 'process.stdout.write(decodeURIComponent(process.argv[1]))' "\$1"; }
args=" \$* "
case "\$args" in
  *" open com.kron00.svett --relaunch "*)
    echo tabs >"$root/screen"
    [[ -z "\${FAKE_FORGETS:-}" ]] || rm -f "$root/custom" ;;
  *" open com.kron00.svett svett://exercises?q="*)
    echo library >"$root/screen"
    decode "\${args#* svett://exercises?q=}" | sed 's/ \$//' >"$root/query" ;;
  *" open com.kron00.svett svett://exercises/new?name="*)
    echo form >"$root/screen"
    query=\${args#* svett://exercises/new?name=}
    decode "\${query%%&*}" >"$root/pending" ;;
  *' get attrs id="exercise-result-0" '*)
    [[ "\$screen" == library && -n "\$(first_result)" ]] || exit 1
    printf '{"label": "%s, Chest · Cable", "rect": {"x": 0, "y": 200, "width": 440, "height": 80}}\n' "\$(first_result)" ;;
  *" get attrs "*) echo '{"label": "Save exercise", "rect": {"x": 16, "y": 700, "width": 408, "height": 50}}' ;;
  *' wait label="Train, tab, 2 of 5" '*) [[ "\$screen" != home ]] ;;
  *' wait id="exercise-library" '*) [[ "\$screen" == library ]] ;;
  *' wait id="exercise-form" '*) [[ "\$screen" == form ]] ;;
  *' wait id="exercise-detail" '*) [[ "\$screen" == detail ]] ;;
  *' wait id="exercise-name" label='*) [[ "\$screen" == detail && "\$args" == *"label=\"\$(state detail)\" "* ]] ;;
  *' is visible id="exercise-source" '* | *' wait id="exercise-source" '*) exit 1 ;;
  *' --until id="exercise-source" label="From, Custom" '*) grep -qxF -- "\$(state detail)" "$root/custom" 2>/dev/null ;;
  *' --until id="exercise-source" label="From, svett library" '*) names | grep -qxF -- "\$(state detail)" ;;
  *" is visible "*) [[ "\$screen" == form ]] ;;
  *" press "[0-9]*)
    case \$screen in
      library) first_result >"$root/detail" ;;
      form)
        state pending >>"$root/custom"
        state pending >"$root/detail" ;;
      *) exit 1 ;;
    esac
    echo detail >"$root/screen" ;;
esac
EOF
chmod +x "$fake/exercises-device"

# run_exercises [VAR=value...] [exercises.sh args...] leaves the exit status in exercises_status.
run_exercises() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -f "$root/simctl-calls" "$root/bound-calls" "$root/screen" "$root/query" "$root/pending" \
    "$root/detail" "$root/custom"
  exercises_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="exercises-device --session 't3-test session' --device FAKE-UDID" \
    SVETT_EXERCISE_NAME="Proof press 1" "${vars[@]}" "$repo/scripts/sim/exercises.sh" "$@" \
    >"$output" 2>&1 || exercises_status=$?
}

exercise_links=("com.kron00.svett svett://exercises?q=barbell%20squat"
  "com.kron00.svett svett://exercises/new?name=Proof%20press%201&muscle=chest&equipment=cable")
custom_search="com.kron00.svett svett://exercises?q=Proof%20press%201"

case_name="exercises.sh Debug with SVETT_DEVICE_CMD"
run_exercises "$root/exercises"
[[ "$exercises_status" == 0 ]] || fail "exercises.sh failed"
check "exercises.sh searches the library, creates an exercise, relaunches into the dev client and searches for it" \
  only_open "$debug_open" "${exercise_links[@]}" "$debug_open" "$custom_search"
check "exercises.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size|settings appearance" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "exercises.sh opens the first result, saves the form and opens the saved exercise, each by its centre" \
  only_calls "press|get attrs" \
  'get attrs id="exercise-result-0"' "press 220 240" 'get attrs id="save-exercise"' "press 220 725" \
  'get attrs id="exercise-result-0"' "press 220 240"
check "exercises.sh checks the custom exercise's name and source after the relaunch" \
  bound_got "$bound_prefix wait id=\"exercise-name\" label=\"Proof press 1\" 10000"
check "exercises.sh screenshots each step" \
  only_calls "screenshot" \
  "screenshot $root/exercises/01-library-search.png" "screenshot $root/exercises/02-library-detail.png" \
  "screenshot $root/exercises/03-new-exercise.png" "screenshot $root/exercises/04-custom-detail.png" \
  "screenshot $root/exercises/05-custom-search-after-relaunch.png" \
  "screenshot $root/exercises/06-custom-detail-after-relaunch.png"
check "exercises.sh with SVETT_DEVICE_CMD never calls simctl" test ! -e "$root/simctl-calls"

case_name="exercises.sh Release with SVETT_DEVICE_CMD"
run_exercises --release "$root/exercises-release"
[[ "$exercises_status" == 0 ]] || fail "exercises.sh --release failed"
check "exercises.sh Release relaunches the installed app without Metro" \
  only_open "com.kron00.svett --relaunch" "${exercise_links[@]}" "com.kron00.svett --relaunch" "$custom_search"

case_name="exercises.sh when the custom exercise does not survive the relaunch"
run_exercises FAKE_FORGETS=1 "$root/exercises-forgets"
check "exercises.sh fails when the custom exercise is gone after the relaunch" test "$exercises_status" -ne 0
check "exercises.sh says the search found nothing" \
  grep -qxF 'The search for "Proof press 1" showed no result' "$output"
check "exercises.sh restores the default text size after a failure" \
  only_calls "settings" "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="exercises.sh when the library search shows another exercise first"
run_exercises FAKE_LIBRARY="Barbell Squat Jump" "$root/exercises-other"
check "exercises.sh fails when the first result is not the library exercise" test "$exercises_status" -ne 0
check "exercises.sh names the result it found instead" \
  grep -qxF 'The first result was not "Barbell Squat". Its label is "Barbell Squat Jump, Chest · Cable".' "$output"

# data.sh runs against a fake fixture, a fake app and the real compare script.
# The fake pnpm writes a small fixture database. The fake device stands in for
# svett: Export writes a svett file to the cache folder, Import copies the
# fixture to the wiped database with one import batch, and Undo deletes every
# workout and marks the batch undone. FAKE_IMPORT_DIFFERS changes a workout on
# import, FAKE_IMPORT_TWICE records a second batch when the same file opens
# again, and FAKE_NO_EXPORT writes no export. The Import and Undo buttons and the
# past import start below the fold, as at the largest text size, so only a scroll
# finds them.
data_fake="$root/data-bin"
mkdir -p "$data_fake"
cat >"$data_fake/pnpm" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "fixture --out" ]] || { echo "fake pnpm: unexpected $*" >&2; exit 1; }
node -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1]).exec(process.argv[2])' "$3" "
  CREATE TABLE import_batch (id TEXT PRIMARY KEY, updated_at INTEGER, deleted_at INTEGER, source TEXT, created_at INTEGER, status TEXT);
  CREATE TABLE import_change (id TEXT PRIMARY KEY, updated_at INTEGER, deleted_at INTEGER, import_batch_id TEXT);
  CREATE TABLE activity (id TEXT PRIMARY KEY, updated_at INTEGER, deleted_at INTEGER, title TEXT);
  CREATE TABLE activity_set (id TEXT PRIMARY KEY, updated_at INTEGER, deleted_at INTEGER, reps INTEGER);
  INSERT INTO activity VALUES ('a1', 1, NULL, 'Legs'), ('a2', 1, NULL, 'Back');
  INSERT INTO activity_set VALUES ('s1', 1, NULL, 5), ('s2', 1, NULL, 5), ('s3', 1, NULL, 8);
"
EOF

cat >"$data_fake/data-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
documents="$root/data container/Documents"
sql() {
  node -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1]).exec(process.argv[2])' "\$@"
}
args=" \$* "
case "\$args" in
  *" --launch-args=/"*) echo "\${args##*--launch-args=}" | sed 's/ *$//' >"$root/launched" ;;
  *" open com.kron00.svett svett://import?file="*)
    if [[ -n "\${FAKE_IMPORT_TWICE:-}" && -e "\$documents/svett-wiped.db" ]]; then
      sql "\$documents/svett-wiped.db" "INSERT INTO import_batch VALUES ('b2', 2, NULL, 'svett_file', 2, 'applied')"
    fi ;;
  *' wait id="import-apply"'* | *' wait id="undo-apply"'* | *' wait id="import-batch-0"'* | *' is visible id="import-apply"'* | *' is visible id="undo-apply"'* | *' is visible id="import-batch-0"'*)
    exit 1 ;;
  *" get attrs "*)
    echo "\$*" >"$root/last-attrs"
    echo '{"rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" press "[0-9]*)
    case "\$(cat "$root/last-attrs")" in
      *export-button*)
        if [[ -z "\${FAKE_NO_EXPORT:-}" ]]; then
          mkdir -p "$root/data container/Library/Caches"
          echo '{"format":"svett","version":1,"exportedAt":0,"tables":{"activity":[{}],"folder":[]}}' \
            >"$root/data container/Library/Caches/svett-export-2026-11-13.json"
        fi ;;
      *import-apply*)
        cp "\$documents/svett-fixture.db" "\$documents/svett-wiped.db"
        sql "\$documents/svett-wiped.db" "INSERT INTO import_batch VALUES ('b1', 1, NULL, 'svett_file', 1, 'applied'); INSERT INTO import_change VALUES ('c1', 1, NULL, 'b1')"
        [[ -z "\${FAKE_IMPORT_DIFFERS:-}" ]] ||
          sql "\$documents/svett-wiped.db" "UPDATE activity SET title = 'Changed' WHERE id = 'a1'" ;;
      *undo-apply*)
        sql "\$documents/svett-wiped.db" "UPDATE activity SET deleted_at = 9; UPDATE activity_set SET deleted_at = 9; UPDATE import_batch SET status = 'undone'" ;;
    esac ;;
  *" get text "*)
    launched=\$(cat "$root/launched")
    if [[ -e "\$launched" ]]; then
      node -e '
        const database = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
        const count = (table) => database.prepare("SELECT count(*) AS n FROM " + table + " WHERE deleted_at IS NULL").get().n;
        console.log(count("activity") + " workouts, " + count("activity_set") + " sets");
      ' "\$launched"
    else
      echo "0 workouts, 0 sets"
    fi ;;
esac
exit 0
EOF
chmod +x "$data_fake"/*

# run_data [VAR=value...] [data.sh args...] leaves the exit status in data_status.
run_data() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/launched" "$root/data container"
  data_status=0
  env PATH="$data_fake:$fake:$PATH" SVETT_DEVICE_CMD="data-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/data.sh" "$@" >"$output" 2>&1 || data_status=$?
}

documents="$root/data container/Documents"
fixture_args="--launch-args=-svettFixture --launch-args=$documents/svett-fixture.db"
wiped_args="--launch-args=-svettFixture --launch-args=$documents/svett-wiped.db"
import_link="com.kron00.svett svett://import?file=svett-proof-import.json"

case_name="data.sh Debug with SVETT_DEVICE_CMD"
run_data "$root/data proof"
[[ "$data_status" == 0 ]] || fail "data.sh failed"
check "data.sh opens the fixture, exports, wipes, imports twice and undoes, in that order" only_open \
  "$debug_open $fixture_args" "com.kron00.svett svett://data" "$debug_open $wiped_args" "$import_link" \
  "$debug_open $wiped_args" "$import_link" "com.kron00.svett svett://data" "$debug_open $wiped_args"
check "data.sh presses Export, Import, the past import and Undo at their centres" \
  only_calls "get attrs" 'get attrs id="export-button"' 'get attrs id="import-apply"' \
  'get attrs id="import-batch-0"' 'get attrs id="undo-apply"'
check "data.sh presses only the Progress tab by selector, which agent-device allows" \
  only_calls 'press [^0-9]' 'press label="Progress, tab, 3 of 5"' 'press label="Progress, tab, 3 of 5"' \
  'press label="Progress, tab, 3 of 5"'
check "data.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "data.sh keeps the export it made" test -e "$root/data proof/svett-export-2026-11-13.json"
check "data.sh finds the imported database equal to the fixture row for row" \
  grep -qxF "Equal row for row." "$root/data proof/compare-import.txt"
check "data.sh writes each step's result to the summary" grep -qF \
  "Export, wipe, import: equal to the fixture row for row." "$root/data proof/summary.txt"
check "data.sh checks Progress after the import and after Undo" grep -qxF \
  "Undo: 0 workouts, 0 sets, and the import is marked undone." "$root/data proof/summary.txt"
check "data.sh screenshots every step" only_calls "screenshot" \
  "screenshot $root/data proof/01-data.png" "screenshot $root/data proof/02-share-sheet.png" \
  "screenshot $root/data proof/03-wiped.png" "screenshot $root/data proof/04-import-preview.png" \
  "screenshot $root/data proof/05-imported.png" "screenshot $root/data proof/06-counts-after-import.png" \
  "screenshot $root/data proof/07-import-again.png" "screenshot $root/data proof/08-data-with-import.png" \
  "screenshot $root/data proof/09-undo-preview.png" "screenshot $root/data proof/10-undone.png" \
  "screenshot $root/data proof/11-counts-after-undo.png"
check "data.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="data.sh Release with SVETT_DEVICE_CMD"
run_data --release "$root/data-release"
[[ "$data_status" == 0 ]] || fail "data.sh --release failed"
check "data.sh Release relaunches the installed app without Metro" only_open \
  "com.kron00.svett --relaunch $fixture_args" "com.kron00.svett svett://data" \
  "com.kron00.svett --relaunch $wiped_args" "$import_link" "com.kron00.svett --relaunch $wiped_args" \
  "$import_link" "com.kron00.svett svett://data" "com.kron00.svett --relaunch $wiped_args"

case_name="data.sh when the import differs from the fixture"
run_data FAKE_IMPORT_DIFFERS=1 "$root/data-differs"
check "data.sh fails when the imported database differs" test "$data_status" -ne 0
check "data.sh says the imported database differs" grep -qF "The imported database differs from the fixture" "$output"
check "data.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="data.sh when the same file imports twice"
run_data FAKE_IMPORT_TWICE=1 "$root/data-twice"
check "data.sh fails when importing the same file again records another import" \
  grep -qF "Importing the same file again" "$output"

case_name="data.sh when export writes no file"
run_data FAKE_NO_EXPORT=1 "$root/data-no-export"
check "data.sh fails when export writes no file" \
  grep -qF "Export wrote no svett-export-*.json to svett's cache folder" "$output"

# hevy.sh runs against a fake app that keeps a small database in the shape the
# script reads. Import writes the sample's workouts, or with both changed
# workouts switched on the changed sample's, and Undo writes the sample's back.
# FAKE_HEVY_TWICE records another import when the sample opens again,
# FAKE_HEVY_NEW shows new records for the changed sample, and FAKE_HEVY_UNDO
# leaves the changed workouts after Undo. From the second link on,
# FAKE_HEVY_NO_SUMMARY never shows the Hevy summary, and FAKE_HEVY_STALE also
# keeps the last import's result on screen, as the app did before a link
# started a new preview. Import and Undo start below the fold, as at the
# largest text size, so only a scroll finds them.
cat >"$data_fake/hevy-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
database="$root/data container/Documents/svett-hevy.db"
sql() {
  node -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1]).exec(process.argv[2])' "\$database" "\$1"
}
# write_state "<title> <sets> <kg> | ..." replaces the workouts with these.
write_state() {
  node -e '
    const database = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
    database.exec("DELETE FROM activity; DELETE FROM activity_exercise; DELETE FROM activity_set");
    process.argv[2].split(" | ").forEach((workout, at) => {
      const [, title, sets, kg] = /^(.*) (\\d+) ([\\d.]+)\$/.exec(workout);
      database.prepare("INSERT INTO activity VALUES (?, NULL, ?, ?)").run("a" + at, title, at);
      database.prepare("INSERT INTO activity_exercise VALUES (?, NULL, ?)").run("e" + at, "a" + at);
      for (let set = 0; set < Number(sets); set++) {
        database.prepare("INSERT INTO activity_set VALUES (?, NULL, ?, ?)").run("s" + at + "-" + set, "e" + at, Number(kg));
      }
    });
  ' "\$database" "\$1"
}
args=" \$* "
case "\$args" in
  *" --launch-args=/"*) echo "\${args##*--launch-args=}" | sed 's/ *\$//' >"$root/launched" ;;
  *" open com.kron00.svett svett://import?file="*)
    file=\${args##*file=}
    echo "\${file%%&*}" >"$root/hevy-opened"
    echo "\${file%%&*}" >>"$root/hevy-opens"
    rm -f "$root/hevy-taken"
    if [[ -n "\${FAKE_HEVY_TWICE:-}" && -e "\$database" ]]; then
      sql "INSERT INTO import_batch VALUES ('b9', NULL, 9, 'applied')"
    fi ;;
  *'id="import-new"'*) [[ -n "\${FAKE_HEVY_NEW:-}" ]] || exit 1 ;;
  *' wait id="hevy-summary"'*)
    [[ -z "\${FAKE_HEVY_NO_SUMMARY:-}\${FAKE_HEVY_STALE:-}" || "\$(wc -l <"$root/hevy-opens")" -lt 2 ]] || exit 1 ;;
  *' is visible id="import-done"'*) [[ -n "\${FAKE_HEVY_STALE:-}" ]] || exit 1 ;;
  *' wait id="import-apply"'* | *' wait id="undo-apply"'* | *' is visible id="import-apply"'* | *' is visible id="undo-apply"'*)
    exit 1 ;;
  *" get attrs "*)
    echo "\$*" >"$root/last-attrs"
    echo '{"rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" press "[0-9]*)
    case "\$(cat "$root/last-attrs")" in
      *import-changed-*) echo x >>"$root/hevy-taken" ;;
      *import-apply*)
        if [[ "\$(cat "$root/hevy-opened")" == svett-hevy-sample.csv ]]; then
          sql "CREATE TABLE activity (id TEXT PRIMARY KEY, deleted_at INTEGER, title TEXT, started_at INTEGER);
               CREATE TABLE activity_exercise (id TEXT PRIMARY KEY, deleted_at INTEGER, activity_id TEXT);
               CREATE TABLE activity_set (id TEXT PRIMARY KEY, deleted_at INTEGER, activity_exercise_id TEXT, weight_kg REAL);
               CREATE TABLE import_batch (id TEXT PRIMARY KEY, deleted_at INTEGER, created_at INTEGER, status TEXT);
               CREATE TABLE exercise (id TEXT PRIMARY KEY, name TEXT);
               CREATE TABLE exercise_alias (id TEXT PRIMARY KEY, deleted_at INTEGER, name TEXT, exercise_id TEXT);
               INSERT INTO import_batch VALUES ('b1', NULL, 1, 'applied');
               INSERT INTO exercise VALUES ('x1', 'Leverage Iso Row');
               INSERT INTO exercise_alias VALUES ('m1', NULL, 'Chest Supported Machine Row', 'x1');"
          write_state "Push Day 8 100 | Pull Day 8 160 | Legs 9 120"
        elif [[ "\$(wc -l <"$root/hevy-taken" 2>/dev/null)" -eq 2 ]]; then
          sql "INSERT INTO import_batch VALUES ('b2', NULL, 2, 'applied')"
          write_state "Push Day 7 102.5 | Back Day 8 160 | Legs 9 120"
        fi ;;
      *undo-apply*)
        sql "UPDATE import_batch SET status = 'undone' WHERE id = 'b2'"
        [[ -n "\${FAKE_HEVY_UNDO:-}" ]] || write_state "Push Day 8 100 | Pull Day 8 160 | Legs 9 120" ;;
    esac ;;
  *" get text "*)
    case "\$args" in
      *hevy-summary*) echo "A Hevy export with 3 workouts and 25 sets." ;;
      *import-changed-0*) echo "Back Day, 5 Nov 2026, Yours" ;;
      *import-changed-1*) echo "Push Day, 3 Nov 2026, Yours" ;;
      *)
        if [[ -e "\$database" ]]; then
          node -e '
            const database = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
            const count = (table) => database.prepare("SELECT count(*) AS n FROM " + table + " WHERE deleted_at IS NULL").get().n;
            console.log(count("activity") + " workouts, " + count("activity_set") + " sets");
          ' "\$database"
        else
          echo "0 workouts, 0 sets"
        fi ;;
    esac ;;
esac
exit 0
EOF
chmod +x "$data_fake/hevy-device"

# run_hevy [VAR=value...] [hevy.sh args...] leaves the exit status in hevy_status.
run_hevy() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/launched" "$root/data container" \
    "$root/hevy-opened" "$root/hevy-opens" "$root/hevy-taken"
  hevy_status=0
  env PATH="$data_fake:$fake:$PATH" SVETT_DEVICE_CMD="hevy-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/hevy.sh" "$@" >"$output" 2>&1 || hevy_status=$?
}

hevy_db_args="--launch-args=-svettFixture --launch-args=$documents/svett-hevy.db"
hevy_sample_link="com.kron00.svett svett://import?file=svett-hevy-sample.csv&kind=hevy"
hevy_changed_link="com.kron00.svett svett://import?file=svett-hevy-changed.csv&kind=hevy"

case_name="hevy.sh Debug with SVETT_DEVICE_CMD"
run_hevy "$root/hevy proof"
[[ "$hevy_status" == 0 ]] || fail "hevy.sh failed"
check "hevy.sh copies both Hevy samples into svett's documents" \
  cmp -s "$repo/packages/core/test-data/hevy-sample-changed.csv" "$documents/svett-hevy-changed.csv"
check "hevy.sh opens an empty database, imports the sample twice, then the changed sample, then relaunches" \
  only_open "$debug_open $hevy_db_args" "$hevy_sample_link" "$hevy_sample_link" "$hevy_changed_link" \
  "$debug_open $hevy_db_args"
check "hevy.sh presses the match, Import, Done, both changed workouts, Undo and its confirmation at their centres" \
  only_calls "get attrs" 'get attrs id="match-1-0"' 'get attrs id="match-continue"' \
  'get attrs id="import-apply"' 'get attrs id="import-close"' 'get attrs id="import-changed-0"' \
  'get attrs id="import-changed-1"' 'get attrs id="import-apply"' 'get attrs id="import-undo"' \
  'get attrs id="undo-apply"'
check "hevy.sh waits for Done to close the import before it opens the sample again" \
  grep -qF 'wait absent id="import-preview" 10000' "$root/bound-calls"
check "hevy.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "hevy.sh screenshots every step" only_calls "screenshot" \
  "screenshot $root/hevy proof/01-empty.png" "screenshot $root/hevy proof/02-match.png" \
  "screenshot $root/hevy proof/03-match-chosen.png" "screenshot $root/hevy proof/04-preview.png" \
  "screenshot $root/hevy proof/05-imported.png" "screenshot $root/hevy proof/06-import-again.png" \
  "screenshot $root/hevy proof/07-changed-preview.png" "screenshot $root/hevy proof/08-changed-taken.png" \
  "screenshot $root/hevy proof/09-changed-imported.png" "screenshot $root/hevy proof/10-undo-preview.png" \
  "screenshot $root/hevy proof/11-undone.png" "screenshot $root/hevy proof/12-counts-after-undo.png"
check "hevy.sh writes the remembered match to the summary" grep -qF \
  "Chest Supported Machine Row matched to Leverage Iso Row, and remembered." "$root/hevy proof/summary.txt"
check "hevy.sh writes the taken and the undone workouts to the summary" grep -qxF \
  "Undo: Push Day 8 100 | Pull Day 8 160 | Legs 9 120, the earlier versions." "$root/hevy proof/summary.txt"
check "hevy.sh checks Progress after Undo" grep -qxF \
  "After a relaunch: 3 workouts, 25 sets." "$root/hevy proof/summary.txt"
check "hevy.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="hevy.sh Release with SVETT_DEVICE_CMD"
run_hevy --release "$root/hevy-release"
[[ "$hevy_status" == 0 ]] || fail "hevy.sh --release failed"
check "hevy.sh Release relaunches the installed app without Metro" only_open \
  "com.kron00.svett --relaunch $hevy_db_args" "$hevy_sample_link" "$hevy_sample_link" \
  "$hevy_changed_link" "com.kron00.svett --relaunch $hevy_db_args"

case_name="hevy.sh when the same sample imports twice"
run_hevy FAKE_HEVY_TWICE=1 "$root/hevy-twice"
check "hevy.sh fails when importing the sample again records another import" \
  grep -qF "Importing the sample again recorded another import" "$output"

case_name="hevy.sh when the changed sample shows new records"
run_hevy FAKE_HEVY_NEW=1 "$root/hevy-new"
check "hevy.sh fails when a changed workout would be added as new" \
  grep -qF "The changed sample shows new records" "$output"

case_name="hevy.sh when the sample opened again shows no summary"
run_hevy FAKE_HEVY_NO_SUMMARY=1 "$root/hevy-no-summary"
[[ "$hevy_status" != 0 ]] || fail "hevy.sh passed although the Hevy summary never came"
check "hevy.sh fails with a clear message when the Hevy summary never comes" grep -qxF \
  "svett://import?file=svett-hevy-sample.csv&kind=hevy did not show the Hevy summary within 60 seconds" "$output"
check "hevy.sh never waits three minutes for the summary" \
  test -z "$(grep -F 'wait id="hevy-summary" 180000' "$root/bound-calls")"

case_name="hevy.sh when the sample opened again keeps the last import's result"
run_hevy FAKE_HEVY_STALE=1 "$root/hevy-stale"
[[ "$hevy_status" != 0 ]] || fail "hevy.sh passed although the link started no new preview"
check "hevy.sh says the link left the last import's result on screen" grep -qxF \
  "svett://import?file=svett-hevy-sample.csv&kind=hevy left the last import's result on screen instead of starting a new preview" \
  "$output"

case_name="hevy.sh when Undo leaves the new versions"
run_hevy FAKE_HEVY_UNDO=1 "$root/hevy-undo"
check "hevy.sh fails when Undo does not give back the earlier versions" \
  grep -qF "Undo did not give back the earlier versions" "$output"
check "hevy.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

# A fixture with the rows history.sh reads. It has an older and a newest workout,
# one deleted later still, and the newest workout's warm-up and first normal set.
history_fixture="$root/history-fixture.db"
cat >"$root/history-fixture.cjs" <<'EOF'
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[2]);
database.exec(`
  CREATE TABLE activity (id TEXT, started_at INTEGER, deleted_at INTEGER);
  CREATE TABLE activity_exercise (id TEXT, activity_id TEXT, position INTEGER);
  CREATE TABLE activity_set (
    id TEXT, activity_exercise_id TEXT, position INTEGER, set_type TEXT, reps INTEGER, deleted_at INTEGER
  );
  INSERT INTO activity VALUES ('older', 1, NULL), ('newest', 2, NULL), ('gone', 3, 4);
  INSERT INTO activity_exercise VALUES ('newest-squat', 'newest', 0), ('older-squat', 'older', 0);
  INSERT INTO activity_set VALUES
    ('warm-up', 'newest-squat', 0, 'warm_up', 10, NULL),
    ('first', 'newest-squat', 1, 'normal', 8, NULL),
    ('older-set', 'older-squat', 0, 'normal', 5, NULL);
`);
EOF
node "$root/history-fixture.cjs" "$history_fixture" 2>/dev/null

for ((element = 100; element < 10100; element++)); do
  echo "@e$element [other] \"element-$element\""
done >"$root/snapshot-tail"

# Stands in for the bound command on the Progress screens. It counts 300 workouts,
# 299 after a press on Delete workout and 300 again after Undo, unless
# FAKE_UNDO_BROKEN. The set reads its new weight after Save unless FAKE_EDIT_LOST.
# The history list shows no row after FAKE_BLANK_AFTER scrolls, and shows the
# oldest workout after FAKE_OLDEST_AFTER scrolls, by default 120, or never when it
# is "never". Every element has the same frame, except that with FAKE_ROUTINE_LOW
# Save as routine sits at the screen's bottom edge until a drag moves it up.
cat >"$fake/history-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
state="$root/history-state"
mkdir -p "\$state"
flag() { [[ -e "\$state/\$1" ]]; }
args=" \$* "
case "\$args" in
  *" get attrs "*)
    echo "\$*" >"\$state/last-attrs"
    if [[ -n "\${FAKE_ROUTINE_LOW:-}" && "\$args" == *workout-save-routine* ]] &&
      ! grep -q ' gesture pan ' "$root/bound-calls"; then
      echo '{"label": "Save as routine", "rect": {"x": 20, "y": 905, "width": 400, "height": 50}}'
    else
      echo '{"label": "Save", "rect": {"x": 20, "y": 300, "width": 120, "height": 40}}'
    fi ;;
  *" press "*)
    attrs=\$(cat "\$state/last-attrs" 2>/dev/null || true)
    case "\$attrs" in
      *workout-delete*) touch "\$state/deleted" ;;
      *undo-delete*) [[ -n "\${FAKE_UNDO_BROKEN:-}" ]] || rm -f "\$state/deleted"; touch "\$state/undone" ;;
      *set-edit-save*) [[ -n "\${FAKE_EDIT_LOST:-}" ]] || touch "\$state/edited" ;;
      *workout-save-routine*) touch "\$state/routine" ;;
    esac ;;
  *' get text id="workout-counts" '*)
    # The first read after a delete still shows the counts loading, as on iOS.
    if flag deleted && [[ ! -e "\$state/counts-loading" ]]; then
      touch "\$state/counts-loading"
      echo "Opening the database"
    elif flag deleted; then echo "299 workouts, 6000 sets"; else echo "300 workouts, 6023 sets"; fi ;;
  *' get text id="set-first" '*)
    if flag edited; then echo "Set 1, 222.5 kg × 8, Heaviest weight record"; else echo "Set 1, 92.5 kg × 8"; fi ;;
  *' get text id="workout-records" '*) echo "Records, 3" ;;
  *' get text id="calendar-month" '*) echo "October 2026" ;;
  *' get text id="calendar-count" '*) echo "13 workouts in October 2026" ;;
  *' wait id="history-row" '*) exit 1 ;;
  *' is visible id="history-row" '*)
    # The first row starts below the fold until a scroll brings it up, and once rows
    # show there are two on screen, which makes the selector ambiguous, as on iOS.
    grep -q -- '--until id="history-row"' "$root/bound-calls" || exit 1
    echo "Error (AMBIGUOUS_MATCH): Selector matched 2 elements" >&2
    exit 1 ;;
  *" snapshot "*)
    scrolls=\$(grep -c ' scroll down\$' "$root/bound-calls" || true)
    if [[ -z "\${FAKE_BLANK_AFTER:-}" ]] || ((scrolls < FAKE_BLANK_AFTER)); then
      echo '@e11 [other] "history-row"'
      echo '@e13 [other] "history-row"'
    fi
    # The rest of the screen's tree, more than a pipe holds, as a real snapshot can be.
    cat "$root/snapshot-tail" ;;
  *' is visible id="workout-older" '*)
    scrolls=\$(grep -c ' scroll down\$' "$root/bound-calls" || true)
    oldest_after=\${FAKE_OLDEST_AFTER:-120}
    [[ "\$oldest_after" != never ]] && ((scrolls >= oldest_after)) ;;
  *' wait id="undo-delete-banner" '*) flag deleted ;;
  *' wait absent id="undo-delete-banner" '*) flag undone ;;
  *' wait id="routine-saved" '*) flag routine ;;
esac
EOF
chmod +x "$fake/history-device"

# run_history [VAR=value...] [history.sh args...] leaves the exit status in history_status.
run_history() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/history-state" "$root/data container"
  history_status=0
  env PATH="$fake:$PATH" FAKE_FIXTURE_DB="$history_fixture" \
    SVETT_DEVICE_CMD="history-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/history.sh" "$@" >"$output" 2>&1 || history_status=$?
}

history_sh() {
  run_history "$@"
  [[ "$history_status" == 0 ]] || fail "history.sh $* failed"
}

history_failed() {
  [[ "$history_status" != 0 ]] || fail "history.sh succeeded"
  grep -qF -- "$1" "$output" || fail "history.sh did not say \"$1\""
}

# only_screen_presses_at_centres checks every press is the Progress tab by selector or a point.
only_screen_presses_at_centres() {
  if grep -E -- "^$bound_prefix press " "$root/bound-calls" |
    grep -vxF -e "$bound_prefix press label=\"Progress, tab, 3 of 5\"" -e "$bound_prefix $centre_press" >>"$output"; then
    fail "history.sh pressed screen content by selector"
  fi
}

history_links=(
  "com.kron00.svett svett://workout/newest"
  "com.kron00.svett svett://workout/newest/set/first"
  "com.kron00.svett svett://calendar?month=2026-10"
)
history_fixture_args="--launch-args=-svettFixture --launch-args=$root/data container/Documents/svett-fixture.db"

case_name="history.sh Debug with SVETT_DEVICE_CMD"
history_sh "$root/history"
check "history.sh copies the generated fixture into the app's data container" \
  cmp -s "$history_fixture" "$root/data container/Documents/svett-fixture.db"
check "history.sh relaunches into the dev client on the fixture, then opens the newest workout, its first normal set and the calendar" \
  only_open "$debug_open $history_fixture_args" "${history_links[@]}"
check "history.sh shoots at the largest text size, then restores the default" \
  only_calls "settings" "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "history.sh scrolls the history list until the oldest workout's row is on screen" \
  test "$(grep -cxF -- "$bound_prefix scroll down" "$root/bound-calls")" -eq 120
check "history.sh looks for rows in a snapshot after each scroll" \
  test "$(grep -cxF -- "$bound_prefix snapshot" "$root/bound-calls")" -eq 120
check "history.sh clears the weight and types 222.5 on the keypad" \
  only_calls "get attrs label" \
  'get attrs label="Delete"' 'get attrs label="Delete"' 'get attrs label="Delete"' 'get attrs label="Delete"' \
  'get attrs label="Delete"' 'get attrs label="Delete"' 'get attrs label="Delete"' \
  'get attrs label="2"' 'get attrs label="2"' 'get attrs label="2"' \
  'get attrs label="Decimal point"' 'get attrs label="5"'
check "history.sh saves the set, the routine, deletes and undoes, in that order" \
  only_calls "get attrs id" 'get attrs id="set-edit-save"' 'get attrs id="workout-save-routine"' \
  'get attrs id="workout-delete"' 'get attrs id="undo-delete"'
check "history.sh reads the edited set back from the workout's detail" bound_got "$bound_prefix get text id=\"set-first\""
check "history.sh presses tabs by selector and screen content only at an element's centre" \
  only_screen_presses_at_centres
check "history.sh screenshots each step of the proof" \
  only_calls "screenshot" \
  "screenshot $root/history/01-history.png" "screenshot $root/history/02-history-scroll-50.png" \
  "screenshot $root/history/03-history-scroll-100.png" "screenshot $root/history/04-history-oldest.png" \
  "screenshot $root/history/05-workout.png" "screenshot $root/history/06-muscle-split.png" \
  "screenshot $root/history/07-set-before-edit.png" "screenshot $root/history/08-set-edit.png" \
  "screenshot $root/history/09-set-typed.png" "screenshot $root/history/10-set-edited.png" \
  "screenshot $root/history/11-records.png" "screenshot $root/history/12-saved-as-routine.png" \
  "screenshot $root/history/13-deleted.png" "screenshot $root/history/14-undone.png" \
  "screenshot $root/history/15-calendar.png" "screenshot $root/history/16-calendar-month.png"
check "history.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="history.sh Release with SVETT_DEVICE_CMD"
history_sh --release "$root/history-release"
check "history.sh Release relaunches the installed app on the fixture without Metro" \
  only_open "com.kron00.svett --relaunch $history_fixture_args" "${history_links[@]}"

case_name="history.sh when Save as routine sits at the screen's bottom edge"
history_sh FAKE_ROUTINE_LOW=1 "$root/history-low"
check "history.sh drags a control up from the bottom edge before pressing it" \
  only_calls "gesture pan" "gesture pan 20 600 0 -300 400"
check "history.sh presses Save as routine only once it is clear of the bottom edge" \
  test "$(grep -cxF -- "$bound_prefix press 220 930" "$root/bound-calls")" -eq 0

case_name="history.sh when the history list goes blank"
run_history FAKE_BLANK_AFTER=12 "$root/history-blank"
check "history.sh fails on a screen of the history list with no row" \
  history_failed "The history list showed no row after scroll 12"
check "history.sh screenshots the blank screen" \
  bound_got "$bound_prefix screenshot $root/history-blank/02-blank-after-scroll-12.png"
check "history.sh restores the default text size after a failure" \
  only_calls "settings" "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="history.sh when the oldest workout never shows"
run_history FAKE_OLDEST_AFTER=never "$root/history-endless"
check "history.sh fails after 600 scrolls without the oldest workout" \
  history_failed "The oldest workout was not on screen after 600 scrolls"
check "history.sh screenshots where the list stopped" \
  bound_got "$bound_prefix screenshot $root/history-endless/14-history-no-end.png"

case_name="history.sh when the edit does not show"
run_history FAKE_EDIT_LOST=1 "$root/history-edit"
check "history.sh fails when the detail does not show the edited set" \
  history_failed 'Expected id="set-first" to show "222.5 kg × 8"'

case_name="history.sh when Undo does not bring the workout back"
run_history FAKE_UNDO_BROKEN=1 "$root/history-undo"
check "history.sh fails when the count does not come back to 300" \
  history_failed 'Expected id="workout-counts" to show "300 workouts"'
# Stands in for swift on the Mac. FAKE_SWIFT_FAIL fails the tests.
cat >"$fake/swift" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/swift-calls"
echo "fake swift test output"
[[ -z "\${FAKE_SWIFT_FAIL:-}" ]]
EOF

# Stands in for the bound command on the ChatGPT settings. Every element has the same
# frame, every wait succeeds except one for text containing FAKE_MISSING, the signed-in
# state is always on screen, and no system alert shows. Pressing Sign out, or scrolling
# down to an element below the fold, scrolls the signed-out state above the screen until a
# scroll up or a relaunch brings it back. Only the signed-in state counts as visible, so
# every other element is reached by a scroll.
cat >"$fake/chatgpt-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
args=" \$* "
case "\$args" in
  *" get attrs "*)
    echo "\$args" >"$root/chatgpt-last-attrs"
    echo '{"rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" press "[0-9]*)
    [[ "\$(cat "$root/chatgpt-last-attrs" 2>/dev/null)" != *chatgpt-sign-out* ]] || touch "$root/chatgpt-scrolled" ;;
  *' scroll up --until id="chatgpt-state-signedOut"'*|*" open "*" --relaunch "*) rm -f "$root/chatgpt-scrolled" ;;
  *" scroll down 0.3 --until "*) touch "$root/chatgpt-scrolled" ;;
  *' wait id="chatgpt-state-signedOut"'*)
    [[ ! -e "$root/chatgpt-scrolled" ]] && [[ -z "\${FAKE_MISSING:-}" || "\$args" != *"\$FAKE_MISSING"* ]] ;;
  *" is visible "*) [[ "\$args" == *chatgpt-state-signedIn* ]] ;;
  *" alert wait "*) exit 1 ;;
  *" wait "*) [[ -z "\${FAKE_MISSING:-}" || "\$args" != *"\$FAKE_MISSING"* ]] ;;
esac
EOF
chmod +x "$fake/swift" "$fake/chatgpt-device"

# run_chatgpt [VAR=value...] [chatgpt.sh args...] leaves the exit status in chatgpt_status.
run_chatgpt() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -f "$root/simctl-calls" "$root/bound-calls" "$root/swift-calls" "$root/chatgpt-scrolled"
  chatgpt_status=0
  env PATH="$fake:$PATH" HOME="$root/home" \
    SVETT_DEVICE_CMD="chatgpt-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/chatgpt.sh" "$@" >"$output" 2>&1 || chatgpt_status=$?
}

chatgpt_sh() {
  run_chatgpt "$@"
  [[ "$chatgpt_status" == 0 ]] || fail "chatgpt.sh $* failed"
}

stub() { echo "--launch-args=-svettChatGPTStub --launch-args=$1"; }
chatgpt_link="com.kron00.svett svett://chatgpt"
scenarios=(signedOut noPlanUsage renews lapsed badSignature wrongAudience expiredToken revokeFails twoAccounts signedOut)

# stand_in_opens <relaunch> <front> lists the opens of a run through every scenario.
stand_in_opens() {
  local scenario
  for scenario in "${scenarios[@]}"; do
    echo "$1 $(stub "$scenario")"
    echo "$chatgpt_link"
  done
  echo "$2"
}

case_name="chatgpt.sh Debug with SVETT_DEVICE_CMD"
chatgpt_sh "$root/chatgpt"
check "chatgpt.sh runs the Swift tests with their build outside the repo, and saves their output" \
  grep -qxF "test --package-path $repo/apps/mobile/modules/svett-native/ios/ChatGPTCore --scratch-path $root/home/svett-app-build/chatgpt-core" "$root/swift-calls"
check "chatgpt.sh saves the Swift test output" grep -qxF "fake swift test output" "$root/chatgpt/swift-test.txt"
mapfile -t expected_opens < <(stand_in_opens "$debug_open" "$debug_front")
check "chatgpt.sh relaunches into the dev client once per stand-in scenario and opens the ChatGPT settings by link" \
  only_open "${expected_opens[@]}"
check "chatgpt.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "chatgpt.sh presses screen content only at an element's centre, which agent-device does not refuse on iOS 27" \
  test "$(grep -E -- "^$bound_prefix press " "$root/bound-calls" | grep -cvxF -- "$bound_prefix press 80 320")" -eq 0
check "chatgpt.sh signs in, signs out, allows plan usage, signs out unconfirmed, returns to an earlier account and signs in with Safari, in that order" \
  only_calls "get attrs" \
  'get attrs id="chatgpt-continue"' 'get attrs id="chatgpt-sign-out"' 'get attrs id="chatgpt-allow"' \
  'get attrs id="chatgpt-continue"' 'get attrs id="chatgpt-continue"' 'get attrs id="chatgpt-continue"' \
  'get attrs id="chatgpt-sign-out"' 'get attrs id="chatgpt-account-0"' 'get attrs id="chatgpt-safari"'
check "chatgpt.sh checks each refusal names its reason" \
  only_calls "wait text .*(match|another app|expired)" \
  "wait text does not match OpenAI's published keys 15000" "wait text was made for another app 15000" \
  "wait text has expired 15000"
check "chatgpt.sh screenshots each state" \
  only_calls "screenshot" \
  "screenshot $root/chatgpt/01-signed-out.png" "screenshot $root/chatgpt/02-signed-in.png" \
  "screenshot $root/chatgpt/03-signed-out-keeps-account.png" "screenshot $root/chatgpt/04-no-plan-usage.png" \
  "screenshot $root/chatgpt/05-plan-usage-allowed.png" "screenshot $root/chatgpt/06-renewed.png" \
  "screenshot $root/chatgpt/07-lapsed.png" "screenshot $root/chatgpt/08-refused-badSignature.png" \
  "screenshot $root/chatgpt/09-refused-wrongAudience.png" "screenshot $root/chatgpt/10-refused-expiredToken.png" \
  "screenshot $root/chatgpt/11-revocation-unconfirmed.png" "screenshot $root/chatgpt/12-two-accounts.png" \
  "screenshot $root/chatgpt/13-returned-to-earlier-account.png" "screenshot $root/chatgpt/14-safari.png" \
  "screenshot $root/chatgpt/15-safari-signed-in.png"
# shot_after <call> <screenshot>: the bound command got <call> right before <screenshot>.
shot_after() {
  local before
  before=$(grep -B1 -xF -- "$bound_prefix screenshot $2" "$root/bound-calls" | head -1)
  [[ "$before" == "$bound_prefix $1" ]] || {
    echo "before $2: $before" >>"$output"
    fail "$2 was not shot right after: $1"
  }
}
check "chatgpt.sh shoots the renewed sign-in after scrolling to the notice below its Sign-in row" \
  shot_after 'scroll down 0.3 --until id="chatgpt-notice"' "$root/chatgpt/06-renewed.png"
for shot in 07-lapsed 08-refused-badSignature 09-refused-wrongAudience 10-refused-expiredToken; do
  check "chatgpt.sh shoots $shot after scrolling to Continue with ChatGPT, below the text it proves" \
    shot_after 'scroll down 0.3 --until id="chatgpt-continue"' "$root/chatgpt/$shot.png"
done
check "chatgpt.sh checks the state before the refusal, so no scroll back up hides the refusal" \
  only_calls "wait (id=\"chatgpt-state-signedOut\"|text (does not match|was made|has expired))" \
  'wait id="chatgpt-state-signedOut" 15000' 'wait id="chatgpt-state-signedOut" 15000' \
  'wait id="chatgpt-state-signedOut" 15000' 'wait id="chatgpt-state-signedOut" 15000' \
  "wait text does not match OpenAI's published keys 15000" \
  'wait id="chatgpt-state-signedOut" 15000' "wait text was made for another app 15000" \
  'wait id="chatgpt-state-signedOut" 15000' "wait text has expired 15000" \
  'wait id="chatgpt-state-signedOut" 15000'
check "chatgpt.sh with SVETT_DEVICE_CMD never calls simctl" test ! -e "$root/simctl-calls"

case_name="chatgpt.sh Release with SVETT_DEVICE_CMD"
chatgpt_sh --release "$root/chatgpt-release"
mapfile -t expected_opens < <(stand_in_opens "com.kron00.svett --relaunch" com.kron00.svett)
check "chatgpt.sh Release relaunches the installed app without Metro" only_open "${expected_opens[@]}"

case_name="chatgpt.sh when an expected message does not show"
run_chatgpt FAKE_MISSING="has expired" "$root/chatgpt-missing"
check "chatgpt.sh fails when a refusal does not show" test "$chatgpt_status" -ne 0
check "chatgpt.sh names what did not show" grep -qF "Expected the expiredToken refusal, which did not show" "$output"
check "chatgpt.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="chatgpt.sh when the Swift tests fail"
run_chatgpt FAKE_SWIFT_FAIL=1 "$root/chatgpt-swift"
check "chatgpt.sh fails when the Swift tests fail" test "$chatgpt_status" -ne 0
check "chatgpt.sh opens nothing when the Swift tests fail" test ! -e "$root/bound-calls"

case_name="chatgpt.sh --live"
chatgpt_sh --release --live "$root/chatgpt-live"
check "chatgpt.sh --live skips the Swift tests" test ! -e "$root/swift-calls"
check "chatgpt.sh --live opens the real sign-in, with no stand-in" \
  only_open "com.kron00.svett --relaunch" "$chatgpt_link"
check "chatgpt.sh --live signs out an earlier sign-in, then waits 10 minutes for a person to sign in" \
  only_calls "get attrs|wait id=\"chatgpt-state-signedIn\"" \
  'get attrs id="chatgpt-sign-out"' 'get attrs id="chatgpt-continue"' \
  'wait id="chatgpt-state-signedIn" 600000' 'get attrs id="chatgpt-sign-out"'

# Stands in for the bound command on the coach. The question field is two lines tall at
# the largest text size, or FAKE_FIELD_HEIGHT, with Send under it above the tab bar. Every
# other element has the same frame, every wait succeeds except one containing
# FAKE_MISSING, the coach's answer is on screen, and opening the ask link writes
# FAKE_RECORDING, as a live run would.
cat >"$fake/coach-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
args=" \$* "
case "\$args" in
  *" get attrs id=\"coach-input\" "*)
    echo "{\"rect\": {\"x\": 16, \"y\": 560, \"width\": 408, \"height\": \${FAKE_FIELD_HEIGHT:-172}}}" ;;
  *" get attrs id=\"coach-send\" "*) echo '{"rect": {"x": 16, "y": 740, "width": 408, "height": 86}}' ;;
  *" get attrs label=\"You, tab, 5 of 5\" "*) echo '{"rect": {"x": 352, "y": 874, "width": 88, "height": 48}}' ;;
  *" get attrs "*) echo '{"rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" open "*"svett://coach?ask="*) [[ -z "\${FAKE_RECORDING:-}" ]] || echo '{"source": "live"}' >"\$FAKE_RECORDING" ;;
  *" is visible "*) [[ "\$args" == *coach-answer* ]] ;;
  *" wait "*) [[ -z "\${FAKE_MISSING:-}" || "\$args" != *"\$FAKE_MISSING"* ]] ;;
esac
EOF
chmod +x "$fake/coach-device"

# run_coach [VAR=value...] [coach.sh args...] leaves the exit status in coach_status.
run_coach() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -f "$root/simctl-calls" "$root/bound-calls" "$root/swift-calls"
  coach_status=0
  env PATH="$fake:$PATH" HOME="$root/home" \
    SVETT_DEVICE_CMD="coach-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/coach.sh" "$@" >"$output" 2>&1 || coach_status=$?
}

documents="$root/data container/Documents"
coach_fixture="--launch-args=-svettFixture --launch-args=$documents/svett-fixture.db"
coach_signed_in="--launch-args=-svettChatGPTStub --launch-args=signedIn"
ask_link="com.kron00.svett svett://coach?ask=What%20was%20my%20best%20squat%20set%20last%20month%3F"

case_name="coach.sh Debug with SVETT_DEVICE_CMD"
run_coach "$root/coach"
[[ "$coach_status" == 0 ]] || fail "coach.sh failed"
check "coach.sh runs the Swift tests and saves their output" \
  grep -qxF "fake swift test output" "$root/coach/swift-test.txt"
check "coach.sh copies the generated fixture and both stand-ins into the app's data container" \
  test "$(cat "$documents/svett-fixture.db")" == "fake fixture" -a \
  -s "$documents/coach-best-squat.json" -a -s "$documents/coach-plan-limit.json"
check "coach.sh relaunches on the fixture once per state, then opens the coach or asks by link" \
  only_open \
  "$debug_open $coach_fixture --launch-args=-svettChatGPTStub --launch-args=signedOut" \
  "com.kron00.svett svett://coach" \
  "$debug_open $coach_fixture --launch-args=-svettChatGPTStub --launch-args=noPlanUsage" \
  "com.kron00.svett svett://coach" \
  "$debug_open $coach_fixture $coach_signed_in --launch-args=-svettCoachStub --launch-args=$documents/coach-best-squat.json" \
  "$ask_link" \
  "$debug_open $coach_fixture $coach_signed_in --launch-args=-svettCoachStub --launch-args=$documents/coach-plan-limit.json" \
  "$ask_link"
check "coach.sh checks the answer names the best set and the data the tools read" \
  only_calls "wait text" \
  "wait text Go, Plus, Pro and Business 15000" "wait text 117.5 kg for 8 reps 15000" \
  "wait text Best sets of Barbell Squat, 2026-10-01 to 2026-10-31 15000" \
  "wait text reached your ChatGPT plan's limit 15000"
check "coach.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "coach.sh screenshots each state" \
  only_calls "screenshot" \
  "screenshot $root/coach/01-signed-out.png" "screenshot $root/coach/02-no-plan-usage.png" \
  "screenshot $root/coach/03-answer.png" "screenshot $root/coach/04-composer.png" \
  "screenshot $root/coach/05-plan-limit.png"
check "coach.sh measures the question field, Send and the tab bar under the answer" \
  only_calls "get attrs" \
  'get attrs id="coach-input"' 'get attrs id="coach-send"' 'get attrs label="You, tab, 5 of 5"'
check "coach.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="coach.sh Release with SVETT_DEVICE_CMD"
run_coach --release "$root/coach-release"
[[ "$coach_status" == 0 ]] || fail "coach.sh --release failed"
check "coach.sh Release relaunches the installed app without Metro" \
  bound_got "$bound_prefix open com.kron00.svett --relaunch $coach_fixture --launch-args=-svettChatGPTStub --launch-args=signedOut"

case_name="coach.sh when the answer does not show what it read"
run_coach FAKE_MISSING="Best sets of Barbell Squat" "$root/coach-missing"
check "coach.sh fails when the answer's data does not show" test "$coach_status" -ne 0
check "coach.sh names what did not show" \
  grep -qF "Expected the best sets the tools read from the fixture, which did not show" "$output"
check "coach.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="coach.sh when the question field is clipped"
run_coach FAKE_FIELD_HEIGHT=44 "$root/coach-clipped"
check "coach.sh fails when the question field stays at its minimum height" test "$coach_status" -ne 0
check "coach.sh says the question field is clipped" \
  grep -qF "The composer is not whole: the question field is 44 points tall, so its text is clipped" "$output"
check "coach.sh keeps the composer screenshot of a clipped field and stops before the plan's limit" \
  only_calls "screenshot" \
  "screenshot $root/coach-clipped/01-signed-out.png" "screenshot $root/coach-clipped/02-no-plan-usage.png" \
  "screenshot $root/coach-clipped/03-answer.png" "screenshot $root/coach-clipped/04-composer.png"

case_name="coach.sh when the Swift tests fail"
run_coach FAKE_SWIFT_FAIL=1 "$root/coach-swift"
check "coach.sh fails when the Swift tests fail" test "$coach_status" -ne 0
check "coach.sh opens nothing when the Swift tests fail" test ! -e "$root/bound-calls"

case_name="coach.sh --live"
run_coach FAKE_RECORDING="$documents/coach-live.json" --release --live "$root/coach-live"
[[ "$coach_status" == 0 ]] || fail "coach.sh --live failed"
check "coach.sh --live skips the Swift tests" test ! -e "$root/swift-calls"
check "coach.sh --live records against OpenAI with no stand-in, then asks by link" \
  only_open \
  "com.kron00.svett --relaunch $coach_fixture --launch-args=-svettCoachRecord --launch-args=$documents/coach-live.json" \
  "com.kron00.svett svett://coach" "$ask_link"
check "coach.sh --live saves the recorded exchange in out-dir" \
  grep -qF '"source": "live"' "$root/coach-live/coach-live.json"

case_name="coach.sh --live when svett recorded nothing"
run_coach --release --live "$root/coach-live-empty"
check "coach.sh --live fails without a recording" test "$coach_status" -ne 0
check "coach.sh --live says nothing was recorded" grep -qF "svett recorded no exchange" "$output"

# Stands in for the bound command while routines.sh builds and starts a routine.
# It keeps the screen in front, the routine being edited, the saved routine and
# the workout in progress as files under $FAKE_STATE. An element is on screen
# only where the app would show it, and a set row's label is its target. A press
# acts on the element whose frame was read last. A relaunch keeps the saved
# routine unless FAKE_FORGETS is set. FAKE_NO_TARGETS starts a workout whose sets
# are empty, and FAKE_LIBRARY names the picker's first result. It keeps the
# screens a link opened in front of each other in stack, and writes the screen
# under each new routine editor to editor-over. The Train tab shows the
# cold start time when the app was launched with -svettTiming 1, unless
# FAKE_NO_TIMING is set. FAKE_TIMING_LABEL replaces its text. As at the largest
# text size, the Train tab shows Start empty workout or the workout in progress
# at its top and the routines and the time below the screen, until a scroll down
# reaches them. It keeps its scroll until a relaunch, scroll top or a scroll up.
cat >"$fake/routines-device" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_ROOT/bound-calls"
shift 4
s=$FAKE_STATE
mkdir -p "$s"
get() { cat "$s/$1" 2>/dev/null || true; }
put() { printf '%s\n' "$2" >"$s/$1"; }
screen=$(get screen)
screen=${screen:-home}
decode() { node -e 'process.stdout.write(decodeURIComponent(process.argv[1]))' "$1"; }
set_label() {
  local weight reps_min reps_max
  IFS='|' read -r weight reps_min reps_max <<<"$1"
  echo "Set $2, $weight kg, $reps_min to $reps_max reps"
}
# set_row <file> <selector> [suffix]: the selector names a set of the file by its
# place and its label.
set_row() {
  local index line
  index=${2#*-0-}
  index=${index%%\"*}
  line=$(sed -n "$((index + 1))p" "$s/$1" 2>/dev/null)
  [[ -n "$line" ]] || return 1
  [[ "$2" != *label=* || "$2" == *"label=\"$(set_label "$line" $((index + 1)))${3:-}\"" ]]
}
holds() {
  case "$1" in
    'label="Train, tab, 2 of 5"') [[ "$screen" != home ]] ;;
    'id="routine-list"') [[ "$screen" == train ]] ;;
    'id="cold-start-timing"') [[ "$screen" == train && -f "$s/timing" && -z "${FAKE_NO_TIMING:-}" ]] ;;
    'id="workout-in-progress-row"') [[ "$screen" == train && -s "$s/workout" ]] ;;
    'id="start-empty-workout"') [[ "$screen" == train && ! -s "$s/workout" ]] ;;
    'id="routine-row" label='*)
      [[ "$screen" == train && "$1" == "id=\"routine-row\" label=\"$(get saved_name), $(get saved_exercise)\"" ]] ;;
    'id="workout"') [[ "$screen" == workout ]] ;;
    'id="workout-title"' | 'id="discard-workout"') [[ "$screen" == workout && -s "$s/workout" ]] ;;
    'id="workout-title" label='*) [[ "$screen" == workout && "$1" == "id=\"workout-title\" label=\"$(get workout)\"" ]] ;;
    'id="workout-set-0-'*) [[ "$screen" == workout ]] && set_row workout_sets "$1" ", To do" ;;
    'label="No workout in progress"') [[ "$screen" == workout && ! -s "$s/workout" ]] ;;
    'label="Discard"') [[ -f "$s/alert" ]] ;;
    'id="routine-editor"' | 'id="add-set-0"' | 'id="save-routine"') [[ "$screen" == editor ]] ;;
    'id="routine-exercise-0"') [[ "$screen" == editor && -s "$s/draft_exercise" ]] ;;
    'id="routine-set-0-'*)
      case $screen in
        editor) set_row draft_sets "$1" ;;
        detail) set_row saved_sets "$1" ;;
        *) return 1 ;;
      esac ;;
    'id="exercise-library"') [[ "$screen" == picker ]] ;;
    'id="exercise-result-0"') [[ "$screen" == picker ]] ;;
    'id="set-target"' | 'id="target-'* | 'id="key-'* | 'id="save-set"') [[ "$screen" == set-target ]] ;;
    'id="routine-detail"' | 'id="start-routine"') [[ "$screen" == detail ]] ;;
    'id="routine-title" label='*) [[ "$screen" == detail && "$1" == "id=\"routine-title\" label=\"$(get saved_name)\"" ]] ;;
    *) return 1 ;;
  esac
}
# below <selector>: on the Train tab, the element sits below the screen until a scroll down.
below() {
  case "$1" in
    'id="routine-list"' | 'id="routine-row"'* | 'id="cold-start-timing"') return 0 ;;
    *) return 1 ;;
  esac
}
# shows <selector>: the element, or one of a || fallback's, is on screen.
shows() {
  local one
  while IFS= read -r one; do
    holds "$one" || continue
    [[ "$screen" == train ]] || return 0
    case "$one" in
      'id="start-empty-workout"' | 'id="workout-in-progress-row"') [[ ! -f "$s/down" ]] && return 0 ;;
      *) { ! below "$one" || [[ -f "$s/down" ]]; } && return 0 ;;
    esac
  done < <(sed 's/ || /\n/g' <<<"$1")
  return 1
}
press() {
  local target
  target=$(get target)
  case "$target" in
    'id="exercise-result-0"')
      put draft_exercise "${FAKE_LIBRARY:-Barbell Squat}"
      put draft_sets "||"
      put screen editor ;;
    'id="routine-set-0-0"')
      rm -f "$s/weight" "$s/from" "$s/to"
      put screen set-target ;;
    'id="target-weight"') put focused weight ;;
    'id="target-reps-from"') put focused from ;;
    'id="target-reps-to"') put focused to ;;
    'id="key-'*)
      key=${target#id=\"key-}
      printf '%s' "${key%\"}" >>"$s/$(get focused)" ;;
    'id="save-set"')
      { echo "$(get weight)|$(get from)|$(get to)"; sed 1d "$s/draft_sets"; } >"$s/sets.new"
      mv "$s/sets.new" "$s/draft_sets"
      put screen editor ;;
    'id="add-set-0"') tail -1 "$s/draft_sets" >>"$s/draft_sets" ;;
    'id="save-routine"')
      cp "$s/draft_name" "$s/saved_name"
      cp "$s/draft_exercise" "$s/saved_exercise"
      cp "$s/draft_sets" "$s/saved_sets"
      put screen detail ;;
    'id="routine-row" label='*) put screen detail ;;
    'id="start-routine"')
      cp "$s/saved_name" "$s/workout"
      if [[ -n "${FAKE_NO_TARGETS:-}" ]]; then
        sed 's/.*/||/' "$s/saved_sets" >"$s/workout_sets"
      else
        cp "$s/saved_sets" "$s/workout_sets"
      fi
      put screen workout ;;
    'id="discard-workout"') touch "$s/alert" ;;
    # Discard goes back to the Train tab. FAKE_KEEPS_WORKOUT leaves the workout in progress.
    'label="Discard"')
      rm -f "$s/alert"
      [[ -n "${FAKE_KEEPS_WORKOUT:-}" ]] || rm -f "$s/workout" "$s/workout_sets"
      sed '$d' "$s/stack" >"$s/stack.new"
      mv "$s/stack.new" "$s/stack"
      put screen train ;;
    *) exit 1 ;;
  esac
}
case "$1" in
  settings | screenshot) ;;
  open)
    case "$3" in
      --relaunch)
        put screen tabs
        put stack tabs
        rm -f "$s/down"
        if [[ "$*" == *"--launch-args=-svettTiming --launch-args=1"* ]]; then touch "$s/timing"; else rm -f "$s/timing"; fi
        [[ -z "${FAKE_FORGETS:-}" ]] || rm -f "$s/saved_name" "$s/saved_exercise" "$s/saved_sets" ;;
      # A link to a tab pops every screen above the tabs.
      svett://train)
        put screen train
        put stack train ;;
      svett://train/workout)
        put screen workout
        echo workout >>"$s/stack" ;;
      svett://routines/new\?title=*)
        tail -1 "$s/stack" >>"$s/editor-over"
        put draft_name "$(decode "${3#*title=}")"
        rm -f "$s/draft_exercise" "$s/draft_sets"
        put screen editor ;;
      svett://routines/new/exercises\?q=*) put screen picker ;;
      *) exit 1 ;;
    esac ;;
  wait) [[ "$2" =~ ^[0-9]+$ ]] || shows "$2" ;;
  is) shows "$3" ;;
  scroll)
    if [[ "$2" == top ]]; then
      rm -f "$s/down"
    else
      holds "$4" || exit 1
      if [[ "$screen" == train ]]; then
        if below "$4"; then
          [[ "$2" == down || -f "$s/down" ]] || exit 1
          touch "$s/down"
        elif [[ "$4" == 'id="start-empty-workout"' || "$4" == 'id="workout-in-progress-row"' ]]; then
          [[ "$2" == up || ! -f "$s/down" ]] || exit 1
          rm -f "$s/down"
        fi
      fi
    fi ;;
  get)
    holds "$3" || exit 1
    put target "$3"
    if [[ "$3" == 'id="exercise-result-0"' ]]; then
      printf '{"label": "%s, Quadriceps · Barbell", "rect": {"x": 0, "y": 200, "width": 440, "height": 80}}\n' \
        "${FAKE_LIBRARY:-Barbell Squat}"
    elif [[ "$3" == 'id="cold-start-timing"' ]]; then
      label="Cold start: 1540 ms, from process start to the first frame with the Train tab's routine list. This launch opened on another tab first, so the number includes the time until the Train tab opened, and the 2 second target does not judge it."
      node -e 'console.log(JSON.stringify({ label: process.argv[1], rect: { x: 16, y: 800, width: 408, height: 120 } }))' \
        "${FAKE_TIMING_LABEL:-$label}"
    else
      echo '{"label": "", "rect": {"x": 16, "y": 600, "width": 408, "height": 50}}'
    fi ;;
  press) press ;;
  alert)
    # svett's own alerts have no button agent-device's alert accept can find.
    case "$2" in
      wait) [[ -f "$s/alert" ]] ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fake/routines-device"

# run_routines [VAR=value...] [routines.sh args...] leaves the exit status in routines_status.
# FAKE_STATE carries over between runs unless the caller clears it.
run_routines() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -f "$root/simctl-calls" "$root/bound-calls"
  routines_status=0
  env PATH="$fake:$PATH" FAKE_ROOT="$root" FAKE_STATE="$root/routines-state" \
    SVETT_DEVICE_CMD="routines-device --session 't3-test session' --device FAKE-UDID" \
    SVETT_ROUTINE_NAME="Proof routine 1" "${vars[@]}" "$repo/scripts/sim/routines.sh" "$@" \
    >"$output" 2>&1 || routines_status=$?
}

routine_links=("com.kron00.svett svett://train" "com.kron00.svett svett://train/workout"
  "com.kron00.svett svett://train"
  "com.kron00.svett svett://routines/new?title=Proof%20routine%201"
  "com.kron00.svett svett://routines/new/exercises?q=barbell%20squat")
routine_target="60 kg, 8 to 12 reps"
timing_args="--launch-args=-svettTiming --launch-args=1"
fixture_args="--launch-args=-svettFixture --launch-args=$container_fixture $timing_args"
debug_fixture_open="$debug_open $fixture_args"
cold_start_lines=(
  "^agent-device's calls alone, against the running app: [0-9]+ ms$"
  "^The difference, an upper bound on svett's start-up that still includes the script's wait before it opens the Train tab: about -?[0-9]+ ms$"
)
fake_in_app="Cold start: 1540 ms, from process start to the first frame with the Train tab's routine list. This launch opened on another tab first, so the number includes the time until the Train tab opened, and the 2 second target does not judge it."

# cold_start_says <file> <build>: the cold start's upper bound, the automation's
# share, the difference, and the time the app measured itself, word for word as
# the Train tab shows it, in that order.
cold_start_says() {
  [[ "$(wc -l <"$1")" -eq 4 ]] &&
    sed -n 1p "$1" | grep -qE "^Cold start to the Train tab's routine list: [0-9]+ ms \($2, on the 300-workout fixture, an upper bound that includes agent-device's calls\)$" &&
    sed -n 2p "$1" | grep -qE "${cold_start_lines[0]}" &&
    sed -n 3p "$1" | grep -qE "${cold_start_lines[1]}" &&
    [[ "$(sed -n 4p "$1")" == "Measured in the app after the svett://train link, so startup.sh's time is the one the 2 second target judges: $fake_in_app" ]]
}

case_name="routines.sh Debug with SVETT_DEVICE_CMD"
rm -rf "$root/routines-state"
rm -f "$container_fixture"
run_routines "$root/routines"
[[ "$routines_status" == 0 ]] || fail "routines.sh failed"
check "routines.sh opens the new routine from the Train tab, not over the workout screen" \
  grep -qx train "$root/routines-state/editor-over"
check "routines.sh copies the generated fixture into the app's data container" \
  grep -qxF "fake fixture" "$container_fixture"
check "routines.sh builds a routine on the fixture, relaunches into the dev client and starts it from the Train tab" \
  only_open "$debug_fixture_open" "com.kron00.svett svett://train" "${routine_links[@]}" \
  "$debug_fixture_open" "com.kron00.svett svett://train" "com.kron00.svett svett://train"
check "routines.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size|settings appearance" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "routines.sh types the target on the keypad, one press at each key's centre" \
  only_calls 'get attrs id="(target|key)-' \
  'get attrs id="target-weight"' 'get attrs id="key-6"' 'get attrs id="key-0"' \
  'get attrs id="target-reps-from"' 'get attrs id="key-8"' \
  'get attrs id="target-reps-to"' 'get attrs id="key-1"' 'get attrs id="key-2"'
check "routines.sh checks every set of the workout is filled in from the routine" \
  only_calls 'is visible id="workout-set' \
  "is visible id=\"workout-set-0-0\" label=\"Set 1, $routine_target, To do\"" \
  "is visible id=\"workout-set-0-1\" label=\"Set 2, $routine_target, To do\"" \
  "is visible id=\"workout-set-0-2\" label=\"Set 3, $routine_target, To do\""
check "routines.sh screenshots each step" \
  only_calls "screenshot" \
  "screenshot $root/routines/01-train.png" "screenshot $root/routines/02-new-routine.png" \
  "screenshot $root/routines/03-pick-exercise.png" "screenshot $root/routines/04-set-target.png" \
  "screenshot $root/routines/05-routine-editor.png" "screenshot $root/routines/06-routine-detail.png" \
  "screenshot $root/routines/07-workout.png" \
  "screenshot $root/routines/08-train-workout-in-progress.png"
check "routines.sh saves a Debug build's cold start, agent-device's share, the difference and svett's own time" \
  cold_start_says "$root/routines/cold-start.txt" "Debug, loaded from Metro"
check "routines.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="routines.sh Release when an earlier run left its workout in progress"
rm -f "$root/routines-state/editor-over"
run_routines --release "$root/routines-release"
[[ "$routines_status" == 0 ]] || fail "routines.sh --release failed"
check "routines.sh Release relaunches the installed app on the fixture without Metro" \
  only_open "com.kron00.svett --relaunch $fixture_args" "com.kron00.svett svett://train" \
  "${routine_links[@]}" "com.kron00.svett --relaunch $fixture_args" \
  "com.kron00.svett svett://train" "com.kron00.svett svett://train"
check "routines.sh discards the earlier workout by pressing svett's own Discard button" \
  only_calls 'alert|get attrs (id="discard|label="Discard")' \
  'get attrs id="discard-workout"' "alert wait 5000" 'get attrs label="Discard"'
check "routines.sh scrolls to the top of the Train tab and waits for Start empty workout after the discard" \
  only_calls 'scroll top|wait id="start-empty-workout" [0-9]|wait label="No workout' \
  'scroll top' 'wait id="start-empty-workout" 10000' 'scroll top'
check "routines.sh opens the new routine from the Train tab after discarding the workout" \
  grep -qx train "$root/routines-state/editor-over"
check "routines.sh saves a Release build's cold start" \
  cold_start_says "$root/routines-release/cold-start.txt" Release

case_name="routines.sh Release on a fixture already in the data container"
rm -rf "$root/routines-state"
rm -f "$container_fixture"
run_routines SVETT_FIXTURE=/data/Documents/svett-fixture.db --release "$root/routines-fixture"
[[ "$routines_status" == 0 ]] || fail "routines.sh on SVETT_FIXTURE failed"
given_fixture_args="--launch-args=-svettFixture --launch-args=/data/Documents/svett-fixture.db $timing_args"
check "routines.sh relaunches on SVETT_FIXTURE every time" \
  only_open "com.kron00.svett --relaunch $given_fixture_args" "com.kron00.svett svett://train" \
  "${routine_links[@]}" "com.kron00.svett --relaunch $given_fixture_args" \
  "com.kron00.svett svett://train" "com.kron00.svett svett://train"
check "routines.sh with SVETT_FIXTURE neither generates nor copies a fixture" \
  test ! -e "$container_fixture" -a ! -e "$root/routines-fixture/svett-fixture.db"

case_name="routines.sh when Discard leaves the earlier workout in progress"
run_routines FAKE_KEEPS_WORKOUT=1 "$root/routines-keeps"
check "routines.sh fails when the discarded workout is still in progress" test "$routines_status" -ne 0
check "routines.sh says the earlier workout is still in progress" \
  grep -qxF "A workout from an earlier run is still in progress" "$output"

case_name="routines.sh when the routine does not survive the relaunch"
rm -rf "$root/routines-state"
run_routines FAKE_FORGETS=1 "$root/routines-forgets"
check "routines.sh fails when the routine is gone after the relaunch" test "$routines_status" -ne 0
check "routines.sh says the routine was not on the Train tab" \
  grep -qxF '"Proof routine 1" was not on the Train tab after the relaunch' "$output"
check "routines.sh restores the default text size after a failure" \
  only_calls "settings" "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="routines.sh when the Train tab shows no cold start time"
rm -rf "$root/routines-state"
run_routines FAKE_NO_TIMING=1 "$root/routines-no-timing"
check "routines.sh fails when svett shows no cold start time" test "$routines_status" -ne 0
check "routines.sh says the cold start time is missing" \
  grep -qxF "The Train tab did not show the cold start time" "$output"
check "routines.sh saves no cold start without svett's own time" \
  test ! -e "$root/routines-no-timing/cold-start.txt"

case_name="routines.sh when the cold start time is not svett's"
rm -rf "$root/routines-state"
run_routines FAKE_TIMING_LABEL="Loading" "$root/routines-bad-timing"
check "routines.sh fails on a cold start label it cannot read" test "$routines_status" -ne 0
check "routines.sh quotes the label it found" \
  grep -qxF 'The cold start time on the Train tab reads "Loading"' "$output"

case_name="routines.sh when the started workout leaves the targets out"
rm -rf "$root/routines-state"
run_routines FAKE_NO_TARGETS=1 "$root/routines-no-targets"
check "routines.sh fails when a set of the workout is not filled in" test "$routines_status" -ne 0
check "routines.sh names the set that is not filled in" \
  grep -qxF "Set 1 of the workout is not filled in with $routine_target" "$output"

case_name="routines.sh when the picker shows another exercise first"
rm -rf "$root/routines-state"
run_routines FAKE_LIBRARY="Barbell Squat Jump" "$root/routines-other"
check "routines.sh fails when the first result is not the exercise it adds" test "$routines_status" -ne 0
check "routines.sh names the result it found instead" \
  grep -qxF 'The first result was not "Barbell Squat". Its label is "Barbell Squat Jump, Quadriceps · Barbell".' "$output"

# Stands in for the bound command while startup.sh times cold launches. It keeps
# the screen in front, the number of relaunches and how far the Train tab is
# scrolled under $FAKE_STATE. A relaunch with -svettLink svett://train opens on
# the Train tab, and any other on the first tab. The Train tab is laid out as at
# the largest text size, Start empty workout, Cardio, the routine list, Library
# and the cold start time, of which two fit on the screen. wait and is visible
# see only those on screen, and scroll down or up --until moves the screen until
# the element is on it. The cold start time shows only when svett was launched
# with -svettTiming 1. Launch n reports a cold start from the list 1600 1510
# 1550 1520 1530, main() at 70 + 2n and JavaScript at 200 + n. Its database
# opens after the first screen. Only the first launch stops a leftover location
# task. FAKE_TIMING_LABEL replaces every launch's text, FAKE_NO_TIMING hides it,
# FAKE_NO_ROUTINES leaves the Train tab without its routines, and FAKE_NO_LINK
# ignores -svettLink, as a build from main before the launch marks does.
cat >"$fake/startup-device" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_ROOT/bound-calls"
shift 4
s=$FAKE_STATE
mkdir -p "$s"
get() { cat "$s/$1" 2>/dev/null || true; }
put() { printf '%s\n' "$2" >"$s/$1"; }
screen=$(get screen)
screen=${screen:-home}
launch=$(get launch)
launch=${launch:-0}
top=$(get top)
top=${top:-0}
loaded() { [[ -z "${FAKE_NO_ROUTINES:-}" ]]; }
# place <selector>: the element's row on the Train tab, top first.
place() {
  [[ "$screen" == train ]] || return 1
  case "$1" in
    'id="start-empty-workout"') loaded && echo 0 ;;
    'label="Cardio"') echo 1 ;;
    'id="routine-list"') loaded && echo 2 ;;
    'label="Library"') echo 3 ;;
    'id="cold-start-timing"') loaded && [[ -f "$s/timing" && -z "${FAKE_NO_TIMING:-}" ]] && echo 4 ;;
    *) return 1 ;;
  esac
}
# shows <selector>: the element, or one of a || fallback's, is on screen.
shows() {
  local one row
  while IFS= read -r one; do
    if [[ "$one" == 'label="Train, tab, 2 of 5"' ]]; then
      [[ "$screen" != home ]] && return 0
    elif row=$(place "$one"); then
      ((row >= top && row < top + 2)) && return 0
    fi
  done < <(sed 's/ || /\n/g' <<<"$1")
  return 1
}
label() {
  local starts=(1600 1510 1550 1520 1530) ms leftover=""
  ms=${starts[$(((launch - 1) % 5))]}
  [[ "$launch" != 1 ]] || leftover=", leftover location task stopped 1700"
  echo "Cold start: $ms ms, from process start to the first frame with the Train tab's routine list. The 2 second target judges this number, with nothing taken off. Timed from the process start, because iOS did not prewarm this launch. Steps since process start: process start 0, main() $((70 + launch * 2)), JavaScript started $((200 + launch)), Train tab opened 400, first screen drawn 420, database open 1100, routine list drawn $ms$leftover ms."
}
case "$1" in
  settings) ;;
  screenshot) echo "launch $launch" >"${@: -1}" ;;
  open)
    case "$3" in
      --relaunch)
        put launch $((launch + 1))
        put top 0
        if [[ "$*" == *"--launch-args=-svettLink --launch-args=svett://train"* && -z "${FAKE_NO_LINK:-}" ]]; then
          put screen train
        else
          put screen tabs
        fi
        if [[ "$*" == *"--launch-args=-svettTiming --launch-args=1"* ]]; then touch "$s/timing"; else rm -f "$s/timing"; fi ;;
      svett://train) put screen train ;;
      *) exit 1 ;;
    esac ;;
  wait) [[ "$2" =~ ^[0-9]+$ ]] || shows "$2" ;;
  is) shows "$3" ;;
  scroll)
    [[ "$3" == --until ]] && row=$(place "$4") || exit 1
    case "$2" in
      down) ((row >= top)) || exit 1; ((row < top + 2)) || put top $((row - 1)) ;;
      up) ((row < top + 2)) || exit 1; ((row >= top)) || put top "$row" ;;
      *) exit 1 ;;
    esac ;;
  get)
    shows "$3" || exit 1
    node -e 'console.log(JSON.stringify({ label: process.argv[1], rect: { x: 16, y: 600, width: 408, height: 300 } }))' \
      "${FAKE_TIMING_LABEL:-$(label)}" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fake/startup-device"

# run_startup [VAR=value...] [startup.sh args...] leaves the exit status in startup_status.
run_startup() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/startup-state"
  rm -f "$root/simctl-calls" "$root/bound-calls" "$container_fixture"
  startup_status=0
  env PATH="$fake:$PATH" FAKE_ROOT="$root" FAKE_STATE="$root/startup-state" \
    SVETT_DEVICE_CMD="startup-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/startup.sh" "$@" >"$output" 2>&1 || startup_status=$?
}

# startup_launches <times> <open> [link]: the opens of that many relaunches, each
# followed by the link when one is given.
startup_launches() {
  local n
  for ((n = 1; n <= $1; n++)); do
    printf '%s\n' "$2"
    [[ -z "${3:-}" ]] || printf '%s\n' "com.kron00.svett $3"
  done
}

startup_report() {
  local build=$1
  cat <<EOF
5 cold launches of a $build build, on the 300-workout fixture at the largest text size.
Each launch opened straight into the Train tab, and its time runs to the first frame with the routine list, with nothing taken off.
Launch 1: cold start 1600 ms, steps since process start: process start 0, main() 72, JavaScript started 201, Train tab opened 400, first screen drawn 420, database open 1100, routine list drawn 1600, leftover location task stopped 1700 ms.
Launch 2: cold start 1510 ms, steps since process start: process start 0, main() 74, JavaScript started 202, Train tab opened 400, first screen drawn 420, database open 1100, routine list drawn 1510 ms.
Launch 3: cold start 1550 ms, steps since process start: process start 0, main() 76, JavaScript started 203, Train tab opened 400, first screen drawn 420, database open 1100, routine list drawn 1550 ms.
Launch 4: cold start 1520 ms, steps since process start: process start 0, main() 78, JavaScript started 204, Train tab opened 400, first screen drawn 420, database open 1100, routine list drawn 1520 ms.
Launch 5: cold start 1530 ms, steps since process start: process start 0, main() 80, JavaScript started 205, Train tab opened 400, first screen drawn 420, database open 1100, routine list drawn 1530 ms.
Median: cold start 1530 ms, which the plan's 2 second target judges.
Median of each step since process start: process start 0, main() 76, JavaScript started 203, Train tab opened 400, first screen drawn 420, database open 1100, routine list drawn 1530, leftover location task stopped 1700 (1 of 5 launches) ms.
EOF
}

link_args="--launch-args=-svettLink --launch-args=svett://train"
train_loaded='id="start-empty-workout" || id="workout-in-progress-row" || id="routine-list" || id="cold-start-timing"'

case_name="startup.sh Release with SVETT_DEVICE_CMD"
run_startup --release "$root/startup"
[[ "$startup_status" == 0 ]] || fail "startup.sh --release failed"
mapfile -t release_launches < <(startup_launches 5 "com.kron00.svett --relaunch $fixture_args $link_args")
check "startup.sh relaunches the installed app on the fixture with timing straight into the Train tab 5 times, with no later link" \
  only_open "${release_launches[@]}"
check "startup.sh copies the generated fixture into the app's data container" \
  grep -qxF "fake fixture" "$container_fixture"
check "startup.sh times at the largest text size, then restores the default" \
  only_calls "settings" "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "startup.sh scrolls down to the time below the routines on every launch" \
  test "$(grep -cxF -- "$bound_prefix scroll down --until id=\"cold-start-timing\"" "$root/bound-calls")" -eq 5
mapfile -t startup_moves < <(for n in 1 2 3 4 5; do
  printf '%s\n' "wait $train_loaded 30000" "wait $train_loaded 10000" \
    'scroll down --until id="routine-list"' 'scroll down --until id="cold-start-timing"'
done)
check "startup.sh waits for the loaded Train tab before it moves the screen, then scrolls to the routines and the time" \
  only_calls 'wait id=|scroll' "${startup_moves[@]}"
check "startup.sh saves each launch's text as the Train tab shows it" \
  grep -qF "Cold start: 1550 ms, from process start to the first frame" "$root/startup/launch-3.txt"
check "startup.sh screenshots every launch" \
  only_calls "screenshot" "screenshot $root/startup/01-launch-1.png" "screenshot $root/startup/02-launch-2.png" \
  "screenshot $root/startup/03-launch-3.png" "screenshot $root/startup/04-launch-4.png" \
  "screenshot $root/startup/05-launch-5.png"
check "startup.sh reports every step of every launch, with a database open after the first screen inside the cold start, then the medians" \
  diff <(startup_report Release) "$root/startup/startup.txt"
check "startup.sh prints the report" grep -qxF "Median: cold start 1530 ms, which the plan's 2 second target judges." "$output"
check "startup.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

# startup_device <agent-device args...> calls the startup fake as the bound command would.
startup_device() {
  env FAKE_ROOT="$root" FAKE_STATE="$root/startup-state" "$fake/startup-device" \
    --session 't3-test session' --device FAKE-UDID "$@" >/dev/null 2>&1
}
fails() { ! "$@"; }

case_name="the startup fake at the largest text size"
rm -rf "$root/startup-state"
# shellcheck disable=SC2086 # Each launch argument is its own word.
startup_device open com.kron00.svett --relaunch $timing_args $link_args
check "the fake Train tab shows Start empty workout and Cardio on screen" \
  startup_device is visible 'label="Cardio"'
check "the fake Train tab starts its routine list below the screen, where the wait before this fix fails" \
  fails startup_device wait 'id="routine-list"' 30000
check "the fake Train tab's routine list is invisible to is visible below the screen" \
  fails startup_device is visible 'id="routine-list"'
check "the wait for the loaded Train tab passes without moving the screen" \
  startup_device wait "$train_loaded" 30000
check "a scroll down brings the fake routine list on screen" \
  startup_device scroll down --until 'id="routine-list"'
check "the fake routine list is on screen after the scroll" startup_device is visible 'id="routine-list"'
check "Start empty workout is above the screen after the scroll" \
  fails startup_device is visible 'id="start-empty-workout"'

case_name="startup.sh Debug with SVETT_DEVICE_CMD"
run_startup "$root/startup-debug"
[[ "$startup_status" == 0 ]] || fail "startup.sh failed"
mapfile -t debug_launches < <(startup_launches 5 "$debug_fixture_open $link_args")
check "startup.sh Debug relaunches into the dev client on Metro, straight into the Train tab" only_open "${debug_launches[@]}"
check "startup.sh says a Debug build's time is not the one the target judges" \
  grep -qxF "5 cold launches of a Debug, loaded from Metro, which the 2 second target does not judge build, on the 300-workout fixture at the largest text size." \
  "$root/startup-debug/startup.txt"

case_name="startup.sh on a build from before the launch marks"
main_label="svett's own cold start: 3367 ms. Routine list drawn 6014 ms after launch, less 2647 ms waiting for the Train tab. Steps since launch: JavaScript started 3018, database open 3287, first screen drawn 3354, routine list drawn 6014 ms."
run_startup SVETT_LAUNCHES=3 SVETT_FIXTURE=/data/Documents/svett-fixture.db FAKE_NO_LINK=1 \
  FAKE_TIMING_LABEL="$main_label" --release "$root/startup-main"
[[ "$startup_status" == 0 ]] || fail "startup.sh failed on the older text"
given_fixture_args="--launch-args=-svettFixture --launch-args=/data/Documents/svett-fixture.db $timing_args $link_args"
mapfile -t given_launches < <(startup_launches 3 "com.kron00.svett --relaunch $given_fixture_args" svett://train)
check "startup.sh relaunches SVETT_LAUNCHES times on SVETT_FIXTURE, and opens the Train link when the build ignores -svettLink" \
  only_open "${given_launches[@]}"
check "startup.sh with SVETT_FIXTURE neither generates nor copies a fixture" \
  test ! -e "$container_fixture" -a ! -e "$root/startup-main/svett-fixture.db"
check "startup.sh reads the steps of the older text, timed from the launch" \
  grep -qxF "Median of each step since launch: JavaScript started 3018, database open 3287, first screen drawn 3354, routine list drawn 6014 ms." \
  "$root/startup-main/startup.txt"
check "startup.sh takes the older build's time to the routine list with nothing taken off, and says the target does not judge it" \
  grep -qxF "Median: cold start 6014 ms, which the plan's 2 second target does not judge, because it includes the wait for svett://train." \
  "$root/startup-main/startup.txt"
check "startup.sh says the older build opened the Train tab through the link" \
  grep -qxF "This build opens on another tab, so each launch opened the Train tab through svett://train after the tabs showed, and its time includes that wait." \
  "$root/startup-main/startup.txt"

case_name="startup.sh when a launch did not open straight into the Train tab"
indirect_label="Cold start: 2500 ms, from process start to the first frame with the Train tab's routine list. This launch opened on another tab first, so the number includes the time until the Train tab opened, and the 2 second target does not judge it. Timed from the process start, because iOS did not prewarm this launch. Steps since process start: process start 0, first screen drawn 420, Train tab opened 2400, routine list drawn 2500 ms."
run_startup FAKE_TIMING_LABEL="$indirect_label" --release "$root/startup-indirect"
check "startup.sh fails on a launch that opened on another tab" test "$startup_status" -ne 0
check "startup.sh says the launch did not open straight into the Train tab" \
  grep -qxF "Launch 1: svett did not open straight into the Train tab, so its time includes the wait for it" "$output"
check "startup.sh saves no report for a launch that opened on another tab" test ! -e "$root/startup-indirect/startup.txt"

case_name="startup.sh when the Train tab shows no cold start time"
run_startup FAKE_NO_TIMING=1 --release "$root/startup-no-timing"
check "startup.sh fails when svett shows no cold start time" test "$startup_status" -ne 0
check "startup.sh says which launch showed no time" \
  grep -qxF "Launch 1: the Train tab did not show the cold start time" "$output"
check "startup.sh saves no report without a cold start time" test ! -e "$root/startup-no-timing/startup.txt"
check "startup.sh restores the default text size after a failure" \
  only_calls "settings" "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="startup.sh when the Train tab never gets its routines"
run_startup FAKE_NO_ROUTINES=1 --release "$root/startup-no-routines"
check "startup.sh fails a launch whose Train tab never got its routines" test "$startup_status" -ne 0
check "startup.sh says the Train tab did not list the routines" \
  grep -qxF "Launch 1: the Train tab did not list the routines" "$output"
check "startup.sh saves no report without the routines" test ! -e "$root/startup-no-routines/startup.txt"

case_name="startup.sh when the cold start time is not svett's"
run_startup FAKE_TIMING_LABEL="Loading" --release "$root/startup-bad-timing"
check "startup.sh fails on a cold start text it cannot read" test "$startup_status" -ne 0
check "startup.sh quotes the text it found" \
  grep -qxF "Launch 1: the Train tab shows \"Loading\", which is not a cold start time" "$output"

case_name="startup.sh with no launches"
run_startup SVETT_LAUNCHES=0 --release "$root/startup-none"
check "startup.sh refuses a launch count below 1" test "$startup_status" -eq 64
check "startup.sh says what SVETT_LAUNCHES must be" \
  grep -qxF 'SVETT_LAUNCHES must be a whole number above 0, got "0"' "$output"

# logger.sh runs against a fake fixture, a fake app and the real workout-rows.ts.
# The fake pnpm writes a database with the Legs routine. The fake device keeps
# the app's workouts in $FAKE_STATE and writes them to the database it was
# launched on after every change, as the app saves each change. An element is
# on screen only where the app shows it, and the exercises after the first and
# the timing line sit below the fold until a scroll down reaches them. Elements
# have frames on a 956 point screen. The first set's weight field starts at the
# bottom edge. The open keypad covers the screen from y=524, with Next and Done
# at its foot, and a running rest sits right above it, so a press there reaches
# the keypad or the rest instead of the workout. A drag from inside the workout
# brings the element it is for clear of them. After a scroll or a drag the next
# element read glides for two reads. A press acts on the element whose frame was
# read last, if it lands on its centre, so a press at a gliding frame misses.
# Every set marked done starts a rest, and the first rest asks for notifications
# with a system prompt that hides svett until alert accept answers it, unless
# settings permission granted them ahead. FAKE_GRANT_FAILS refuses that grant.
# FAKE_LAUNCH_PROMPT puts a system prompt over the first launch, and
# FAKE_FIRST_LAUNCH_HANGS never shows the tabs on the first launch, with nothing
# over svett, though a second launch would show them.
# A drag faster than 100 points a second glides on and carries the element it was
# for off the top of the screen, as on the Mac. FAKE_FLINGS overshoots the first
# drag that way however slow it is, and leaves the second under the navigation bar.
# FAKE_LOSES_WORKOUT forgets the workout when svett is killed, FAKE_DROPS_DONE
# forgets the last exercise's done sets then, FAKE_KEEPS_UNDONE keeps the sets
# not done when it finishes, and FAKE_NO_TIMING never times a set marked done.
logger_bin="$root/logger-bin"
mkdir -p "$logger_bin"
cat >"$logger_bin/pnpm" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "fixture --out" ]] || { echo "fake pnpm: unexpected $*" >&2; exit 1; }
rm -f "$3"
node -e '
  const database = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
  database.exec(`
    CREATE TABLE routine (id TEXT PRIMARY KEY, deleted_at INTEGER, title TEXT, position INTEGER);
    CREATE TABLE exercise (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE activity (id TEXT PRIMARY KEY, deleted_at INTEGER, title TEXT, status TEXT, notes TEXT, started_at INTEGER);
    CREATE TABLE activity_exercise (id TEXT PRIMARY KEY, deleted_at INTEGER, activity_id TEXT, exercise_id TEXT,
      position INTEGER, set_fields TEXT, notes TEXT, superset_group INTEGER);
    CREATE TABLE activity_set (id TEXT PRIMARY KEY, deleted_at INTEGER, activity_exercise_id TEXT, position INTEGER,
      set_type TEXT, weight_kg REAL, reps INTEGER, duration_s REAL, distance_m REAL, done INTEGER, rpe REAL);
    INSERT INTO routine VALUES ('\''push-routine'\'', NULL, '\''Push'\'', 0), ('\''legs-routine'\'', NULL, '\''Legs'\'', 2);
  `);
' "$3"
EOF
cat >"$fake/logger-device" <<'EOF'
#!/usr/bin/env node
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const args = process.argv.slice(2);
fs.appendFileSync(`${process.env.FAKE_ROOT}/bound-calls`, `${args.join(" ")}\n`);
const command = args.slice(4);
const stateFile = `${process.env.FAKE_STATE}/state.json`;
const state = fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
  : { screen: "home", workouts: [], scrolled: [], kills: 0, launches: 0, timing: null, permission: "undetermined",
    prompt: null, rest: false, focus: null, low: null, panned: false, glide: null, flung: null, under: null,
    overshoot: null, pans: 0 };
const save = () => {
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  if (!state.db) return;
  const database = new DatabaseSync(state.db);
  database.exec("DELETE FROM activity; DELETE FROM activity_exercise; DELETE FROM activity_set; DELETE FROM exercise;");
  state.workouts.forEach((workout, w) => {
    database.prepare("INSERT INTO activity VALUES (?, NULL, ?, ?, '', ?)").run(`a${w}`, workout.title, workout.status, w);
    workout.exercises.forEach((exercise, e) => {
      database.prepare("INSERT OR IGNORE INTO exercise VALUES (?, ?)").run(exercise.name, exercise.name);
      database.prepare("INSERT INTO activity_exercise VALUES (?, NULL, ?, ?, ?, ?, '', NULL)").run(`a${w}e${e}`, `a${w}`, exercise.name, e, exercise.fields);
      exercise.sets.forEach((set, s) => {
        database.prepare("INSERT INTO activity_set VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)")
          .run(`a${w}e${e}s${s}`, `a${w}e${e}`, s, set.type, set.weight, set.reps, set.time, set.done ? 1 : 0);
      });
    });
  });
  database.close();
};
const current = () => state.workouts.find((workout) => workout.status === "in_progress") ?? null;
const set = (type, min, max) => ({ type, weight: null, reps: null, time: null, done: false, min, max });
const ROUTINE = [["Barbell Squat", 5, 8], ["Romanian Deadlift", 6, 10], ["Leg Press", 8, 12],
  ["Lying Leg Curls", 10, 12], ["Standing Calf Raises", 10, 15]];
const LIBRARY = { plank: "Plank", "barbell squat": "Barbell Squat" };
const lastSets = (name) => {
  const last = state.workouts.filter((workout) => workout.status === "finished")
    .flatMap((workout) => workout.exercises).filter((exercise) => exercise.name === name).at(-1);
  return last?.sets ?? null;
};
const previous = (exercise, index) => {
  const last = lastSets(exercise.name);
  if (last === null) return null;
  const type = exercise.sets[index].type;
  const nth = exercise.sets.slice(0, index).filter((other) => other.type === type).length;
  return last.filter((other) => other.type === type)[nth] ?? null;
};
const badges = (exercise) => {
  let normal = 0;
  return exercise.sets.map((other) => other.type === "normal" ? `Set ${++normal}` : other.type === "failure" ? "Failure set" : "Drop set");
};
const doneLabel = (exercise, index) => {
  const one = exercise.sets[index];
  const parts = [];
  if (one.weight !== null) parts.push(`${one.weight} kg`);
  if (one.reps !== null) parts.push(`${one.reps} reps`);
  else if (one.min !== null) parts.push(`${one.min} to ${one.max} reps`);
  if (one.time !== null) parts.push(`${one.time} seconds`);
  return `${badges(exercise)[index]}, ${parts.join(", ")}, ${one.done ? "Done" : "To do"}`;
};
// Every element on the current screen, by id or label, with its label.
const elements = () => {
  const found = [];
  const add = (id, label = "", extra = {}) => found.push({ id, label, selected: false, role: null, ...extra });
  if (state.screen === "home" || state.screen === "launching") return found;
  add(null, "Train, tab, 2 of 5");
  const workout = current();
  if (["tabs", "train"].includes(state.screen) && workout) add("workout-bar", `Workout in progress, ${workout.title}, 12:34`);
  if (state.screen === "train") {
    add("train");
    add("routine-list");
    add(workout ? "workout-in-progress-row" : "start-empty-workout");
  }
  if (state.screen === "routine") { add("routine-detail"); add("start-routine"); }
  if (state.screen === "picker") {
    add("exercise-library");
    add("exercise-result-0", `${process.env.FAKE_LIBRARY ?? LIBRARY[state.query]}, Quadriceps · Barbell`);
  }
  if (state.screen === "sheet") { add("set-type-sheet"); add("set-type-sheet-failure"); }
  if (state.screen === "workout") {
    add("workout");
    if (!workout) return found;
    add("workout-title", workout.title);
    // The bar's Finish item has no identifier, so the script can only find it by label.
    add("bar-finish", "Finish");
    // iOS nests an alert's button in containers with the same label.
    if (state.alert) add("alert-finish", "Finish workout", { role: "button" });
    add("set-done-timing", state.timing === null ? "No set marked done yet" : `Set shown done in ${state.timing} ms`);
    workout.exercises.forEach((exercise, e) => {
      add(`workout-exercise-${e}`, exercise.name);
      add(`move-exercise-down-${e}`);
      add(`add-workout-set-${e}`);
      exercise.sets.forEach((_, s) => {
        add(`workout-set-${e}-${s}`, doneLabel(exercise, s));
        add(`workout-set-${e}-${s}-type`);
        for (const column of exercise.fields === "time" ? ["time"] : ["weight", "reps"]) {
          const focus = state.focus;
          add(`set-${e}-${s}-${column}`, "", { selected: focus?.e === e && focus.s === s && focus.column === column });
        }
        const last = previous(exercise, s);
        if (last !== null && last.weight !== null) add(null, `Previous, ${last.weight} kg × ${last.reps}`);
      });
    });
    if (state.focus) {
      for (const key of "0123456789") add(`key-${key}`);
      add("keypad-next");
      add("keypad-done");
    }
    if (state.rest) add("rest-timer");
  }
  return found;
};
const parse = (selector) => ({
  id: /id="([^"]*)"/.exec(selector)?.[1] ?? null,
  label: /label="([^"]*)"/.exec(selector)?.[1] ?? null,
  selected: /selected=true/.test(selector),
  role: /role="([^"]*)"/.exec(selector)?.[1] ?? null,
});
const findOne = (selector) => {
  const wanted = parse(selector);
  return elements().find((element) =>
    (wanted.id === null || element.id === wanted.id) && (wanted.label === null || element.label === wanted.label) &&
    (!wanted.selected || element.selected) && (element.role === null || wanted.role === element.role)) ?? null;
};
// A || fallback finds the first of its elements on screen, else the first anywhere.
const find = (selector) => {
  if (state.prompt !== null) return null;
  const found = selector.split(" || ").map(findOne).filter((element) => element !== null);
  return found.find(visible) ?? found[0] ?? null;
};
// The routine list starts below the screen at the largest text size, under Start empty workout and Cardio.
const belowFold = (element) =>
  /^(workout-exercise|workout-set|set|move-exercise-down|add-workout-set)-[1-9]/.test(element.id ?? "") ||
  element.id === "set-done-timing" || element.id === "start-routine" || element.id === "routine-list";
const flung = (element) => state.flung !== null && state.flung === element.id;
const visible = (element) => element !== null && !flung(element) &&
  (!belowFold(element) || state.scrolled.includes(element.id));

// The screen is 956 points tall. The keypad covers it from y=524 down, with Next and Done at
// its foot. A running rest sits right above the open keypad, or at the foot of the screen.
// Above the keypad it keeps to one row. FAKE_REST_COVERS_SET plays the app before that fix,
// whose full rest covered the set being typed into.
const KEYPAD_TOP = 524;
const KEY_ROWS = ["123", "456", "789", ".0<"];
const KEY_COLUMNS = [16, 155, 294];
const OLD_REST = process.env.FAKE_REST_COVERS_SET !== undefined;
const REST_HEIGHT = 196;
const COMPACT_REST_HEIGHT = 124;
const restHeight = () => (state.focus && !OLD_REST ? COMPACT_REST_HEIGHT : REST_HEIGHT);
// A press below this lands on the home indicator. On the Mac a press at y=880 still opened
// the keypad on the first set's weight field.
const HOME_INDICATOR = 900;
const restTop = () => (state.focus ? KEYPAD_TOP : 956) - restHeight();
const keyFrame = (key) => {
  const row = KEY_ROWS.findIndex((keys) => keys.includes(key));
  return { x: KEY_COLUMNS[KEY_ROWS[row].indexOf(key)], y: KEYPAD_TOP + 12 + 75 * row, width: 130, height: 67 };
};
const fixed = {
  "keypad-next": { x: 16, y: 836, width: 200, height: 88 },
  "keypad-done": { x: 224, y: 836, width: 200, height: 88 },
  "bar-finish": { x: 340, y: 62, width: 84, height: 44 },
  "alert-finish": { x: 40, y: 480, width: 360, height: 50 },
  "workout-bar": { x: 16, y: 700, width: 408, height: 60 },
  "exercise-result-0": { x: 0, y: 200, width: 440, height: 80 },
};
const inFocusedSet = (id) => state.focus !== null &&
  new RegExp(`^(set|workout-set)-${state.focus.e}-${state.focus.s}(-|$)`).test(id ?? "");
// Where a content element is. The first set's weight field starts at the foot of the screen.
// The workout keeps the set being typed into right above the keypad, and above the rest once
// it runs, with its weight on one line and its reps and done box on the next. A drag brings the element it was for, the next one read, to y=250. After a
// scroll or a drag the next content element read is still gliding 40 and then 20 points below
// where it stops, so a press at its first read lands beside it.
const centreY = (id) => {
  const glide = state.glide?.id === id ? 20 * Math.max(0, 2 - state.glide.reads) : 0;
  if (state.low === id) return 880;
  if (state.under === id) return 100 + glide;
  if (state.panned) return 250 + glide;
  if (inFocusedSet(id)) {
    const first = /-weight$|-time$/.test(id);
    if (OLD_REST) return (first ? 336 : 420) + glide;
    return (state.rest ? restTop() : KEYPAD_TOP) - (first ? 140 : 56) + glide;
  }
  return 625 + glide;
};
const frame = (element) => {
  const id = element.id ?? "";
  const key = /^key-(\d)$/.exec(id);
  if (key) return keyFrame(key[1]);
  if (id === "rest-timer") return { x: 0, y: restTop(), width: 440, height: restHeight() };
  return fixed[id] ?? { x: 16, y: centreY(id) - 25, width: 408, height: 50 };
};
const centre = (rect) => `${Math.round(rect.x + rect.width / 2)} ${Math.round(rect.y + rect.height / 2)}`;
const show = (screen) => {
  state.screen = screen; state.scrolled = []; state.focus = null; state.low = null; state.panned = false;
  state.glide = null; state.flung = null; state.under = null; state.overshoot = null;
};
const startWorkout = (title, exercises) => {
  state.workouts.push({ title, status: "in_progress", exercises });
  show("workout");
};
const typeKey = (digit) => {
  const workout = current();
  const focus = state.focus;
  focus.text = (focus.fresh ? "" : focus.text) + digit;
  focus.fresh = false;
  const digits = focus.text.padStart(6, "0");
  workout.exercises[focus.e].sets[focus.s][focus.column] = focus.column === "time"
    ? Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4)) * 60 + Number(digits.slice(4))
    : Number(focus.text);
};
// What a press at the point reaches: nothing under a system prompt or on the home indicator,
// the keypad's key or button under it, nothing on the rest timer, and else the element whose
// frame was read last, if the point is still its centre.
const press = (x, y) => {
  if (state.prompt !== null || y > HOME_INDICATOR) return;
  if (state.screen === "workout" && state.focus) {
    if (y >= KEYPAD_TOP) {
      for (const digit of "0123456789") {
        const rect = keyFrame(digit);
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) return typeKey(digit);
      }
      if (y >= 836 && x < 220) state.focus = { ...state.focus, column: "reps", text: "", fresh: true };
      else if (y >= 836) state.focus = null;
      return;
    }
  }
  if (state.screen === "workout" && state.rest && y >= restTop() && y < restTop() + restHeight()) return;
  if (state.alert && state.target !== "alert-finish") return;
  const target = state.target;
  if (target === null || centre(frame({ id: target })) !== `${x} ${y}`) return;
  act(target);
};
const act = (target) => {
  const workout = current();
  const at = (pattern) => pattern.exec(target)?.slice(1).map(Number) ?? null;
  let m;
  if (target === "workout-bar") show("workout");
  else if (target === "start-routine") {
    startWorkout("Legs", ROUTINE.map(([name, min, max]) => ({ name, fields: "weight_reps", sets: [0, 1, 2].map(() => set("normal", min, max)) })));
    state.low = "set-0-0-weight";
  } else if (target === "start-empty-workout") startWorkout("Evening workout", []);
  else if (target === "exercise-result-0") {
    const name = process.env.FAKE_LIBRARY ?? LIBRARY[state.query];
    const last = lastSets(name);
    workout.exercises.push({ name, fields: name === "Plank" ? "time" : "weight_reps",
      sets: (last ?? [set("normal", null, null), set("normal", null, null), set("normal", null, null)]).map((other) => set(other.type, null, null)) });
    show("workout");
  } else if ((m = at(/^workout-set-(\d+)-(\d+)-type$/))) {
    state.sheet = m;
    const focus = state.focus;
    show("sheet");
    state.focus = focus;
  } else if (target === "set-type-sheet-failure") {
    workout.exercises[state.sheet[0]].sets[state.sheet[1]].type = "failure";
    const focus = state.focus;
    show("workout");
    state.focus = focus;
  } else if ((m = at(/^workout-set-(\d+)-(\d+)$/))) {
    const exercise = workout.exercises[m[0]];
    const one = exercise.sets[m[1]];
    if (!one.done) {
      const last = previous(exercise, m[1]);
      if (last !== null) for (const key of ["weight", "reps", "time"]) one[key] ??= last[key];
      // Every set marked done starts a rest, and the first rest asks for notifications. A rest
      // appearing over the open keypad scrolls the set being typed into up above it.
      if (!state.rest && state.focus && !OLD_REST) state.glide = { id: `workout-set-${m[0]}-${m[1]}`, reads: 0 };
      state.rest = true;
      if (state.permission === "undetermined") state.prompt = "notifications";
    }
    one.done = !one.done;
    if (process.env.FAKE_NO_TIMING === undefined) state.timing = 12;
  } else if ((m = /^set-(\d+)-(\d+)-(\w+)$/.exec(target))) {
    state.focus = { e: Number(m[1]), s: Number(m[2]), column: m[3], text: "", fresh: true };
    state.low = null;
    state.panned = false;
    state.under = null;
  } else if ((m = at(/^add-workout-set-(\d+)$/))) {
    const sets = workout.exercises[m[0]].sets;
    sets.push({ ...sets.at(-1), done: false, min: null, max: null });
  } else if ((m = at(/^move-exercise-down-(\d+)$/))) {
    const [moved] = workout.exercises.splice(m[0], 1);
    workout.exercises.splice(m[0] + 1, 0, moved);
    state.scrolled = [];
    if (state.focus?.e === m[0]) state.focus.e += 1;
    else if (state.focus?.e === m[0] + 1) state.focus.e -= 1;
  } else if (target === "bar-finish") state.alert = true;
  else if (target === "alert-finish") {
    state.alert = false;
    const workout = current();
    if (!process.env.FAKE_KEEPS_UNDONE) {
      for (const exercise of workout.exercises) exercise.sets = exercise.sets.filter((one) => one.done);
      workout.exercises = workout.exercises.filter((exercise) => exercise.sets.length > 0);
    }
    workout.status = "finished";
    state.rest = false;
    show("tabs");
  }
};
const fail = () => process.exit(1);
switch (command[0]) {
  case "screenshot":
    break;
  case "snapshot":
    console.log(JSON.stringify({ screen: state.screen, prompt: state.prompt, elements: elements().length }));
    break;
  case "settings":
    if (command[1] === "permission") {
      if (process.env.FAKE_GRANT_FAILS) { console.error("Operation not permitted"); fail(); }
      if (command[2] === "grant" && command[3] === "notifications") state.permission = "granted";
    }
    break;
  case "open": {
    const url = command[2];
    if (url === "--relaunch") {
      state.db = command.find((arg) => arg.endsWith(".db"))?.replace("--launch-args=", "") ?? state.db;
      const kills = (fs.existsSync(`${process.env.FAKE_ROOT}/simctl-calls`)
        ? fs.readFileSync(`${process.env.FAKE_ROOT}/simctl-calls`, "utf8") : "").split("\n").filter((line) => line.startsWith("simctl terminate")).length;
      if (kills > state.kills) {
        state.kills = kills;
        if (process.env.FAKE_LOSES_WORKOUT) state.workouts = state.workouts.filter((workout) => workout.status !== "in_progress");
        if (process.env.FAKE_DROPS_DONE) for (const one of current()?.exercises.at(-1).sets ?? []) one.done = false;
      }
      state.launches += 1;
      state.alert = false;
      state.prompt = null;
      show("tabs");
      // A rest still running comes back, and asks for notifications if nobody answered yet.
      state.rest = state.rest && current() !== null;
      if (state.rest && state.permission === "undetermined") state.prompt = "notifications";
      if (state.launches === 1 && process.env.FAKE_LAUNCH_PROMPT) state.prompt = "launch";
      if (state.launches === 1 && process.env.FAKE_FIRST_LAUNCH_HANGS) state.screen = "launching";
    } else if (url === "svett://train") show("train");
    else if (url === "svett://routine/legs-routine") show("routine");
    else if (url.startsWith("svett://train/workout/exercises?q=")) {
      state.query = decodeURIComponent(url.slice("svett://train/workout/exercises?q=".length));
      show("picker");
    } else fail();
    break;
  }
  case "wait":
    if (/^\d+$/.test(command[1])) break;
    if (command[1] === "absent") { if (find(command[2]) !== null) fail(); break; }
    if (!visible(find(command[1]))) fail();
    break;
  case "is":
    if (!visible(find(command[2]))) fail();
    break;
  case "scroll": {
    const element = find(command[3]);
    if (element === null || (command[1] === "up" && !visible(element) && !flung(element))) fail();
    state.scrolled.push(element.id);
    state.low = null;
    state.panned = false;
    state.flung = null;
    state.under = null;
    state.overshoot = null;
    state.glide = { id: null, reads: 0 };
    break;
  }
  case "gesture": {
    // A drag moves the workout only from inside it: below the navigation bar, above the
    // keypad and the rest timer. agent-device reports it on stdout.
    const y = Number(command[3]);
    const bottom = Math.min(956, state.focus ? KEYPAD_TOP : 956, state.rest ? restTop() : 956);
    if (state.prompt === null && state.screen === "workout" && y > 110 && y < bottom) {
      state.panned = true;
      state.low = null;
      state.flung = null;
      state.under = null;
      state.glide = { id: null, reads: 0 };
      // A drag faster than 100 points a second leaves the workout gliding on when the finger
      // lifts, and on the Mac that carried the field it was for off the top of the screen.
      // FAKE_FLINGS overshoots the first drag that way however slow it is, and the second
      // under the navigation bar.
      state.pans += 1;
      const fast = Math.abs(Number(command[5])) / Number(command[6] ?? 500) > 0.1;
      state.overshoot = fast || (process.env.FAKE_FLINGS && state.pans === 1) ? "off"
        : process.env.FAKE_FLINGS && state.pans === 2 ? "under" : null;
    }
    console.log(`Panned (${command[2]}, ${command[3]}) by (${command[4]}, ${command[5]})`);
    break;
  }
  case "get": {
    const element = find(command[2]);
    if (element === null || flung(element)) fail();
    state.target = element.id;
    // The first element read after a drag is the one it was for.
    if (state.glide !== null && state.glide.id === null && !/^(key-|rest-timer)/.test(element.id)) {
      state.glide.id = element.id;
      if (state.overshoot === "off") {
        state.flung = element.id;
        state.overshoot = null;
        save();
        fail();
      }
      if (state.overshoot === "under") state.under = element.id;
      state.overshoot = null;
    }
    const rect = frame(element);
    if (state.glide?.id === element.id) state.glide.reads += 1;
    console.log(JSON.stringify({ label: element.label, rect }));
    break;
  }
  case "press": {
    // A press at a point must get two numbers, as agent-device would demand.
    if (!/^\d+ \d+$/.test(`${command[1]} ${command[2]}`)) fail();
    press(Number(command[1]), Number(command[2]));
    break;
  }
  case "alert":
    if (command[1] === "wait" && state.prompt === null && !state.alert) fail();
    // agent-device answers system prompts only. svett's own alerts have no button it can find.
    if (command[1] === "accept") {
      if (state.prompt === null) fail();
      if (state.prompt === "notifications") state.permission = "granted";
      state.prompt = null;
    }
    break;
  default:
    fail();
}
save();
EOF
chmod +x "$logger_bin/pnpm" "$fake/logger-device"

# run_logger [VAR=value...] [logger.sh args...] leaves the exit status in logger_status.
run_logger() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/logger-state" "$root/data container"
  rm -f "$root/simctl-calls" "$root/bound-calls"
  logger_status=0
  env PATH="$logger_bin:$fake:$PATH" FAKE_ROOT="$root" FAKE_STATE="$root/logger-state" \
    SVETT_DEVICE_CMD="logger-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/logger.sh" "$@" >"$output" 2>&1 || logger_status=$?
}

# logger_from <call> <expected call>...: the bound command calls from the first
# that is exactly <call> through the next press are exactly these, without the prefix.
logger_from() {
  local calls expected
  calls=$(sed "s/^$bound_prefix //" "$root/bound-calls" |
    awk -v first="$1" '$0 == first { on = 1 } on { print } on && /^press / { exit }')
  expected=$(printf '%s\n' "$@")
  [[ "$calls" == "$expected" ]] || {
    { echo "bound command calls from $1:"; echo "$calls"; } >>"$output"
    fail "the bound command did not get exactly these calls: $expected"
  }
}

# logger_pans_slow checks every drag moves at most 50 points a second.
logger_pans_slow() {
  grep -qE "^$bound_prefix gesture pan " "$root/bound-calls" &&
    ! grep -E "^$bound_prefix gesture pan " "$root/bound-calls" |
    awk '{ by = $(NF - 1) < 0 ? -$(NF - 1) : $(NF - 1) } by * 20 > $NF { found = 1 } END { exit !found }'
}

# logger_presses_clear checks every press point sits above y=840.
logger_presses_clear() {
  ! grep -E "^$bound_prefix press " "$root/bound-calls" | awk '$NF > 840 { found = 1 } END { exit !found }'
}

logger_db="$root/data container/Documents/svett-logger.db"
logger_args="--launch-args=-svettFixture --launch-args=$logger_db --launch-args=-svettTiming --launch-args=1"
logger_links=("com.kron00.svett svett://routine/legs-routine"
  "com.kron00.svett svett://train/workout/exercises?q=plank")
empty_links=("com.kron00.svett svett://train"
  "com.kron00.svett svett://train/workout/exercises?q=barbell%20squat")

case_name="logger.sh Debug with SVETT_DEVICE_CMD"
run_logger "$root/logger"
[[ "$logger_status" == 0 ]] || fail "logger.sh failed"
check "logger.sh launches on the copied fixture with timing, kills svett, and launches it again" \
  only_open "$debug_open $logger_args" "com.kron00.svett svett://train" "${logger_links[@]}" \
  "$debug_open $logger_args" "${empty_links[@]}"
check "logger.sh kills svett mid-workout with simctl" \
  simctl_got "simctl terminate FAKE-UDID com.kron00.svett"
check "logger.sh never launches or opens a link with simctl" no_simctl_launch_or_openurl
check "logger.sh grants notifications ahead, and shoots at the largest text size, then restores the default" \
  only_calls "settings" "settings permission grant notifications" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "logger.sh types each set by pressing its weight, then its reps, and waits until each is selected" \
  only_calls 'wait id="set-[0-9]' \
  'wait id="set-0-0-weight" selected=true 3000' 'wait id="set-0-0-reps" selected=true 3000' \
  'wait id="set-0-1-weight" selected=true 3000' 'wait id="set-0-1-reps" selected=true 3000' \
  'wait id="set-0-2-weight" selected=true 3000' 'wait id="set-0-2-reps" selected=true 3000' \
  'wait id="set-0-0-weight" selected=true 3000' 'wait id="set-5-0-time" selected=true 3000'
check "logger.sh never reads or presses the keypad's Next and Done at the bottom edge" \
  test -z "$(grep -E 'keypad-(next|done)' "$root/bound-calls")"
check "logger.sh drags the first set's weight field up from the bottom edge just far enough before it presses it" \
  bound_got "$bound_prefix gesture pan 20 820 0 -81 1620"
check "logger.sh drags a set up from under the keypad and the rest, from just above them" \
  bound_got "$bound_prefix gesture pan 20 370 0 -276 5520"
check "logger.sh drags no faster than 50 points a second, so the workout stops where the finger lifts" \
  logger_pans_slow
check "logger.sh checks each set it typed and marked done where it shows, above the keypad and the rest" \
  grep -qxF "Set 1 of exercise 1 shows above the keypad and the rest timer, from y=235 to y=369" "$output"
check "logger.sh checks the second and the failure set the same way" \
  test "$(grep -cE '^Set [23] of exercise 1 shows above the keypad and the rest timer, from y=235 to y=369$' "$output")" = 2
check "logger.sh reads the first set marked done where it is, without a scroll" \
  test -z "$(grep -E 'scroll .*id="workout-set-0-0"' "$root/bound-calls")"
check "logger.sh reads the first set's frame only once it stops moving as the rest appears" \
  test "$(sed -n '/wait id="workout-set-0-0" label="Set 1, 100 kg, 5 reps, Done" 5000$/,/get attrs id="set-0-0-weight"$/p' \
    "$root/bound-calls" | grep -c 'get attrs id="workout-set-0-0"$')" = 4
check "logger.sh presses nothing at the bottom edge" logger_presses_clear
check "logger.sh presses Start workout only once two reads agree after the scroll that found it" \
  logger_from 'scroll down --until id="start-routine"' 'is visible id="key-1"' 'is visible id="rest-timer"' \
  'get attrs id="start-routine"' "wait 250" 'get attrs id="start-routine"' "wait 250" \
  'get attrs id="start-routine"' "wait 250" 'get attrs id="start-routine"' "press 220 625"
check "logger.sh leaves the first rest's prompt alone when notifications were granted ahead" \
  only_calls "alert" "alert wait 3000" "alert wait 5000" "alert wait 5000"
check "logger.sh scrolls down to a set below the fold before it checks it" \
  bound_got "--session t3-test session --device FAKE-UDID scroll down --until id=\"workout-set-1-0\" label=\"Set 1, 100 kg, 5 reps, Done\""
check "logger.sh finds the restored Legs in the database exactly as logged" \
  diff "$root/logger/restored-expected.txt" "$root/logger/restored.txt"
check "logger.sh finds the finished Legs in the database with only its done sets" \
  diff "$root/logger/finished-expected.txt" "$root/logger/finished.txt"
check "logger.sh finds the empty workout in the database with the set it took from last time" \
  grep -qxF "Set 1.1: normal, 100 kg, 5 reps, done" "$root/logger/empty.txt"
check "logger.sh saves the time a set took to show done" \
  grep -qxF "Marking a set done until the row showed it: 12 ms (Debug, loaded from Metro, on the fixture database, timed in the app)" \
  "$root/logger/set-done.txt"
check "logger.sh screenshots each step" \
  only_calls "screenshot" \
  "screenshot $root/logger/01-train.png" "screenshot $root/logger/02-workout-started.png" \
  "screenshot $root/logger/03-squat-logged.png" "screenshot $root/logger/04-before-kill.png" \
  "screenshot $root/logger/05-restored-bar.png" "screenshot $root/logger/06-restored.png" \
  "screenshot $root/logger/07-finished.png" "screenshot $root/logger/08-empty-workout.png"

case_name="logger.sh Release with SVETT_DEVICE_CMD"
run_logger --release "$root/logger-release"
[[ "$logger_status" == 0 ]] || fail "logger.sh --release failed"
check "logger.sh Release launches the installed app on the fixture without Metro" \
  only_open "com.kron00.svett --relaunch $logger_args" "com.kron00.svett svett://train" \
  "${logger_links[@]}" "com.kron00.svett --relaunch $logger_args" "${empty_links[@]}"
check "logger.sh Release says the time came from a Release build" \
  grep -qF "(Release, on the fixture database, timed in the app)" "$root/logger-release/set-done.txt"

case_name="logger.sh when notifications cannot be granted ahead"
run_logger FAKE_GRANT_FAILS=1 "$root/logger-ungranted"
[[ "$logger_status" == 0 ]] || fail "logger.sh failed when it could not grant notifications ahead"
check "logger.sh says it answers the prompt instead" \
  grep -qxF "Could not grant notifications ahead, so the first set marked done answers the prompt" "$output"
check "logger.sh answers the notification prompt right after the first set marked done" \
  only_calls "alert" "alert wait 3000" "alert accept" "alert wait 5000" "alert wait 5000"
check "logger.sh still finds the restored Legs in the database exactly as logged" \
  diff "$root/logger-ungranted/restored-expected.txt" "$root/logger-ungranted/restored.txt"

case_name="logger.sh when a system prompt covers the first launch"
run_logger FAKE_LAUNCH_PROMPT=1 "$root/logger-prompt"
[[ "$logger_status" == 0 ]] || fail "logger.sh failed with a prompt over the first launch"
check "logger.sh keeps the screen of a launch that showed no tabs" \
  bound_got "$bound_prefix screenshot $root/logger-prompt/launch-1.png"
check "logger.sh answers the prompt and goes on without launching again" \
  grep -qxF "Answered a system prompt over svett after launch 1" "$output"
check "logger.sh launches only as often as without the prompt" \
  only_open "$debug_open $logger_args" "com.kron00.svett svett://train" "${logger_links[@]}" \
  "$debug_open $logger_args" "${empty_links[@]}"

case_name="logger.sh when the first launch hangs with nothing over svett"
run_logger FAKE_FIRST_LAUNCH_HANGS=1 "$root/logger-hangs"
check "logger.sh fails when a launch hangs with no system prompt to explain it" test "$logger_status" -ne 0
check "logger.sh keeps the screen of the launch that hung" \
  bound_got "$bound_prefix screenshot $root/logger-hangs/launch-1.png"
check "logger.sh keeps the elements of the launch that hung" test -s "$root/logger-hangs/launch-1.txt"
check "logger.sh names the saved files of the launch that hung" \
  grep -qxF "svett hung on launch 1 with no system prompt over it. See $root/logger-hangs/launch-1.png and $root/logger-hangs/launch-1.txt" "$output"
check "logger.sh does not hide the hang behind a second launch" only_open "$debug_open $logger_args"

case_name="logger.sh when a drag overshoots"
run_logger FAKE_FLINGS=1 "$root/logger-flings"
[[ "$logger_status" == 0 ]] || fail "logger.sh failed when a drag overshot"
check "logger.sh brings back a field a drag carried off screen, before it presses it" \
  logger_from 'gesture pan 20 820 0 -81 1620' 'is visible id="key-1"' 'is visible id="rest-timer"' \
  'get attrs id="set-0-0-weight"' 'is visible id="set-0-0-weight"' 'scroll up --until id="set-0-0-weight"' \
  'get attrs id="set-0-0-weight"' "wait 250" 'get attrs id="set-0-0-weight"' "wait 250" \
  'get attrs id="set-0-0-weight"' "wait 250" 'get attrs id="set-0-0-weight"' "press 220 625"
check "logger.sh drags a field a drag left under the navigation bar back down before it presses it" \
  bound_got "$bound_prefix gesture pan 20 150 0 71 1420"
check "logger.sh still finds the restored Legs in the database exactly as logged after the overshoots" \
  diff "$root/logger-flings/restored-expected.txt" "$root/logger-flings/restored.txt"

case_name="logger.sh when the rest covers the set being typed into"
run_logger FAKE_REST_COVERS_SET=1 "$root/logger-covered"
check "logger.sh fails when the set marked done does not show above the keypad and the rest" \
  test "$logger_status" -ne 0
check "logger.sh says where the set was and what was clear" \
  grep -qxF "Set 1 of exercise 1 is not whole on screen above the keypad and the rest timer. It reaches from y=311 to y=445, and only y=130 to y=318 is clear" "$output"
check "logger.sh shoots the screen with the set under the rest" \
  only_calls "screenshot $root/logger-covered/failure" "screenshot $root/logger-covered/failure.png"
check "logger.sh saves the elements of the workout with the set under the rest" \
  grep -qF '"screen":"workout"' "$root/logger-covered/failure.txt"

case_name="logger.sh when the workout does not survive the kill"
run_logger FAKE_LOSES_WORKOUT=1 "$root/logger-loses"
check "logger.sh fails when the workout is gone after the kill" test "$logger_status" -ne 0
check "logger.sh says the workout did not come back" \
  grep -qxF "The workout in progress did not show above the tabs after the kill" "$output"
check "logger.sh restores the default text size after a failure" \
  only_calls "settings" "settings permission grant notifications" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "logger.sh shoots the screen at the failing check" \
  only_calls "screenshot $root/logger-loses/failure" "screenshot $root/logger-loses/failure.png"
check "logger.sh saves the screen's elements at the failing check" \
  grep -qF '"screen":"tabs"' "$root/logger-loses/failure.txt"
check "logger.sh says where the screen at the failure is" \
  grep -qxF "The screen at the failure is in $root/logger-loses/failure.png and $root/logger-loses/failure.txt" "$output"

case_name="logger.sh when a done set does not survive the kill"
run_logger FAKE_DROPS_DONE=1 "$root/logger-drops"
check "logger.sh fails when a set comes back not done" test "$logger_status" -ne 0
check "logger.sh names the set that came back wrong" \
  grep -qxF 'Set 1 of exercise 6 does not read "Set 1, 60 seconds, Done"' "$output"
check "logger.sh keeps the screen of the workout where the set came back wrong" \
  grep -qF '"screen":"workout"' "$root/logger-drops/failure.txt"

case_name="logger.sh when finishing keeps the sets not done"
run_logger FAKE_KEEPS_UNDONE=1 "$root/logger-undone"
check "logger.sh fails when the database holds sets that were never done" test "$logger_status" -ne 0
check "logger.sh says the finished workout is not as logged" \
  grep -qxF "The database does not hold \"Legs\" as logged. See $root/logger-undone/finished.txt" "$output"

case_name="logger.sh when the app does not time a set marked done"
run_logger FAKE_NO_TIMING=1 "$root/logger-untimed"
check "logger.sh fails without the time a set took to show done" test "$logger_status" -ne 0
check "logger.sh says what the timing line showed" \
  grep -qxF 'The workout did not time the set marked done. It says "No set marked done yet"' "$output"

# tools.sh runs against the logger's fake fixture, a fake app and the real
# workout-rows.ts. The fake device keeps the workout in $FAKE_STATE and writes it
# to the database it was launched on after every change, as the app saves each
# change. Romanian Deadlift's elements and the plate calculator's heavier load
# sit below the fold until a scroll down reaches them. A press acts on the
# element whose frame was read last. The rest notification shows on the Home
# Screen while a rest runs, unless FAKE_NO_NOTIFICATION, and the rest has run out
# once it shows. A relaunch keeps a running rest, unless FAKE_FORGETS_REST.
# FAKE_REST_IN_SUPERSET rests after the first exercise of a superset, and
# FAKE_STORES_LB stores a weight typed in pounds as kilograms without converting it.
# An entry field is selected while the keypad types into it. FAKE_FIELD_MISSES=n
# makes the first n presses on entry fields miss. With FAKE_GLIDES an entry field
# is still moving up for its first three reads, and a press where it was before
# it stopped misses.
cat >"$fake/tools-device" <<'EOF'
#!/usr/bin/env node
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const args = process.argv.slice(2);
fs.appendFileSync(`${process.env.FAKE_ROOT}/bound-calls`, `${args.join(" ")}\n`);
const command = args.slice(4);
const KG_PER_LB = 0.45359237;
const stateFile = `${process.env.FAKE_STATE}/state.json`;
const state = fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
  : { screen: "home", unit: "kg", workout: null, scrolled: [], rest: null, focus: null, fieldPresses: 0, reads: {} };
const save = () => {
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  if (!state.db || state.workout === null) return;
  const database = new DatabaseSync(state.db);
  database.exec("DELETE FROM activity; DELETE FROM activity_exercise; DELETE FROM activity_set; DELETE FROM exercise;");
  const workout = state.workout;
  database.prepare("INSERT INTO activity VALUES ('a0', NULL, ?, ?, '', 0)").run(workout.title, workout.status);
  workout.exercises.forEach((exercise, e) => {
    database.prepare("INSERT OR IGNORE INTO exercise VALUES (?, ?)").run(exercise.name, exercise.name);
    database.prepare("INSERT INTO activity_exercise VALUES (?, NULL, 'a0', ?, ?, 'weight_reps', '', ?)")
      .run(`e${e}`, exercise.name, e, exercise.superset);
    exercise.sets.forEach((set, s) => {
      database.prepare("INSERT INTO activity_set VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)")
        .run(`e${e}s${s}`, `e${e}`, s, set.type, set.weight, set.reps, set.done ? 1 : 0);
    });
  });
  database.close();
};
const LIBRARY = { "barbell squat": "Barbell Squat", "romanian deadlift": "Romanian Deadlift" };
// Last time's sets, which marking a set done fills in, in kilograms.
const LAST = {
  "Barbell Squat": [["warm_up", 60, 10], ["normal", 100, 5], ["normal", 100, 5]],
  "Romanian Deadlift": [["normal", 80, 8], ["normal", 80, 8]],
};
const shown = (kg) => String(Math.round((state.unit === "lb" ? kg / KG_PER_LB : kg) * 100) / 100);
const badges = (exercise) => {
  let normal = 0;
  return exercise.sets.map((one) => one.type === "normal" ? `Set ${++normal}` : "Warm-up set");
};
const doneLabel = (exercise, index) => {
  const one = exercise.sets[index];
  const parts = [];
  if (one.weight !== null) parts.push(`${process.env.FAKE_STORES_LB ? one.typed : shown(one.weight)} ${state.unit}`);
  if (one.reps !== null) parts.push(`${one.reps} reps`);
  return [badges(exercise)[index], ...(parts.length ? parts : ["No target"]), one.done ? "Done" : "To do"].join(", ");
};
const inSuperset = (e) => state.workout.exercises[e]?.superset != null;
const joinsNext = (e) => inSuperset(e) && state.workout.exercises[e + 1]?.superset === state.workout.exercises[e].superset;
const options = (e) => {
  const count = state.workout.exercises.length;
  return [
    ...(inSuperset(e) ? ["Remove from superset"] : []),
    ...(e < count - 1 && !joinsNext(e) ? ["Superset with next exercise"] : []),
    `Rest timer: ${state.workout.exercises[e].rest === 30 ? "0:30" : "1:30"}`,
    "Warm-up sets", "Plate calculator", "Replace exercise", "Log by: Weight and reps", "Remove exercise", "Cancel",
  ];
};
const PLATES = {
  "225": [["plates-result", "On the barbell, 225 lb. Each side, 2 plates of 45 lb."]],
  "220.46": [
    ["plates-result", "Your plates cannot make 220.46 lb exactly."],
    ["plates-lighter", "Nearest lighter, 220 lb. Each side, 1 plate of 45 lb, 1 plate of 35 lb, 1 plate of 5 lb, 1 plate of 2.5 lb."],
    ["plates-heavier", "Nearest heavier, 225 lb. Each side, 2 plates of 45 lb."],
  ],
};
const elements = () => {
  const found = [];
  const add = (id, label = "", selected = false, role = null) => found.push({ id, label, selected, role });
  if (state.screen === "home") return found;
  if (state.screen === "springboard") {
    if (state.rest !== null && !process.env.FAKE_NO_NOTIFICATION) add(null, "Rest is over");
    return found;
  }
  add(null, "Train, tab, 2 of 5");
  const workout = state.workout?.status === "in_progress" ? state.workout : null;
  if (state.screen === "tabs" && workout) add("workout-bar", `Workout in progress, ${workout.title}, 12:34`);
  if (state.screen === "settings") {
    add("workout-settings");
    add(null, "Kilograms");
    add(null, "Pounds");
    add("unit-note", `Weights show and are typed in ${state.unit === "lb" ? "pounds" : "kilograms"}. svett stores kilograms, so switching changes no workout.`);
  }
  if (state.screen === "train") { add("train"); if (!workout) add("start-empty-workout"); }
  if (state.screen === "picker") { add("exercise-library"); add("exercise-result-0", `${LIBRARY[state.query]}, Hamstrings · Barbell`); }
  // iOS nests each action sheet button in three containers with the same label.
  if (state.screen === "options") for (const label of options(state.options)) add(null, label, false, "button");
  if (state.screen === "rest-sheet") { add("rest-sheet"); for (const seconds of [0, 15, 30, 45, 60, 90]) add(`rest-sheet-${seconds}`); }
  if (state.screen === "plates") {
    add("plates");
    for (const [id, label] of PLATES[shown(state.platesKg)] ?? [["plates-result", `Plates for ${shown(state.platesKg)} ${state.unit}`]]) add(id, label);
  }
  if (state.screen === "workout") {
    add("workout");
    if (!workout) return found;
    add("workout-title", workout.title);
    add("bar-finish", "Finish");
    if (state.alert) add("alert-finish", "Finish workout", false, "button");
    workout.exercises.forEach((exercise, e) => {
      add(`workout-exercise-${e}`, exercise.name);
      add(`exercise-options-${e}`);
      if (inSuperset(e)) add(`workout-superset-${e}`, "Superset A");
      exercise.sets.forEach((_, s) => {
        add(`workout-set-${e}-${s}`, doneLabel(exercise, s));
        for (const column of ["weight", "reps"]) {
          const focus = state.focus;
          add(`set-${e}-${s}-${column}`, "", focus?.e === e && focus.s === s && focus.column === column);
        }
      });
    });
    if (state.focus) for (const key of "0123456789") add(`key-${key}`);
    if (state.rest !== null) { add("rest-timer"); add("rest-timer-left", `Rest, ${state.rest} seconds left`); }
  }
  return found;
};
const parse = (selector) => ({
  id: /id="([^"]*)"/.exec(selector)?.[1] ?? null,
  label: /label="([^"]*)"/.exec(selector)?.[1] ?? null,
  selected: /selected=true/.test(selector),
  role: /role="([^"]*)"/.exec(selector)?.[1] ?? null,
});
const find = (selector) => {
  const wanted = parse(selector);
  return elements().find((element) =>
    (wanted.id === null || element.id === wanted.id) && (wanted.label === null || element.label === wanted.label) &&
    (!wanted.selected || element.selected) && (element.role === null || wanted.role === element.role)) ?? null;
};
const isField = (id) => /^set-\d+-\d+-(weight|reps)$/.test(id ?? "");
// Where an element is after `reads` reads of its frame. A gliding field stops after three.
const topAt = (id, reads) =>
  process.env.FAKE_LOW && id === process.env.FAKE_LOW && !state.panned
    ? 905
    : process.env.FAKE_GLIDES && isField(id)
      ? 600 + 20 * Math.max(0, 3 - reads)
      : 600;
const centre = (top) => `${16 + 408 / 2} ${top + 50 / 2}`;
const belowFold = (element) =>
  /^(workout-exercise|workout-superset|workout-set|exercise-options|set)-1/.test(element.id ?? "") ||
  element.id === "plates-heavier";
const visible = (element) => element !== null && (!belowFold(element) || state.scrolled.includes(element.id));
const show = (screen) => { state.screen = screen; state.scrolled = []; };
const heaviest = (exercise) => Math.max(...exercise.sets.filter((one) => one.type !== "warm_up" && one.weight !== null).map((one) => one.weight));
const press = (point) => {
  const target = state.target;
  if (isField(target)) {
    state.fieldPresses += 1;
    const missed = state.fieldPresses <= Number(process.env.FAKE_FIELD_MISSES ?? 0) ||
      point !== centre(topAt(target, state.reads[target] ?? 0));
    if (missed) return;
  }
  const workout = state.workout;
  let m;
  if (target === "label:Pounds") state.unit = "lb";
  else if (target === "label:Kilograms") state.unit = "kg";
  else if (target === "start-empty-workout") {
    state.workout = { title: "Evening workout", status: "in_progress", exercises: [] };
    show("workout");
  } else if (target === "exercise-result-0") {
    const name = LIBRARY[state.query];
    workout.exercises.push({ name, rest: 90, superset: null,
      sets: LAST[name].map(([type]) => ({ type, weight: null, reps: null, done: false, typed: null })) });
    show("workout");
  } else if ((m = /^exercise-options-(\d+)$/.exec(target))) { state.options = Number(m[1]); show("options"); }
  else if (target === "label:Rest timer: 1:30" || target === "label:Rest timer: 0:30") show("rest-sheet");
  else if ((m = /^rest-sheet-(\d+)$/.exec(target))) {
    workout.exercises[state.options].rest = Number(m[1]);
    show("workout");
  } else if (target === "label:Superset with next exercise") {
    workout.exercises[state.options].superset = 0;
    workout.exercises[state.options + 1].superset = 0;
    show("workout");
  } else if (target === "label:Plate calculator") {
    state.platesKg = heaviest(workout.exercises[state.options]);
    show("plates");
  } else if ((m = /^set-(\d+)-(\d+)-(\w+)$/.exec(target))) {
    state.focus = { e: Number(m[1]), s: Number(m[2]), column: m[3], text: "" };
  } else if ((m = /^key-(\d)$/.exec(target))) {
    const focus = state.focus;
    focus.text += m[1];
    const one = workout.exercises[focus.e].sets[focus.s];
    if (focus.column === "weight") {
      one.typed = focus.text;
      one.weight = state.unit === "lb" && !process.env.FAKE_STORES_LB ? Number(focus.text) * KG_PER_LB : Number(focus.text);
    } else one.reps = Number(focus.text);
  } else if ((m = /^workout-set-(\d+)-(\d+)$/.exec(target))) {
    const e = Number(m[1]);
    const exercise = workout.exercises[e];
    const one = exercise.sets[Number(m[2])];
    const [, weight, reps] = LAST[exercise.name][Number(m[2])];
    one.weight ??= weight;
    one.reps ??= reps;
    one.done = true;
    const last = !inSuperset(e) || !inSuperset(e + 1);
    if (last || process.env.FAKE_REST_IN_SUPERSET) state.rest = exercise.rest;
  } else if (target === "bar-finish") state.alert = true;
  else if (target === "alert-finish") {
    state.alert = false;
    for (const exercise of workout.exercises) exercise.sets = exercise.sets.filter((one) => one.done);
    workout.exercises = workout.exercises.filter((exercise) => exercise.sets.length > 0);
    workout.status = "finished";
    state.rest = null;
    show("tabs");
  } else process.exit(1);
};
const fail = () => process.exit(1);
switch (command[0]) {
  case "settings":
  case "screenshot":
    break;
  case "home":
    show("home");
    break;
  case "open": {
    const url = command[1] === "com.apple.springboard" ? "springboard" : command[2];
    if (url === "springboard") show("springboard");
    else if (url === "--relaunch") {
      state.db = command.find((arg) => arg.endsWith(".db"))?.replace("--launch-args=", "") ?? state.db;
      if (process.env.FAKE_FORGETS_REST) state.rest = null;
      state.focus = null;
      show("tabs");
    } else if (url === "svett://settings/workout") show("settings");
    else if (url === "svett://train") show("train");
    else if (url === "svett://train/workout") show("workout");
    else if (url === "svett://tools/plates?kg=100") { state.platesKg = 100; show("plates"); }
    else if (url.startsWith("svett://train/workout/exercises?q=")) {
      state.query = decodeURIComponent(url.slice("svett://train/workout/exercises?q=".length));
      show("picker");
    } else fail();
    break;
  }
  case "wait":
    if (/^\d+$/.test(command[1])) break;
    if (command[1] === "text") {
      if (find(`label="${command[2]}"`) === null) fail();
      if (command[2] === "Rest is over") state.rest = null;
      break;
    }
    if (command[1] === "absent") { if (find(command[2]) !== null) fail(); break; }
    if (!visible(find(command[1]))) fail();
    break;
  case "is":
    if (!visible(find(command[2]))) fail();
    break;
  case "scroll": {
    const element = find(command[3]);
    if (element === null || (command[1] === "up" && !visible(element))) fail();
    state.scrolled.push(element.id);
    break;
  }
  case "get": {
    const element = find(command[2]);
    if (element === null) fail();
    state.target = element.id ?? `label:${element.label}`;
    const reads = state.reads[state.target] ?? 0;
    state.reads[state.target] = reads + 1;
    console.log(JSON.stringify({ label: element.label, rect: { x: 16, y: topAt(state.target, reads), width: 408, height: 50 } }));
    break;
  }
  case "press":
    // A press at a point must get two numbers, as agent-device would demand.
    if (!command[1].includes("=") && !/^\d+ \d+$/.test(`${command[1]} ${command[2]}`)) fail();
    press(`${command[1]} ${command[2]}`);
    break;
  case "gesture":
    // agent-device reports each gesture on stdout, which must not reach a coordinate.
    state.panned = true;
    console.log(`Panned (${command[2]}, ${command[3]}) by (${command[4]}, ${command[5]})`);
    break;
  case "alert":
    if (command[1] === "wait" && !state.alert) fail();
    if (command[1] === "accept") fail();
    break;
  default:
    fail();
}
save();
EOF
chmod +x "$fake/tools-device"

# run_tools [VAR=value...] [tools.sh args...] leaves the exit status in tools_status.
run_tools() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/tools-state" "$root/data container"
  rm -f "$root/simctl-calls" "$root/bound-calls"
  tools_status=0
  env PATH="$logger_bin:$fake:$PATH" FAKE_ROOT="$root" FAKE_STATE="$root/tools-state" \
    SVETT_DEVICE_CMD="tools-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/tools.sh" "$@" >"$output" 2>&1 || tools_status=$?
}

tools_args="--launch-args=-svettFixture --launch-args=$root/data container/Documents/svett-tools.db"
tools_links=("com.kron00.svett svett://settings/workout" "com.kron00.svett svett://train"
  "com.kron00.svett svett://train/workout/exercises?q=barbell%20squat"
  "com.kron00.svett svett://train/workout/exercises?q=romanian%20deadlift"
  "com.apple.springboard")
squat_kg=$(node -e 'console.log(225 * 0.45359237)')

case_name="tools.sh Debug with SVETT_DEVICE_CMD"
run_tools "$root/tools"
[[ "$tools_status" == 0 ]] || fail "tools.sh failed"
check "tools.sh launches on the copied fixture, goes to the Home Screen for the rest, and launches again during the next" \
  only_open "$debug_open $tools_args" "${tools_links[@]}" "$debug_open $tools_args" \
  "com.kron00.svett svett://train/workout" "$debug_open $tools_args" \
  "com.kron00.svett svett://train/workout" "com.kron00.svett svett://tools/plates?kg=100" \
  "com.kron00.svett svett://train/workout"
check "tools.sh never launches or opens a link with simctl" no_simctl_launch_or_openurl
check "tools.sh grants notifications ahead, and shoots at the largest text size, then restores the default" \
  only_calls "settings" "settings permission grant notifications" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
# done_then_home checks the call right after the press that marks the set done,
# which starts the rest, is the Home Screen, before any screenshot or database check.
done_then_home() {
  grep -A2 -F 'get attrs id="workout-set-0-1"' "$root/bound-calls" | sed 's/^.*FAKE-UDID //' |
    tail -2 | tr '\n' '|' | grep -qxE "press [0-9]+ [0-9]+\|home\|"
}
check "tools.sh leaves svett in the call right after it marks the set done" done_then_home
check "tools.sh waits on the Home Screen for the rest notification" \
  bound_got "--session t3-test session --device FAKE-UDID wait text Rest is over 60000"
check "tools.sh types 225 lb on the keypad, then the reps, without the keypad's Next or Done" \
  only_calls 'get attrs id="(set-[0-9]+-[0-9]+-|key-|keypad-)' \
  'get attrs id="set-0-1-weight"' 'get attrs id="set-0-1-weight"' 'get attrs id="set-0-1-weight"' \
  'get attrs id="key-2"' 'get attrs id="key-2"' 'get attrs id="key-5"' \
  'get attrs id="set-0-1-reps"' 'get attrs id="set-0-1-reps"' 'get attrs id="set-0-1-reps"' \
  'get attrs id="key-5"'
check "tools.sh types only once the field it pressed is selected with the keypad open" \
  only_calls 'wait id="(set-[0-9]+-[0-9]+-[a-z]+" selected=true|key-2")' \
  'wait id="set-0-1-weight" selected=true 3000' 'wait id="key-2" 3000' \
  'wait id="set-0-1-reps" selected=true 3000' 'wait id="key-2" 3000'
check "tools.sh scrolls down to the second exercise's superset before it checks it" \
  bound_got '--session t3-test session --device FAKE-UDID scroll down --until id="workout-superset-1" label="Superset A"'
check "tools.sh finds 225 lb stored as kilograms while the workout is in progress" \
  grep -qxF "Set 1.2: normal, $squat_kg kg, 5 reps, done" "$root/tools/pounds.txt"
check "tools.sh finds the finished workout's superset in the database" \
  grep -qxF "Exercise 2: Romanian Deadlift, by weight_reps, superset 0" "$root/tools/finished.txt"
check "tools.sh screenshots each step" \
  only_calls "screenshot" \
  "screenshot $root/tools/01-pounds.png" "screenshot $root/tools/02-pounds-typed.png" \
  "screenshot $root/tools/03-rest-notification.png" "screenshot $root/tools/04-set-done.png" \
  "screenshot $root/tools/05-superset.png" "screenshot $root/tools/06-rest-restored.png" \
  "screenshot $root/tools/07-plates.png" "screenshot $root/tools/08-plates-nearest.png" \
  "screenshot $root/tools/09-finished.png"

case_name="tools.sh Release with SVETT_DEVICE_CMD"
run_tools --release "$root/tools-release"
[[ "$tools_status" == 0 ]] || fail "tools.sh --release failed"
check "tools.sh Release launches the installed app on the fixture without Metro" \
  only_open "com.kron00.svett --relaunch $tools_args" "${tools_links[@]}" \
  "com.kron00.svett --relaunch $tools_args" "com.kron00.svett svett://train/workout" \
  "com.kron00.svett --relaunch $tools_args" "com.kron00.svett svett://train/workout" \
  "com.kron00.svett svett://tools/plates?kg=100" "com.kron00.svett svett://train/workout"

case_name="tools.sh when Start empty workout sits at the screen's bottom edge"
run_tools FAKE_LOW=start-empty-workout "$root/tools-low"
check "tools.sh drags a control up from the bottom edge and still presses a number" \
  test "$tools_status" -eq 0
check "tools.sh drags once before pressing Start empty workout" \
  only_calls "gesture" "gesture pan 20 600 0 -300 400"

case_name="tools.sh when the rest notification never shows"
run_tools FAKE_NO_NOTIFICATION=1 "$root/tools-silent"
check "tools.sh fails without the rest notification" test "$tools_status" -ne 0
check "tools.sh says the notification did not show in the background" \
  grep -qxF "The rest timer's notification did not show with svett in the background" "$output"
check "tools.sh restores the default text size after a failure" \
  only_calls "settings" "settings permission grant notifications" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="tools.sh when the first exercise of a superset rests"
run_tools FAKE_REST_IN_SUPERSET=1 "$root/tools-superset"
check "tools.sh fails when a superset rests before its round ends" test "$tools_status" -ne 0
check "tools.sh names the set that rested" \
  grep -qxF "A set of Barbell Squat, first in its superset, started a rest" "$output"

case_name="tools.sh when a relaunch forgets the running rest"
run_tools FAKE_FORGETS_REST=1 "$root/tools-forgets"
check "tools.sh fails when the rest does not come back after svett is killed" test "$tools_status" -ne 0
check "tools.sh says the rest did not come back" \
  grep -qxF "The rest did not come back after svett was killed" "$output"

case_name="tools.sh when a weight typed in pounds is stored unconverted"
run_tools FAKE_STORES_LB=1 "$root/tools-unconverted"
check "tools.sh fails when the database holds pounds as kilograms" test "$tools_status" -ne 0
check "tools.sh says the workout is not stored as logged" \
  grep -qxF "The database does not hold \"Evening workout\" as logged. See $root/tools-unconverted/pounds.txt" "$output"

case_name="tools.sh when the first press on an entry field misses"
run_tools FAKE_FIELD_MISSES=1 "$root/tools-missed"
[[ "$tools_status" == 0 ]] || fail "tools.sh failed after one missed press"
check "tools.sh presses the weight field again, then types 225 lb into it" \
  grep -qxF "Set 1.2: normal, $squat_kg kg, 5 reps, done" "$root/tools-missed/pounds.txt"
check "tools.sh says the first press did not select the field" \
  grep -qxF "Pressing the weight of Barbell Squat's first working set did not select it with the keypad open, try 1 of 2" "$output"

case_name="tools.sh when every press on an entry field misses"
run_tools FAKE_FIELD_MISSES=99 "$root/tools-missing"
check "tools.sh fails when the field never takes a press" test "$tools_status" -ne 0
check "tools.sh names the field the keypad never opened for" \
  grep -qxF "Pressing the weight of Barbell Squat's first working set (id=\"set-0-1-weight\") did not select it and open the keypad, after two presses" "$output"
check "tools.sh never types on the keypad when the field never took a press" \
  only_calls 'get attrs id="key-'

case_name="tools.sh when an entry field is still moving after a scroll"
run_tools FAKE_GLIDES=1 "$root/tools-glides"
[[ "$tools_status" == 0 ]] || fail "tools.sh failed on a field that was still moving"
check "tools.sh presses the field where it stopped, at the first try" \
  bash -c '! grep -qF "try 1 of 2" "$1"' _ "$output"
check "tools.sh still types 225 lb into the field" \
  grep -qxF "Set 1.2: normal, $squat_kg kg, 5 reps, done" "$root/tools-glides/pounds.txt"

# Stands in for the bound command on the account sign-in. It tracks the screen
# (the tab root, Progress or Account), the sign-in step, who is signed in, and
# where the imported history is. The second choice and each button under a card's
# fields show only after a scroll since the screen last changed, so the test proves
# the script scrolls to them. A press or fill lands on the element whose attrs
# were read last. FAKE_NO_CLERK makes Account say the build has no Clerk key, and
# FAKE_LEAK shows the second account the first one's history.
first_email=svett-proof-a+clerk_test@example.com
test_code=424242
cat >"$fake/signin-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
state="$root/signin-state"
get() { cat "\$state/\$1" 2>/dev/null || echo "\$2"; }
put() { echo "\$2" >"\$state/\$1"; }
mkdir -p "\$state"
screen=\$(get screen tabs)
step=\$(get step choose)
who=\$(get who "")
moved=\$(get moved no)
scrolled=\$(get scrolled no)
show() { put screen "\$1"; put scrolled no; }
id_of() { sed -nE 's/.*id="([^"]+)".*/\1/p' <<<"\$1"; }
# on_screen <id> is true when the element is on screen now.
on_screen() {
  case "\$screen:\$1" in
    tabs:* | progress:*) [[ "\$1" == workout-counts && "\$screen" == progress ]] ;;
    account:account) true ;;
    account:accounts-off) [[ -n "\${FAKE_NO_CLERK:-}" ]] ;;
    account:*) [[ -z "\${FAKE_NO_CLERK:-}" ]] || return 1
      case "\$step:\$1" in
        choose:sign-in-choose | choose:continue-with-chatgpt | email:sign-in-email | email:email-field | \
          code:sign-in-code | code:code-field | offer:move-offer | signedin:signed-in) true ;;
        choose:continue-with-email | email:send-code | code:check-code | offer:move-data | signedin:sign-out)
          [[ "\$scrolled" == yes ]] ;;
        *) false ;;
      esac ;;
    *) false ;;
  esac
}
exists() { on_screen "\$1" || { scrolled=yes; on_screen "\$1"; }; }
counts() {
  case "\$who" in
    "") [[ "\$moved" == yes ]] && echo "0 workouts, 0 sets" || echo "300 workouts, 6023 sets" ;;
    $first_email) [[ "\$moved" == yes ]] && echo "300 workouts, 6023 sets" || echo "0 workouts, 0 sets" ;;
    *) [[ -n "\${FAKE_LEAK:-}" ]] && echo "300 workouts, 6023 sets" || echo "0 workouts, 0 sets" ;;
  esac
}
args=" \$* "
target=\$(id_of "\$args")
case "\$args" in
  *" open com.kron00.svett svett://account "*) show account ;;
  *" open com.kron00.svett --relaunch "*) show tabs ;;
  *' press label="Progress, tab, 3 of 5" '*) show progress ;;
  *" scroll "*" --until "*) exists "\$target" && put scrolled yes ;;
  *" scroll "*) put scrolled yes ;;
  *" get attrs "*)
    on_screen "\$target" || exit 1
    put last "\$target"
    echo '{"label": "Field", "rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" fill 80 320 "*)
    [[ "\$(get last)" == email-field || "\$(get last)" == code-field ]] || exit 1
    put "\$(get last)" "\${args#* fill 80 320 }" ;;
  *" press 80 320 "*)
    case "\$step:\$(get last)" in
      choose:continue-with-email) put step email ;;
      email:send-code) put step code ;;
      code:check-code)
        [[ "\$(get code-field)" == "$test_code " ]] || exit 1
        put who "\$(get email-field | sed 's/ \$//')"
        if [[ "\$(get answered no)" == no && "\$moved" == no ]]; then put step offer; else put step signedin; fi ;;
      offer:move-data) put moved yes; put answered yes; put step signedin ;;
      signedin:sign-out) put who ""; put step choose ;;
      *) echo "fake device: press on \$(get last) at step \$step" >&2; exit 1 ;;
    esac ;;
  *" get text "*) counts ;;
  *" wait absent "*) true ;;
  *" is visible "* | *" wait "*) [[ -z "\$target" ]] || on_screen "\$target" ;;
esac
EOF
chmod +x "$fake/signin-device"

# run_signin [VAR=value...] [signin.sh args...] leaves the exit status in signin_status.
run_signin() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/signin-state"
  signin_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="signin-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/signin.sh" "$@" >"$output" 2>&1 || signin_status=$?
}

container_sqlite="$root/data container/Documents/SQLite"
mkdir -p "$container_sqlite"
for stale in svett-anonymous.db-wal svett-account-user_old.db ExpoSQLiteStorage; do
  echo stale >"$container_sqlite/$stale"
done

case_name="signin.sh Debug with SVETT_DEVICE_CMD"
run_signin "$root/signin"
[[ "$signin_status" == 0 ]] || fail "signin.sh failed"
check "signin.sh puts the fixture, imported from Hevy, in the database with no owner" \
  diff -q <(printf '%s\n' "fake fixture" --imported) "$container_sqlite/svett-anonymous.db"
check "signin.sh removes the earlier journal, account databases and move answer" \
  test "$(ls "$container_sqlite")" == svett-anonymous.db
check "signin.sh stops svett and drops every Clerk session before it changes the files" \
  only_simctl "simctl list devices available" "simctl terminate FAKE-UDID com.kron00.svett" "simctl keychain FAKE-UDID reset" \
  "simctl get_app_container FAKE-UDID com.kron00.svett data"
check "signin.sh relaunches into the dev client and opens Account by its link" \
  only_open "$debug_open" "com.kron00.svett svett://account" "$debug_open" "com.kron00.svett svett://account" \
  "$debug_open" "com.kron00.svett svett://account" "$debug_open"
check "signin.sh signs in two Clerk test accounts with the test code, at the field centres" \
  only_calls "fill" \
  "fill 80 320 $first_email" "fill 80 320 $test_code" \
  "fill 80 320 svett-proof-b+clerk_test@example.com" "fill 80 320 $test_code"
check "signin.sh scrolls to each button under the fold before it presses it" \
  only_calls "get attrs" \
  'get attrs id="continue-with-email"' 'get attrs id="email-field"' 'get attrs id="send-code"' \
  'get attrs id="code-field"' 'get attrs id="check-code"' 'get attrs id="move-data"' \
  'get attrs id="sign-out"' 'get attrs id="continue-with-email"' 'get attrs id="email-field"' \
  'get attrs id="send-code"' 'get attrs id="code-field"' 'get attrs id="check-code"'
check "signin.sh shoots each step at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "signin.sh screenshots the data before, the choices, the offer, and each account's data" \
  only_calls "screenshot" \
  "screenshot $root/signin/01-phone-data.png" "screenshot $root/signin/02-choices.png" \
  "screenshot $root/signin/03-move-offer.png" "screenshot $root/signin/04-first-account.png" \
  "screenshot $root/signin/05-first-account-data.png" "screenshot $root/signin/06-signed-out-data.png" \
  "screenshot $root/signin/07-second-account.png" "screenshot $root/signin/08-second-account-data.png"
check "signin.sh says the second account sees none of the history" \
  grep -qF "The Progress tab shows none of the first account's history in the second account: 0 workouts, 0 sets" "$output"
check "signin.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="signin.sh Release with SVETT_DEVICE_CMD"
run_signin --release "$root/signin-release"
[[ "$signin_status" == 0 ]] || fail "signin.sh --release failed"
check "signin.sh Release relaunches the installed app without Metro" \
  only_open "com.kron00.svett --relaunch" "com.kron00.svett svett://account" "com.kron00.svett --relaunch" \
  "com.kron00.svett svett://account" "com.kron00.svett --relaunch" "com.kron00.svett svett://account" \
  "com.kron00.svett --relaunch"

case_name="signin.sh when the second account sees the first one's history"
run_signin FAKE_LEAK=1 "$root/signin-leak"
check "signin.sh fails when the second account sees the history" test "$signin_status" -ne 0
check "signin.sh says what the second account saw" \
  grep -qF "The Progress tab should show none of the first account's history in the second account, but it reads: 300 workouts" "$output"
check "signin.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="signin.sh on a build without a Clerk key"
run_signin FAKE_NO_CLERK=1 "$root/signin-no-clerk"
check "signin.sh fails on a build without a Clerk key" test "$signin_status" -ne 0
check "signin.sh says to build with the publishable key" \
  grep -qF "Build it with EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set" "$output"

# Stands in for the bound command while proposals.sh asks the coach for proposals. It
# keeps the screen in front, the stand-in svett was launched with, the stand-ins asked
# and each proposal's state as files under $FAKE_STATE. A card, the refusal, the end
# of the preview and every Train row start below the fold, so only a scroll finds
# them. A press acts on the element whose frame was read last, and a press below
# y=840 lands on the home indicator and does nothing. FAKE_TRAIN_EARLY lists a
# proposal on the Train tab before Apply, FAKE_UNDO_KEEPS after Undo, FAKE_NO_REFUSAL
# shows no refusal for the malformed routine, and FAKE_LEG_CARD shows a card for it.
# FAKE_CARD_LOW keeps the routine's card at the bottom edge until a drag, and
# FAKE_GLIDE moves an element on the first read after a scroll. The chat ends on the
# card or the refusal, so the answer's text sits above the screen, out of a wait's reach.
cat >"$fake/proposals-device" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_ROOT/bound-calls"
shift 4
s=$FAKE_STATE
mkdir -p "$s"
get() { cat "$s/$1" 2>/dev/null || true; }
put() { printf '%s\n' "$2" >"$s/$1"; }
screen=$(get screen)
screen=${screen:-home}
routine_row='id="routine-row" label="Upper body strength, Barbell Bench Press - Medium Grip, Bent Over Barbell Row, Standing Military Press"'
program_rows='id="routine-row" label="Day 1 Push, Barbell Bench Press - Medium Grip, Standing Military Press, Dips - Triceps Version"
id="routine-row" label="Day 2 Pull, Barbell Deadlift, Pullups, Seated Cable Rows"
id="routine-row" label="Day 3 Legs, Barbell Squat, Romanian Deadlift, Lying Leg Curls"
id="folder-name" label="Coach 3-day split"'
kind_of() {
  case "$1" in
    "Upper body strength") echo routine ;;
    "Coach 3-day split") echo program ;;
  esac
}
# on_train <kind>: the Train tab lists what the proposal created.
on_train() {
  local state
  state=$(get "status-$1")
  [[ "$state" == applied || ("$state" == pending && -n "${FAKE_TRAIN_EARLY:-}") ||
    ("$state" == undone && -n "${FAKE_UNDO_KEEPS:-}") ]]
}
status_text() {
  case "$(get "status-$(kind_of "$(get current)")")" in
    pending) echo "Not applied. Nothing is saved until you tap Apply." ;;
    applied) echo "Applied. It is on the Train tab." ;;
    undone) echo "Undone. svett removed what Apply created." ;;
  esac
}
# holds <selector>: the element is on the screen in front, maybe below the fold.
holds() {
  case "$1" in
    'label="You, tab, 5 of 5"') [[ "$screen" != home ]] ;;
    'id="start-empty-workout"') [[ "$screen" == train ]] ;;
    'id="coach"' | 'id="coach-answer"') [[ "$screen" == coach ]] ;;
    'role="button" label="Preview Upper body strength"') [[ "$screen" == coach && -f "$s/asked-routine" ]] ;;
    'role="button" label="Preview Coach 3-day split"') [[ "$screen" == coach && -f "$s/asked-program" ]] ;;
    'role="button" label="Preview Leg day"') [[ "$screen" == coach && -f "$s/asked-malformed" && -n "${FAKE_LEG_CARD:-}" ]] ;;
    'id="coach-proposal-error"') [[ "$screen" == coach && -f "$s/asked-malformed" && -z "${FAKE_NO_REFUSAL:-}" ]] ;;
    'id="routine-list"') [[ "$screen" == train ]] ;;
    "$routine_row") [[ "$screen" == train ]] && on_train routine ;;
    'id="routine-row" label='* | 'id="folder-name" label='*)
      [[ "$screen" == train ]] && grep -qxF -- "$1" <<<"$program_rows" && on_train program ;;
    'id="proposal"' | 'id="proposal-'*) [[ "$screen" == proposal ]] ;;
    'role="button" label="Apply"') [[ "$screen" == proposal && "$(get "status-$(kind_of "$(get current)")")" == pending ]] ;;
    'role="button" label="Undo"') [[ "$screen" == proposal && "$(get "status-$(kind_of "$(get current)")")" == applied ]] ;;
    *) return 1 ;;
  esac
}
# shows <selector>: the element, or one of a || fallback's, is on screen.
shows() {
  local one
  while IFS= read -r one; do
    holds "$one" && ! below_fold "$one" && [[ "$one" != 'id="coach-answer"' ]] && return 0
  done < <(sed 's/ || /\n/g' <<<"$1")
  return 1
}
# below_fold <selector>: an element only a scroll brings on screen. The routine
# list starts below Start empty workout and Cardio at the largest text size.
below_fold() {
  case "$1" in
    'id="routine-list"' | 'role="button" label="Preview '* | 'id="coach-proposal-error"' | 'id="routine-row"'* | 'id="folder-name"'* | \
      'id="proposal-end"' | 'id="proposal-set-'* | 'id="proposal-routine-'*) return 0 ;;
    *) return 1 ;;
  esac
}
press() {
  local target kind
  (($2 <= 840)) || return 0
  target=$(get target)
  case "$target" in
    'role="button" label="Preview '*)
      kind=${target#role=\"button\" label=\"Preview }
      put current "${kind%\"}"
      put screen proposal ;;
    'role="button" label="Apply"') put "status-$(kind_of "$(get current)")" applied ;;
    'role="button" label="Undo"') put "status-$(kind_of "$(get current)")" undone ;;
    *) exit 1 ;;
  esac
}
case "$1" in
  settings | screenshot) ;;
  gesture) touch "$s/dragged" ;;
  open)
    case "$3" in
      --relaunch)
        put screen tabs
        stub="$*"
        stub=${stub##*coach-propose-}
        put stub "${stub%.json}" ;;
      svett://coach\?ask=*)
        kind=$(get stub)
        touch "$s/asked-$kind"
        [[ -n "$(get "status-$kind")" ]] || put "status-$kind" pending
        rm -f "$s/dragged"
        put screen coach ;;
      svett://coach) put screen coach ;;
      svett://train) put screen train ;;
      *) exit 1 ;;
    esac ;;
  wait) [[ "$2" =~ ^[0-9]+$ ]] || shows "$2" ;;
  is) shows "$3" ;;
  scroll)
    touch "$s/gliding"
    holds "$4" ;;
  get)
    holds "$3" || exit 1
    case "$2" in
      text)
        case "$3" in
          'id="proposal-title"') get current ;;
          'id="proposal-status"') status_text ;;
          'id="coach-proposal-error"') echo "svett refused a proposal from the coach, so nothing was saved. Expected no excess property" ;;
          *) echo "" ;;
        esac ;;
      attrs)
        put target "$3"
        y=600
        if [[ -n "${FAKE_CARD_LOW:-}" && "$3" == 'role="button" label="Preview Upper body strength"' && ! -f "$s/dragged" ]]; then
          y=900
        elif [[ -n "${FAKE_GLIDE:-}" && -f "$s/gliding" ]]; then
          rm -f "$s/gliding"
          y=640
        fi
        echo "{\"rect\": {\"x\": 16, \"y\": $((y - 25)), \"width\": 408, \"height\": 50}}" ;;
    esac ;;
  press) press "$2" "$3" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fake/proposals-device"

# run_proposals [VAR=value...] [proposals.sh args...] leaves the exit status in proposals_status.
run_proposals() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/proposals-state"
  proposals_status=0
  env PATH="$fake:$PATH" HOME="$root/home" FAKE_ROOT="$root" FAKE_STATE="$root/proposals-state" \
    SVETT_DEVICE_CMD="proposals-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/proposals.sh" "$@" >"$output" 2>&1 || proposals_status=$?
}

stub_args() {
  echo "--launch-args=-svettFixture --launch-args=$documents/svett-fixture.db $coach_signed_in --launch-args=-svettCoachStub --launch-args=$documents/coach-propose-$1.json"
}
ask_of() {
  echo "com.kron00.svett svett://coach?ask=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1")"
}
routine_ask=$(ask_of "Plan an upper body routine for me")
program_ask=$(ask_of "Plan a three-day push, pull and legs program for me")
malformed_ask=$(ask_of "Plan a leg day for me")
to_coach="com.kron00.svett svett://coach"
to_train="com.kron00.svett svett://train"
upper_row='id="routine-row" label="Upper body strength, Barbell Bench Press - Medium Grip, Bent Over Barbell Row, Standing Military Press"'

# presses_clear_of_the_edge checks every press is at a point above the home indicator.
presses_clear_of_the_edge() {
  local pressed
  pressed=$(grep -E "^$bound_prefix press " "$root/bound-calls" | awk '{ print $NF }')
  [[ -n "$pressed" ]] && ! awk '$1 > 840 { found = 1 } END { exit !found }' <<<"$pressed"
}

case_name="proposals.sh Debug with SVETT_DEVICE_CMD"
run_proposals "$root/proposals"
[[ "$proposals_status" == 0 ]] || fail "proposals.sh failed"
check "proposals.sh copies the fixture and the three proposal stand-ins into the app's data container" \
  test "$(cat "$documents/svett-fixture.db")" == "fake fixture" -a \
  -s "$documents/coach-propose-routine.json" -a -s "$documents/coach-propose-program.json" -a \
  -s "$documents/coach-propose-malformed.json"
check "proposals.sh relaunches on each stand-in signed in, asks by link, and checks the Train tab around Apply and Undo" \
  only_open \
  "$debug_open $(stub_args routine)" "$routine_ask" "$to_train" "$to_coach" "$to_train" "$to_coach" "$to_train" \
  "$debug_open $(stub_args program)" "$program_ask" "$to_train" "$to_coach" "$to_train" "$to_coach" "$to_train" \
  "$debug_open $(stub_args malformed)" "$malformed_ask"
check "proposals.sh presses Apply and Undo in the header, and the cards, at their centres" \
  only_calls "get attrs role=\"button\" label=\"(Apply|Undo|Preview)" \
  'get attrs role="button" label="Preview Upper body strength"' 'get attrs role="button" label="Preview Upper body strength"' \
  'get attrs role="button" label="Apply"' 'get attrs role="button" label="Apply"' \
  'get attrs role="button" label="Preview Upper body strength"' 'get attrs role="button" label="Preview Upper body strength"' \
  'get attrs role="button" label="Undo"' 'get attrs role="button" label="Undo"' \
  'get attrs role="button" label="Preview Coach 3-day split"' 'get attrs role="button" label="Preview Coach 3-day split"' \
  'get attrs role="button" label="Apply"' 'get attrs role="button" label="Apply"' \
  'get attrs role="button" label="Preview Coach 3-day split"' 'get attrs role="button" label="Preview Coach 3-day split"' \
  'get attrs role="button" label="Undo"' 'get attrs role="button" label="Undo"'
check "proposals.sh reaches the routine on the Train tab by scrolling" \
  bound_got "$bound_prefix scroll down --until $upper_row"
check "proposals.sh looks for the routine on the Train tab before Apply, after Apply and after Undo" \
  only_calls "is visible id=\"routine-row\" label=\"Upper" \
  "is visible $upper_row" "is visible $upper_row" "is visible $upper_row"
check "proposals.sh checks the malformed routine's refusal and that no card shows for it" \
  only_calls "get text id=\"coach-proposal-error\"|is visible role=\"button\" label=\"Preview Leg day\"" \
  'get text id="coach-proposal-error"' 'is visible role="button" label="Preview Leg day"'
check "proposals.sh presses only above the home indicator" presses_clear_of_the_edge
check "proposals.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "proposals.sh screenshots each step" \
  only_calls "screenshot" \
  "screenshot $root/proposals/01-routine-answer.png" "screenshot $root/proposals/02-routine-preview.png" \
  "screenshot $root/proposals/03-routine-preview-end.png" "screenshot $root/proposals/04-routine-applied.png" \
  "screenshot $root/proposals/05-routine-on-train.png" "screenshot $root/proposals/06-routine-undone.png" \
  "screenshot $root/proposals/07-routine-gone.png" "screenshot $root/proposals/08-program-answer.png" \
  "screenshot $root/proposals/09-program-preview.png" "screenshot $root/proposals/10-program-preview-end.png" \
  "screenshot $root/proposals/11-program-on-train.png" "screenshot $root/proposals/12-program-gone.png" \
  "screenshot $root/proposals/13-malformed.png"
check "proposals.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="proposals.sh Release with SVETT_DEVICE_CMD"
run_proposals --release "$root/proposals-release"
[[ "$proposals_status" == 0 ]] || fail "proposals.sh --release failed"
check "proposals.sh Release relaunches the installed app without Metro" \
  bound_got "$bound_prefix open com.kron00.svett --relaunch $(stub_args routine)"

case_name="proposals.sh when the routine is on the Train tab before Apply"
run_proposals FAKE_TRAIN_EARLY=1 "$root/proposals-early"
check "proposals.sh fails when a proposal shows on the Train tab before Apply" test "$proposals_status" -ne 0
check "proposals.sh says the routine was listed before Apply" \
  grep -qF 'The Train tab lists "Upper body strength" before Apply.' "$output"
check "proposals.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="proposals.sh when Undo leaves the routine on the Train tab"
run_proposals FAKE_UNDO_KEEPS=1 "$root/proposals-kept"
check "proposals.sh fails when Undo leaves the routine" test "$proposals_status" -ne 0
check "proposals.sh says the routine is still listed after Undo" \
  grep -qF 'The Train tab still lists "Upper body strength" after Undo.' "$output"

case_name="proposals.sh when the malformed routine shows no refusal"
run_proposals FAKE_NO_REFUSAL=1 "$root/proposals-silent"
check "proposals.sh fails without the refusal" test "$proposals_status" -ne 0
check "proposals.sh says the answer to the malformed routine never ended in a refusal" \
  grep -qF 'The coach'"'"'s answer to "Plan a leg day for me" did not show.' "$output"

case_name="proposals.sh when the malformed routine shows a card"
run_proposals FAKE_LEG_CARD=1 "$root/proposals-leg-card"
check "proposals.sh fails when a card shows for the malformed routine" test "$proposals_status" -ne 0
check "proposals.sh says the malformed routine got a card" \
  grep -qF 'The chat shows a card for the malformed "Leg day".' "$output"

case_name="proposals.sh when the card sits at the bottom edge"
run_proposals FAKE_CARD_LOW=1 "$root/proposals-low"
[[ "$proposals_status" == 0 ]] || fail "proposals.sh failed with the card at the bottom edge"
check "proposals.sh drags the card up before it presses it" \
  bound_got "$bound_prefix gesture pan 20 600 0 -300 400"
check "proposals.sh presses the card only once it is clear of the bottom edge" presses_clear_of_the_edge

case_name="proposals.sh when an element glides after a scroll"
run_proposals FAKE_GLIDE=1 "$root/proposals-glide"
[[ "$proposals_status" == 0 ]] || fail "proposals.sh failed while elements glide"
check "proposals.sh waits until two reads of the frame agree, then presses where it settled" \
  test "$(grep -cE "^$bound_prefix press 220 600$" "$root/bound-calls")" -eq 8 -a \
  "$(grep -cE "^$bound_prefix press " "$root/bound-calls")" -eq 8


# Stands in for the bound command on Record and the saved activity. It tracks what
# is in front: the Home Screen, the tab root, Record before a recording, while
# recording, paused, or the activity. Like checks-device, a Debug open by bundle id
# alone leaves the Home Screen in front, and otherwise svett comes back where it
# was, or on its tab root with FAKE_RELOAD, or not at all with FAKE_STAYS_HOME.
# Pressing Finish saves a run recorded along the proof route into the app's
# database, 100 m short with FAKE_SHORT. With FAKE_NO_START, Start does nothing.
# The activity's hide setting shows after FAKE_ACTIVITY_SCROLLS scrolls, default 2.
# Every button has the same frame, except that with FAKE_START_LOW Start sits at the
# screen's bottom edge until a drag moves it up, or for good when it is "stuck".
# With FAKE_START_FAILS, Start shows that reason above itself instead of starting.
# Like agent-device, it grants a permission only while an app is open.
cat >"$fake/cardio-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
screen=\$(cat "$root/screen" 2>/dev/null || echo home)
left=\$(cat "$root/svett-screen" 2>/dev/null || echo tabs)
recording=\$(cat "$root/recording" 2>/dev/null || echo none)
show() {
  echo "\$1" >"$root/screen"
  [[ "\$1" == home ]] || echo "\$1" >"$root/svett-screen"
}
record_screen() {
  if [[ "\$recording" == none ]]; then show setup; else show "\$recording"; fi
}
refuse_on_home() {
  [[ "\$screen" == home ]] || return 0
  echo "\$*" >>"$root/home-screen-actions"
  echo "fake device: \$* while the Home Screen is in front" >&2
  exit 1
}
scrolls() { awk '/ press / { n = 0 } / scroll down 0[.]6\$/ { n++ } END { print n + 0 }' "$root/bound-calls"; }
args=" \$* "
case "\$args" in
  *" home "*) show home ;;
  *" settings permission "*)
    [[ "\$screen" != home ]] || {
      echo "permission setting requires an active app in session" >&2
      exit 1
    } ;;
  *" open com.kron00.svett --relaunch "*) show tabs ;;
  *" open com.kron00.svett svett://record "*) record_screen ;;
  *" open com.kron00.svett "*)
    if [[ -n "\${FAKE_STAYS_HOME:-}" ]] || [[ -z "\${FAKE_RELEASE:-}" && "\$args" != *" --launch-url "* ]]; then
      :
    elif [[ -n "\${FAKE_RELOAD:-}" ]]; then
      show tabs
    else
      show "\$left"
    fi ;;
  *" scroll "*) refuse_on_home scroll ;;
  *" gesture "*) refuse_on_home gesture ;;
  *" press "*)
    refuse_on_home press
    attrs=\$(cat "$root/last-attrs")
    # A press on the bottom edge lands on the home indicator, as on iOS 27.
    [[ "\$attrs" != *low* ]] || exit 0
    case "\$screen:\$attrs" in
      setup:*record-start*)
        # With FAKE_FIRST_PRESS_STOPS the first press only stops the screen gliding, as on iOS.
        if [[ -n "\${FAKE_FIRST_PRESS_STOPS:-}" && ! -e "$root/press-stopped" ]]; then
          touch "$root/press-stopped"
          exit 0
        fi
        if [[ -n "\${FAKE_START_FAILS:-}" ]]; then
          echo "\$FAKE_START_FAILS" >"$root/start-problem"
        elif [[ -z "\${FAKE_NO_START:-}" ]]; then
          echo recording >"$root/recording"
          show recording
        fi ;;
      recording:*record-pause*) echo paused >"$root/recording"; show paused ;;
      paused:*record-resume*) echo recording >"$root/recording"; show recording ;;
      paused:*record-finish*)
        node "$repo/scripts/test/cardio-recording.ts" "$repo/scripts/sim/cardio-route.json" \
          "$root/data container/Documents/SQLite/svett-anonymous.db" \${FAKE_SHORT:+--short}
        echo none >"$root/recording"
        show activity ;;
    esac ;;
  *" get attrs "*)
    if [[ -n "\${FAKE_START_LOW:-}" && "\$args" == *record-start* ]] &&
      { [[ "\$FAKE_START_LOW" == stuck ]] || ! grep -q ' gesture pan ' "$root/bound-calls"; }; then
      echo "\$* low" >"$root/last-attrs"
      echo '{"label": "Start run", "rect": {"x": 20, "y": 905, "width": 300, "height": 50}}'
    else
      echo "\$*" >"$root/last-attrs"
      echo '{"label": "Button", "rect": {"x": 20, "y": 600, "width": 300, "height": 50}}'
    fi ;;
  *' id="record-start-problem-text" '*)
    [[ "\$screen" == setup && -s "$root/start-problem" ]] || exit 1
    [[ "\$args" != *" get text "* ]] || cat "$root/start-problem" ;;
  *' label="Train, tab, 2 of 5" '*) [[ "\$screen" != home ]] ;;
  *' id="record-cardio" '*) [[ "\$screen" =~ ^(setup|recording|paused)\$ ]] ;;
  *' id="record-start" '*) [[ "\$screen" == setup ]] ;;
  *' id="record-pause" '*) [[ "\$screen" == recording ]] ;;
  *' id="record-resume" '* | *' id="record-finish" '*) [[ "\$screen" == paused ]] ;;
  *' id="activity" '* | *' id="activity-distance" '*) [[ "\$screen" == activity ]] ;;
  *' id="activity-hide" '*) [[ "\$screen" == activity ]] && ((\$(scrolls) >= \${FAKE_ACTIVITY_SCROLLS:-2})) ;;
  *" alert wait "*) exit 1 ;;
esac
EOF
chmod +x "$fake/cardio-device"

# run_cardio [VAR=value...] [cardio.sh args...] leaves the exit status in cardio_status.
run_cardio() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/screen" "$root/svett-screen" \
    "$root/recording" "$root/home-screen-actions" "$root/data container/Documents" "$root/press-stopped" \
    "$root/start-problem"
  cardio_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="cardio-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/cardio.sh" "$@" >"$output" 2>&1 || cardio_status=$?
}

# cardio_sh [VAR=value...] [cardio.sh args...]
cardio_sh() {
  run_cardio "$@"
  [[ "$cardio_status" == 0 ]] || fail "cardio.sh $* failed"
}

# simctl_location <expected location call>... checks the simctl location calls, in order.
simctl_location() {
  local calls expected
  calls=$(grep -E '^simctl location ' "$root/simctl-calls" || true)
  expected=$(printf '%s\n' "$@")
  [[ "$calls" == "$expected" ]] || {
    { echo "simctl location calls:"; echo "$calls"; } >>"$output"
    fail "simctl did not get exactly these location calls: $expected"
  }
}

# goes_home_after_start checks svett goes to the Home Screen right after the
# recording screenshot, so the first leg plays as if the screen were locked.
goes_home_after_start() {
  local after
  after=$(sed "s/^$bound_prefix //" "$root/bound-calls" |
    grep -A1 -xF "screenshot $1/02-recording.png" | sed -n 2p)
  [[ "$after" == home ]] || fail "after the recording screenshot came \"$after\", not home"
}

leg_one="37.33,-122.03 37.335314,-122.028822 37.339447,-122.024459"
leg_two="37.339447,-122.024459 37.344761,-122.02328 37.348895,-122.018917"
cardio_press="press 170 625"

case_name="cardio.sh Debug with SVETT_DEVICE_CMD"
cardio_sh "$root/cardio"
check "cardio.sh never scrolls or presses while the Home Screen is in front" never_acts_on_home_screen
check "cardio.sh relaunches into the dev client twice, opens Record by link, and comes back without a relaunch" \
  only_open "$debug_open" "$debug_open" "com.kron00.svett svett://record" "$debug_front"
check "cardio.sh presses Start, Pause, Resume, Pause and Finish at their centres, in that order" \
  only_calls "get attrs|press" \
  'get attrs id="record-start"' "$cardio_press" 'get attrs id="record-pause"' "$cardio_press" \
  'get attrs id="record-resume"' "$cardio_press" 'get attrs id="record-pause"' "$cardio_press" \
  'get attrs id="record-finish"' "$cardio_press"
check "cardio.sh starts at the route's first waypoint, plays each leg at its speed, then clears the route" \
  simctl_location "simctl location FAKE-UDID set 37.33,-122.03" \
  "simctl location FAKE-UDID start --speed=6 --interval=1 $leg_one" \
  "simctl location FAKE-UDID start --speed=6 --interval=1 $leg_two" \
  "simctl location FAKE-UDID clear"
check "cardio.sh plays the first leg with svett on the Home Screen" goes_home_after_start "$root/cardio"
check "cardio.sh waits out each leg and the pause" only_calls "wait [0-9]+$" \
  "wait 210000" "wait 5000" "wait 211000" "wait 3000"
check "cardio.sh grants location once svett is open, then relaunches it before Record" \
  only_calls "open|settings permission" \
  "open $debug_open" "settings permission grant location-always" "open $debug_open" \
  "open com.kron00.svett svett://record" "open $debug_front"
check "cardio.sh has location granted, so no prompt stops the start" \
  bash -c '! grep -qF "Could not grant location" "$1"' _ "$output"
check "cardio.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "cardio.sh screenshots each step and pages through the activity" \
  only_calls "screenshot" \
  "screenshot $root/cardio/01-start.png" "screenshot $root/cardio/02-recording.png" \
  "screenshot $root/cardio/03-after-home-screen.png" "screenshot $root/cardio/04-paused.png" \
  "screenshot $root/cardio/05-second-leg.png" "screenshot $root/cardio/06-activity-01.png" \
  "screenshot $root/cardio/07-activity-02.png" "screenshot $root/cardio/08-activity-03.png"
check "cardio.sh saves a proof that the distance is within 1%" \
  grep -qF "PASSED: Distance" "$root/cardio/proof.txt"
check "cardio.sh saves a proof that the splits add up" \
  grep -qF "PASSED: 3 splits add up to" "$root/cardio/proof.txt"
check "cardio.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="cardio.sh Release with SVETT_DEVICE_CMD"
cardio_sh FAKE_RELEASE=1 --release "$root/cardio-release"
check "cardio.sh Release relaunches the installed app without Metro and comes back by bundle id" \
  only_open "com.kron00.svett --relaunch" "com.kron00.svett --relaunch" "com.kron00.svett svett://record" \
  com.kron00.svett

case_name="cardio.sh when the dev client reloads on its way back"
cardio_sh FAKE_RELOAD=1 "$root/cardio-reload"
check "cardio.sh opens Record by link again after svett comes back on its tab root" \
  only_open "$debug_open" "$debug_open" "com.kron00.svett svett://record" "$debug_front" \
  "com.kron00.svett svett://record"
check "cardio.sh still proves the recording after a reload" \
  grep -qF "PASSED: Distance" "$root/cardio-reload/proof.txt"

case_name="cardio.sh when svett stays in the background"
run_cardio FAKE_STAYS_HOME=1 "$root/cardio-home"
check "cardio.sh fails when svett does not come back" test "$cardio_status" -ne 0
check "cardio.sh says svett did not come back" grep -qF "svett did not come back to the foreground" "$output"
check "cardio.sh does not scroll or press on the Home Screen when svett stays away" never_acts_on_home_screen

case_name="cardio.sh when the recording does not start"
run_cardio FAKE_NO_START=1 "$root/cardio-no-start"
check "cardio.sh fails when Start does not start a recording" test "$cardio_status" -ne 0
check "cardio.sh says the recording did not start and svett gave no reason" \
  grep -qxF "The recording did not start, and svett showed no reason" "$output"
check "cardio.sh presses Start twice when nothing happens and no reason shows" \
  test "$(grep -c -- "$cardio_press" "$root/bound-calls")" -eq 2
check "cardio.sh screenshots the Record screen when the start fails" \
  bound_got "$bound_prefix screenshot $root/cardio-no-start/02-start-failed.png"
check "cardio.sh clears the simulated location after a failure" simctl_got "simctl location FAKE-UDID clear"

case_name="cardio.sh when Start fails with a reason"
reason="The recording did not start, at the location step. Location services are disabled"
run_cardio FAKE_RELEASE=1 "FAKE_START_FAILS=$reason" --release "$root/cardio-start-fails"
check "cardio.sh fails when svett shows why Start failed" test "$cardio_status" -ne 0
check "cardio.sh prints svett's reason word for word" \
  grep -qxF "The recording did not start. svett says \"$reason\"" "$output"
check "cardio.sh presses Start once, since svett said why it did not start" \
  test "$(grep -c -- "$cardio_press" "$root/bound-calls")" -eq 1
check "cardio.sh reads the reason from above Start" \
  bound_got "$bound_prefix get text id=\"record-start-problem-text\""

case_name="cardio.sh when Start sits at the screen's bottom edge"
cardio_sh FAKE_RELEASE=1 FAKE_START_LOW=1 --release "$root/cardio-low"
check "cardio.sh drags Start up from the bottom edge before pressing it" \
  only_calls "gesture pan" "gesture pan 20 600 0 -300 400"
check "cardio.sh presses Start only once it is clear of the bottom edge" \
  only_calls "get attrs|press" \
  'get attrs id="record-start"' 'get attrs id="record-start"' 'get attrs id="record-start"' "$cardio_press" \
  'get attrs id="record-pause"' "$cardio_press" 'get attrs id="record-resume"' "$cardio_press" \
  'get attrs id="record-pause"' "$cardio_press" 'get attrs id="record-finish"' "$cardio_press"

case_name="cardio.sh when Start stays at the screen's bottom edge"
run_cardio FAKE_RELEASE=1 FAKE_START_LOW=stuck --release "$root/cardio-stuck"
check "cardio.sh fails when Start never clears the bottom edge" test "$cardio_status" -ne 0
check "cardio.sh says Start stayed at the bottom edge" \
  grep -qF 'id="record-start" stayed at the bottom edge of the screen' "$output"
check "cardio.sh never presses Start on the bottom edge" \
  test "$(grep -c -- " press " "$root/bound-calls")" -eq 0

case_name="cardio.sh when the first press on Start only stops the screen gliding"
cardio_sh FAKE_RELEASE=1 FAKE_START_LOW=1 FAKE_FIRST_PRESS_STOPS=1 --release "$root/cardio-glide"
check "cardio.sh presses Start again when the recording has not started" \
  test "$(grep -c -- "$cardio_press" "$root/bound-calls")" -eq 6

case_name="cardio.sh when the saved run is short of the route"
run_cardio FAKE_RELEASE=1 FAKE_SHORT=1 --release "$root/cardio-short"
check "cardio.sh fails when the distance is more than 1% off" test "$cardio_status" -ne 0
check "cardio.sh still saves the proof that failed" grep -qF "FAILED: Distance" "$root/cardio-short/proof.txt"

case_name="cardio.sh when the activity never reaches its hide setting"
run_cardio FAKE_RELEASE=1 FAKE_ACTIVITY_SCROLLS=99 --release "$root/cardio-endless"
check "cardio.sh fails when the activity's last section never shows" test "$cardio_status" -ne 0
check "cardio.sh stops paging after 15 pages" \
  grep -qF "The activity's hide setting was not on screen after 15 pages" "$output"

# health.sh runs against the real proof files, the real seed and checks, and a fake
# device that stands in for svett. Pressing Import imports the file the last link
# opened into the database svett launched on, as svett does, and pressing Save
# saves the manual ride. Like agent-device, wait and is visible see only what is on
# screen. At the largest text size each screen's buttons and lower sections sit
# below it until the screen scrolls, and a press there does nothing.
# FAKE_DECLINE_SAVES makes Don't import import anyway, FAKE_KEEP_BOTH imports the
# duplicate as its own workout instead of linking it, FAKE_NO_SOURCES never shows the
# linked workout's sources, FAKE_SUMMARY is the line atop every preview, and
# FAKE_BOTTOM_EDGE leaves each button on the bottom edge until a drag.
{
  printf '#!/usr/bin/env bash\nroot=%q\nrepo=%q\n' "$root" "$repo"
  cat <<'EOF'
echo "$*" >>"$root/bound-calls"
documents="$root/data container/Documents"
app() { node "$repo/scripts/test/health-app.ts" "$@"; }
set -- "${@:5}"
# A new screen starts at its top.
new_screen() { rm -f "$root/scrolled" "$root/dragged"; }
below() {
  [[ "$(cat "$root/text-size" 2>/dev/null)" == accessibility-extra-extra-extra-large && ! -e "$root/scrolled" ]] ||
    return 1
  case "$1" in
    *health-decline* | *health-apply* | *health-duplicate-* | *health-nothing-new* | *health-new* | \
      *'label="Done"'* | *manual-save* | *activity-heart-* | *activity-sources* | *activity-notes*) ;;
    *) return 1 ;;
  esac
}
shown() { ! below "$1" && [[ "$1" != 'id="activity-sources"' || -z "${FAKE_NO_SOURCES:-}" ]]; }
case "$1" in
  settings) [[ "$2" != text-size ]] || echo "$3" >"$root/text-size" ;;
  open)
    new_screen
    [[ "${3:-}" != svett://health-import\?file=* ]] || echo "${3#*file=}" >"$root/health-file" ;;
  wait)
    [[ "$2" == absent || "$2" =~ ^[0-9]+$ ]] || shown "$2" || {
      echo "wait timed out for selector: $2" >&2
      exit 1
    } ;;
  is) shown "$3" ;;
  scroll)
    [[ "${3:-}" != --until || "$4" != 'id="activity-sources"' || -z "${FAKE_NO_SOURCES:-}" ]] || exit 1
    touch "$root/scrolled" ;;
  gesture) touch "$root/dragged" ;;
  get)
    case "$2" in
      text)
        if [[ -n "${FAKE_SUMMARY:-}" ]]; then
          echo "$FAKE_SUMMARY"
        else
          app summary "$documents/$(cat "$root/health-file")"
        fi ;;
      attrs)
        y=300
        if below "$3"; then
          y=1100
        elif [[ -n "${FAKE_BOTTOM_EDGE:-}" && ! -e "$root/dragged" ]]; then
          y=870
        fi
        echo "$3" >"$root/last-attrs"
        echo "{\"rect\": {\"x\": 20, \"y\": $y, \"width\": 120, \"height\": 40}}" ;;
    esac ;;
  press)
    if (($3 > 880)); then
      echo "$*" >>"$root/edge-presses"
      exit 0
    fi
    file="$documents/$(cat "$root/health-file" 2>/dev/null)"
    case "$(cat "$root/last-attrs")" in
      *health-apply*)
        app import "$documents/svett-health.db" "$file" ${FAKE_KEEP_BOTH:+--keep-both}
        new_screen ;;
      *health-decline*) [[ -z "${FAKE_DECLINE_SAVES:-}" ]] || app import "$documents/svett-health.db" "$file" ;;
      *manual-save*)
        app manual "$documents/svett-health.db"
        new_screen ;;
    esac ;;
esac
EOF
} >"$data_fake/health-device"
chmod +x "$data_fake/health-device"

# run_health [VAR=value...] [health.sh args...] leaves the exit status in health_status.
run_health() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/health-file" "$root/data container" \
    "$root/text-size" "$root/scrolled" "$root/dragged" "$root/edge-presses"
  health_status=0
  env PATH="$data_fake:$fake:$PATH" SVETT_DEVICE_CMD="health-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/health.sh" "$@" >"$output" 2>&1 || health_status=$?
}

health_args="--launch-args=-svettFixture --launch-args=$documents/svett-health.db"
health_link="com.kron00.svett svett://health-import?file=svett-health-export.zip"
gpx_link="com.kron00.svett svett://health-import?file=svett-ride.gpx"
manual_link="com.kron00.svett $(node "$repo/scripts/health-proof.ts" manual-link)"

case_name="the fake device at the largest text size, as agent-device sees it"
health_device() {
  env PATH="$data_fake:$PATH" health-device --session 't3-test session' --device FAKE-UDID "$@" 2>>"$output"
}
health_device_refuses() { ! health_device "$@"; }
rm -rf "$root/bound-calls" "$root/text-size" "$root/scrolled"
health_device settings text-size accessibility-extra-extra-extra-large
health_device open com.kron00.svett "svett://health-import?file=svett-health-export.zip"
check "the wait for Don't import that 406f10a made times out, since the button is below the screen" \
  health_device_refuses wait 'id="health-decline"' 180000
check "the wait for the line atop the preview passes" health_device wait 'id="health-summary"' 180000
check "Don't import is not visible until the screen scrolls" health_device_refuses is visible 'id="health-decline"'
health_device scroll down --until 'id="health-decline"'
check "Don't import is visible once the screen scrolls to it" health_device is visible 'id="health-decline"'

case_name="health.sh Debug with SVETT_DEVICE_CMD"
run_health "$root/health proof"
[[ "$health_status" == 0 ]] || fail "health.sh failed"
hevy_link=$(grep -oE 'svett://activity/[0-9a-f-]+' "$root/bound-calls" | head -1)
check "health.sh previews and declines, imports, imports again, imports the GPX ride, opens the linked workout and enters a ride" \
  only_open "$debug_open $health_args" "$health_link" "$health_link" "$health_link" "$gpx_link" \
  "com.kron00.svett $hevy_link" "$manual_link"
check "health.sh waits for the top of each screen, not for a button below it" \
  only_calls "wait id|wait label|wait role" 'wait label="You, tab, 5 of 5" 120000' \
  'wait id="health-summary" 180000' 'wait id="health-summary" 180000' \
  'wait id="health-done" 300000' 'wait id="health-summary" 180000' 'wait id="health-summary" 180000' \
  'wait id="health-done" 60000' 'wait id="activity" 180000' 'wait id="manual-cardio" 180000' \
  'wait id="activity" 30000'
check "health.sh scrolls each button on screen before it reads where it is" \
  only_calls "scroll down --until" 'scroll down --until id="health-duplicate-0"' \
  'scroll down --until role="button" label="Done"' 'scroll down --until id="health-nothing-new"' \
  'scroll down --until id="health-new"' 'scroll down --until role="button" label="Done"'
check "health.sh presses Don't import, Import, Done by its role and Save at their centres" \
  only_calls "get attrs" 'get attrs id="health-decline"' 'get attrs id="health-apply"' \
  'get attrs role="button" label="Done"' 'get attrs role="button" label="Done"' 'get attrs id="health-apply"' \
  'get attrs role="button" label="Done"' 'get attrs id="manual-save"'
check "health.sh never presses below the screen or on its bottom edge" test ! -e "$root/edge-presses"
check "health.sh passes every database check, the duplicate link and the manual ride included" \
  bash -c '! grep -q FAILED "$1" && grep -qF "PASSED: imported, the Hevy workout gained the Health heart rate" "$1" &&
    grep -qF "PASSED: manual, the manual ride saved" "$1"' _ "$root/health proof/proof.txt"
check "health.sh says in proof.txt that the export holds one entry svett cannot read, on purpose" \
  grep -qF "PASSED: preview of svett-health-export.zip, the export reads as 4 workouts and 1 entry svett cannot read, the run the sample dates with text that is not a date on purpose" \
  "$root/health proof/proof.txt"
check "health.sh checks the GPX preview too" \
  grep -qF "PASSED: preview of svett-ride.gpx" "$root/health proof/proof.txt"
check "health.sh shoots at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "health.sh screenshots every step" only_calls "screenshot" \
  "screenshot $root/health proof/01-preview-01.png" "screenshot $root/health proof/02-preview-02.png" \
  "screenshot $root/health proof/03-declined.png" "screenshot $root/health proof/04-duplicate.png" \
  "screenshot $root/health proof/05-imported.png" "screenshot $root/health proof/06-import-again.png" \
  "screenshot $root/health proof/07-gpx-preview.png" "screenshot $root/health proof/08-gpx-imported.png" \
  "screenshot $root/health proof/09-linked-workout-01.png" "screenshot $root/health proof/10-linked-workout-02.png" \
  "screenshot $root/health proof/11-manual-01.png" "screenshot $root/health proof/12-manual-02.png" \
  "screenshot $root/health proof/13-manual-ride-01.png" "screenshot $root/health proof/14-manual-ride-02.png"
check "health.sh puts the sample export and GPX ride in svett's Documents" \
  test -s "$documents/svett-health-export.zip" -a -s "$documents/svett-ride.gpx"
check "health.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="health.sh Release with SVETT_DEVICE_CMD"
run_health --release "$root/health-release"
[[ "$health_status" == 0 ]] || fail "health.sh --release failed"
check "health.sh Release relaunches the installed app without Metro" \
  bound_got "$bound_prefix open com.kron00.svett --relaunch $health_args"

case_name="health.sh when each button sits on the screen's bottom edge"
run_health FAKE_BOTTOM_EDGE=1 "$root/health-edge"
[[ "$health_status" == 0 ]] || fail "health.sh failed with buttons on the bottom edge"
check "health.sh drags each of its seven buttons up before pressing it" \
  test "$(grep -c -- " gesture pan 20 600 0 -300 400" "$root/bound-calls")" -eq 7
check "health.sh never presses on the bottom edge" test ! -e "$root/edge-presses"
check "health.sh still passes every database check" bash -c '! grep -q FAILED "$1"' _ "$root/health-edge/proof.txt"

case_name="health.sh when the preview does not say what the export holds"
run_health "FAKE_SUMMARY=An Apple Health export with 4 workouts." "$root/health-summary"
check "health.sh fails when the preview leaves out the entry svett cannot read" test "$health_status" -ne 0
check "health.sh names the preview that is wrong" \
  grep -qF "The preview of svett-health-export.zip is not what the proof expects" "$output"
check "health.sh shows what svett showed" \
  grep -qF 'svett shows "An Apple Health export with 4 workouts."' "$output"
check "health.sh stops before it declines" bash -c '! grep -qF "get attrs" "$1"' _ "$root/bound-calls"

case_name="health.sh when Don't import saves the workouts"
run_health FAKE_DECLINE_SAVES=1 "$root/health-decline"
check "health.sh fails when declining imports anything" test "$health_status" -ne 0
check "health.sh names the declined step" \
  grep -qF "The database is not as the declined step leaves it" "$output"
check "health.sh shows which check failed" grep -qF "FAILED: declined, 1 workout and 9 sets" "$output"
check "health.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="health.sh when the duplicate is not linked"
run_health FAKE_KEEP_BOTH=1 "$root/health-keep-both"
check "health.sh fails when the Health copy of the Hevy workout is not linked" \
  grep -qF "FAILED: imported, the Hevy workout records Apple Health as a linked source" "$output"

case_name="health.sh when the linked workout never shows its sources"
run_health FAKE_NO_SOURCES=1 "$root/health-no-sources"
check "health.sh fails when the linked workout's sources never show" test "$health_status" -ne 0
check "health.sh stops paging after 15 pages" \
  grep -qF 'id="activity-sources" was not on screen after 15 pages' "$output"

echo "$passed passed"
