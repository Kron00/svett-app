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
    '-- iOS 27.2 --' '    svett iPhone 16 Pro Max (FAKE-UDID) (Booted)' \
    '    svett iPhone 16 Pro Max B (FAKE-UDID-B) (Booted)' ;;
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
    fi ;;
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

# Stands in for the bound commands of two phones on one account, told apart by
# --device FAKE-A or FAKE-B, and for the server between them. Each phone keeps its
# screen, its sign-in, its custom exercises and the ones it has not uploaded. A
# relaunch with -svettServer in its launch arguments is offline until the next
# relaunch. Sync now uploads and then downloads every exercise when online, and
# otherwise says how many changes wait. Sync now and Save start below the fold,
# so only a scroll finds them. FAKE_LOST names a phone whose uploads never reach
# the server, and FAKE_ALWAYS_ONLINE ignores -svettServer.
cat >"$fake/sync-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
args=" \$* "
device=\${args#* --device }
device=\${device%% *}
state="$root/sync-state/\$device"
server="$root/sync-state/server"
mkdir -p "\$state"
touch "\$server" "\$state/custom" "\$state/queue"
get() { cat "\$state/\$1" 2>/dev/null || echo "\$2"; }
put() { echo "\$2" >"\$state/\$1"; }
screen=\$(get screen home)
step=\$(get step choose)
scrolled=\$(get scrolled no)
show() { put screen "\$1"; put scrolled no; }
id_of() { sed -nE 's/.*id="([^"]+)".*/\1/p' <<<"\$1"; }
decode() { node -e 'process.stdout.write(decodeURIComponent(process.argv[1]))' "\$1"; }
waiting() {
  local count
  count=\$(grep -c . "\$state/queue" || true)
  if [[ "\$count" == 1 ]]; then
    echo "Cannot reach svett. 1 change waits on this phone, and sync tries again soon."
  else
    echo "Cannot reach svett. \$count changes wait on this phone, and sync tries again soon."
  fi
}
first_result() {
  awk -v q="\$(get query)" 'index(tolower(\$0), tolower(q)) == 1 { print; exit }' "\$state/custom"
}
on_screen() {
  case "\$screen:\$1" in
    account:account) true ;;
    account:*)
      case "\$step:\$1" in
        choose:sign-in-choose | email:sign-in-email | email:email-field | code:sign-in-code | \\
          code:code-field | signedin:signed-in | signedin:sync-status) true ;;
        choose:continue-with-email | email:send-code | code:check-code | signedin:sync-now)
          [[ "\$scrolled" == yes ]] ;;
        *) false ;;
      esac ;;
    form:exercise-form) true ;;
    form:save-exercise) [[ "\$scrolled" == yes ]] ;;
    library:exercise-library) true ;;
    library:exercise-result-0) [[ -n "\$(first_result)" ]] ;;
    *) false ;;
  esac
}
exists() { on_screen "\$1" || { scrolled=yes; on_screen "\$1"; }; }
target=\$(id_of "\$args")
case "\$args" in
  *" open com.kron00.svett --relaunch "*)
    show tabs
    put status "Not synced yet on this launch."
    if [[ "\$args" == *" --launch-args=-svettServer "* && -z "\${FAKE_ALWAYS_ONLINE:-}" ]]; then
      put online no
    else
      put online yes
    fi ;;
  *" open com.kron00.svett svett://account "*) show account ;;
  *" open com.kron00.svett svett://exercises/new?name="*)
    show form
    name=\${args#* svett://exercises/new?name=}
    { decode "\${name%%&*}"; echo; } >"\$state/pending" ;;
  *" open com.kron00.svett svett://exercises?q="*)
    show library
    decode "\${args#* svett://exercises?q=}" | sed 's/ \$//' >"\$state/query" ;;
  *" scroll "*" --until "*) exists "\$target" && put scrolled yes ;;
  *" scroll "*) put scrolled yes ;;
  *' get attrs id="exercise-result-0" '*)
    on_screen exercise-result-0 || exit 1
    printf '{"label": "%s, Chest · Cable", "rect": {"x": 0, "y": 200, "width": 440, "height": 80}}\n' "\$(first_result)" ;;
  *" get attrs "*)
    on_screen "\$target" || exit 1
    put last "\$target"
    echo '{"label": "Field", "rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" fill 80 320 "*) put "\$(get last)" "\${args#* fill 80 320 }" ;;
  *" press 80 320 "*)
    case "\$screen:\$step:\$(get last)" in
      account:choose:continue-with-email) put step email ;;
      account:email:send-code) put step code ;;
      account:code:check-code)
        [[ "\$(get code-field)" == "424242 " ]] || exit 1
        put step signedin ;;
      account:signedin:sync-now)
        if [[ "\$(get online)" == yes ]]; then
          [[ "\${FAKE_LOST:-}" == "\$device" ]] || cat "\$state/queue" >>"\$server"
          : >"\$state/queue"
          sort -u "\$state/custom" "\$server" -o "\$state/custom"
          put status "Up to date"
        else
          put status "\$(waiting)"
        fi ;;
      form:*:save-exercise)
        cat "\$state/pending" >>"\$state/custom"
        cat "\$state/pending" >>"\$state/queue"
        put detail "\$(cat "\$state/pending")"
        show detail ;;
      *) echo "fake device: press on \$(get last) on \$screen at step \$step" >&2; exit 1 ;;
    esac ;;
  *' get text id="sync-status" '*) get status "" ;;
  *' wait id="exercise-name" label='*) [[ "\$screen" == detail && "\$args" == *"label=\"\$(get detail)\" "* ]] ;;
  *' wait label="Train, tab, 2 of 5" '*) [[ "\$screen" != home ]] ;;
  *" wait "[0-9]*) true ;;
  *" is visible "* | *" wait "*) [[ -n "\$target" ]] && on_screen "\$target" ;;
esac
EOF
chmod +x "$fake/sync-device"

# run_sync [VAR=value...] [sync.sh args...] leaves the exit status in sync_status.
run_sync() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/sync-state"
  sync_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="sync-device --session 't3-test session' --device FAKE-A" \
    SVETT_DEVICE_CMD_B="sync-device --session 't3-test session B' --device FAKE-B" \
    SVETT_SYNC_STAMP=1 "${vars[@]}" "$repo/scripts/sim/sync.sh" "$@" >"$output" 2>&1 || sync_status=$?
}

# phone_calls <device pattern> <call pattern> prints the matching bound calls of
# the phones whose device matches, without the session and device.
phone_calls() {
  grep -E -- "--device $1 $2" "$root/bound-calls" |
    sed -E 's/^--session t3-test session( B)? --device FAKE-[AB] //' || true
}

# phone_opens <device> <expected open arguments>... checks that phone's opens, in order.
phone_opens() {
  local device=$1
  shift
  phone_got "$device" "open " "${@/#/open }"
}

# phone_got <device pattern> <call pattern> <expected call>... checks those calls, in order.
phone_got() {
  local device=$1 pattern=$2 got expected
  shift 2
  got=$(phone_calls "$device" "$pattern")
  expected=$(printf '%s\n' "$@")
  [[ "$got" == "$expected" ]] || {
    { echo "phone $device calls:"; echo "$got"; } >>"$output"
    fail "phone $device did not get exactly these calls: $expected"
  }
}

sync_offline="--launch-args=-svettServer --launch-args=http://127.0.0.1:9"
new_a="com.kron00.svett svett://exercises/new?name=Sync%20A%201&muscle=chest&equipment=cable"
new_b="com.kron00.svett svett://exercises/new?name=Sync%20B%201&muscle=chest&equipment=cable"
search_a="com.kron00.svett svett://exercises?q=Sync%20A%201"
search_b="com.kron00.svett svett://exercises?q=Sync%20B%201"
account_link="com.kron00.svett svett://account"
waits="Cannot reach svett. 1 change waits on this phone, and sync tries again soon."

case_name="sync.sh Debug with SVETT_DEVICE_CMD and SVETT_DEVICE_CMD_B"
run_sync "$root/sync"
[[ "$sync_status" == 0 ]] || fail "sync.sh failed"
check "sync.sh stops svett, drops the Clerk sessions and empties svett's data on both simulators" \
  only_simctl "simctl list devices available" "simctl list devices available" \
  "simctl terminate FAKE-UDID com.kron00.svett" "simctl keychain FAKE-UDID reset" \
  "simctl get_app_container FAKE-UDID com.kron00.svett data" \
  "simctl terminate FAKE-UDID-B com.kron00.svett" "simctl keychain FAKE-UDID-B reset" \
  "simctl get_app_container FAKE-UDID-B com.kron00.svett data"
check "sync.sh signs phone A in, edits offline, syncs online twice, then searches for both edits" \
  phone_opens FAKE-A "$debug_open" "$account_link" "$account_link" \
  "$debug_open $sync_offline" "$new_a" "$account_link" "$debug_open" "$account_link" \
  "$debug_open" "$account_link" "$search_a" "$search_b"
check "sync.sh signs phone B in, edits offline, syncs online once, then searches for both edits" \
  phone_opens FAKE-B "$debug_open" "$account_link" "$account_link" \
  "$debug_open $sync_offline" "$new_b" "$account_link" "$debug_open" "$account_link" \
  "$search_a" "$search_b"
check "sync.sh syncs phone A, then B, then A again once both are online" \
  test "$(grep -oE -- "--device FAKE-[AB] open com.kron00.svett --relaunch --launch-url [^ ]+ ?$" "$root/bound-calls" | cut -d' ' -f2 | tail -3 | tr '\n' ' ')" == "FAKE-A FAKE-B FAKE-A "
check "sync.sh signs both phones in to the one test account with the test code" \
  phone_got "FAKE-[AB]" "fill " \
  "fill 80 320 svett-sync-proof+clerk_test@example.com" "fill 80 320 424242" \
  "fill 80 320 svett-sync-proof+clerk_test@example.com" "fill 80 320 424242"
# The drag that closes the keyboard after each field brings Send code and Check
# code on screen.
check "sync.sh scrolls to each button under the fold before it presses it" \
  phone_got FAKE-B "scroll down --until" 'scroll down --until id="continue-with-email"' \
  'scroll down --until id="sync-now"' 'scroll down --until id="save-exercise"' \
  'scroll down --until id="sync-now"' 'scroll down --until id="sync-now"'
check "sync.sh says each phone could not upload its offline edit" \
  test "$(grep -cxF -e "Phone a: $waits" -e "Phone b: $waits" "$output")" == 2
check "sync.sh says both phones find both offline edits" \
  test "$(grep -cE '^Phone [ab] finds "Sync [AB] 1"$' "$output")" == 4
check "sync.sh shoots both phones at the largest text size, then restores the default" \
  phone_got "FAKE-[AB]" "settings text-size" "settings text-size accessibility-extra-extra-extra-large" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large" \
  "settings text-size large"
check "sync.sh screenshots each phone's steps, named by phone" \
  phone_got "FAKE-[AB]" "screenshot" \
  "screenshot $root/sync/01-a-signed-in.png" "screenshot $root/sync/02-b-signed-in.png" \
  "screenshot $root/sync/03-a-offline-edit.png" "screenshot $root/sync/04-b-offline-edit.png" \
  "screenshot $root/sync/05-a-synced.png" "screenshot $root/sync/06-b-synced.png" \
  "screenshot $root/sync/07-a-synced.png" "screenshot $root/sync/08-a-finds-a.png" \
  "screenshot $root/sync/09-a-finds-b.png" "screenshot $root/sync/10-b-finds-a.png" \
  "screenshot $root/sync/11-b-finds-b.png"
check "sync.sh with bound commands calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="sync.sh Release with SVETT_DEVICE_CMD and SVETT_DEVICE_CMD_B"
run_sync --release "$root/sync-release"
[[ "$sync_status" == 0 ]] || fail "sync.sh --release failed"
check "sync.sh Release relaunches the installed app without Metro, offline through the launch arguments" \
  phone_opens FAKE-B "com.kron00.svett --relaunch" "$account_link" "$account_link" \
  "com.kron00.svett --relaunch $sync_offline" "$new_b" "$account_link" \
  "com.kron00.svett --relaunch" "$account_link" "$search_a" "$search_b"

case_name="sync.sh when phone B's edit never reaches the server"
run_sync FAKE_LOST=FAKE-B "$root/sync-lost"
check "sync.sh fails when phone A never gets phone B's edit" test "$sync_status" -ne 0
check "sync.sh says which phone missed which edit" \
  grep -qxF 'Phone a: The search for "Sync B 1" showed no result' "$output"
check "sync.sh restores the default text size on both phones after a failure" \
  phone_got "FAKE-[AB]" "settings text-size large" "settings text-size large" "settings text-size large"

case_name="sync.sh when the offline launch still reaches the server"
run_sync FAKE_ALWAYS_ONLINE=1 "$root/sync-online"
check "sync.sh fails when a phone is not offline for its offline edit" test "$sync_status" -ne 0
check "sync.sh says the phone synced when it should have been offline" \
  grep -qF "Phone a: The sync status should read \"$waits\", but it reads \"Up to date\"" "$output"

case_name="sync.sh with a bound command for phone A only"
run_sync SVETT_DEVICE_CMD_B= "$root/sync-one"
check "sync.sh refuses to run with one bound command" test "$sync_status" -eq 64
check "sync.sh asks for phone B's bound command" grep -qF "SVETT_DEVICE_CMD_B must hold" "$output"

# Stands in for the bound command on the social screens. It tracks the screen, the
# sign-in step, the saved username and the follow of the other profile. Each button
# under a screen's top shows only after a scroll since the screen last changed, so
# the test proves the script scrolls to it. A press or fill lands on the element
# whose attrs were read last. FAKE_NO_CLERK makes Account say the build has no
# Clerk key, FAKE_TAKEN refuses the username, FAKE_NOBODY finds nobody, and
# FAKE_STUCK leaves the follow button as it was.
cat >"$fake/social-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
state="$root/social-state"
get() { cat "\$state/\$1" 2>/dev/null || echo "\$2"; }
put() { echo "\$2" >"\$state/\$1"; }
mkdir -p "\$state"
screen=\$(get screen tabs)
step=\$(get step choose)
scrolled=\$(get scrolled no)
show() { put screen "\$1"; put scrolled no; }
id_of() { sed -nE 's/.*id="([^"]+)".*/\1/p' <<<"\$1"; }
label_of() { sed -nE 's/.*label="([^"]+)".*/\1/p' <<<"\$1"; }
follow_label() { [[ "\$(get follow none)" == requested ]] && echo Requested || echo "Ask to follow"; }
# on_screen <id> is true when the element is on screen now.
on_screen() {
  case "\$screen:\$1" in
    account:account) true ;;
    account:accounts-off) [[ -n "\${FAKE_NO_CLERK:-}" ]] ;;
    account:*) [[ -z "\${FAKE_NO_CLERK:-}" ]] || return 1
      case "\$step:\$1" in
        choose:sign-in-choose | email:sign-in-email | email:email-field | code:sign-in-code | \
          code:code-field | signedin:signed-in) true ;;
        choose:continue-with-email | email:send-code | code:check-code) [[ "\$scrolled" == yes ]] ;;
        *) false ;;
      esac ;;
    edit:username-field) true ;;
    edit:save-profile | own:requests-row) [[ "\$scrolled" == yes ]] ;;
    own:own-username) true ;;
    people:people-search) true ;;
    people:person-social_proof_a) [[ -z "\${FAKE_NOBODY:-}" ]] ;;
    profile:profile-username | profile:follow-button) true ;;
    connections:connections | connections:connections-empty | requests:requests | requests:requests-empty) true ;;
    *) false ;;
  esac
}
label() {
  case "\$1" in
    own-username) get saved "" ;;
    profile-username) echo social_proof_a ;;
    follow-button) follow_label ;;
    *) echo "" ;;
  esac
}
exists() { on_screen "\$1" || { scrolled=yes; on_screen "\$1"; }; }
args=" \$* "
target=\$(id_of "\$args")
case "\$args" in
  *" open com.kron00.svett svett://account "*) show account ;;
  *" open com.kron00.svett svett://profile/edit?username="*)
    put linked "\$(sed -nE 's/.*username=([^ ]+).*/\1/p' <<<"\$args")"
    show edit ;;
  *" open com.kron00.svett svett://profile/requests "*) show requests ;;
  *" open com.kron00.svett svett://profile "*) show own ;;
  *" open com.kron00.svett svett://people?q=social_proof_ "*) show people ;;
  *" open com.kron00.svett svett://people/"*"/followers "*) show connections ;;
  *" open com.kron00.svett "*) show tabs ;;
  *" scroll "*" --until "*) exists "\$target" && put scrolled yes ;;
  *" scroll "*) put scrolled yes ;;
  *" get attrs "*)
    on_screen "\$target" || exit 1
    put last "\$target"
    echo '{"label": "Field", "rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" fill 80 320 "*)
    [[ "\$(get last)" == email-field || "\$(get last)" == code-field ]] || exit 1 ;;
  *" press 80 320 "*)
    case "\$screen:\$step:\$(get last)" in
      account:choose:continue-with-email) put step email ;;
      account:email:send-code) put step code ;;
      account:code:check-code) put step signedin ;;
      edit:*:save-profile) [[ -n "\${FAKE_TAKEN:-}" ]] || { put saved "\$(get linked)"; show tabs; } ;;
      people:*:person-social_proof_a) show profile ;;
      profile:*:follow-button)
        [[ -n "\${FAKE_STUCK:-}" ]] ||
          if [[ "\$(get follow none)" == none ]]; then put follow requested; else put follow none; fi ;;
      *) echo "fake device: press on \$(get last) on \$screen" >&2; exit 1 ;;
    esac ;;
  *" get text "*) label "\$target" ;;
  *" wait absent "*) ! on_screen "\$target" ;;
  *" is visible "* | *" wait "*)
    [[ -z "\$target" ]] && exit 0
    on_screen "\$target" || exit 1
    wanted=\$(label_of "\$args")
    [[ -z "\$wanted" || "\$(label "\$target")" == "\$wanted" ]] ;;
esac
EOF
chmod +x "$fake/social-device"

# run_social [VAR=value...] [social.sh args...] leaves the exit status in social_status.
run_social() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/social-state"
  social_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="social-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/social.sh" "$@" >"$output" 2>&1 || social_status=$?
}

social_links=("com.kron00.svett svett://account" "com.kron00.svett svett://profile/edit?username=social_proof_c"
  "com.kron00.svett svett://profile" "com.kron00.svett svett://people?q=social_proof_"
  "com.kron00.svett svett://people/social_proof_c/followers" "com.kron00.svett svett://profile/requests")

case_name="social.sh Debug with SVETT_DEVICE_CMD"
for stale in svett-anonymous.db svett-account-user_old.db-wal ExpoSQLiteStorage; do
  echo stale >"$container_sqlite/$stale"
done
run_social "$root/social"
[[ "$social_status" == 0 ]] || fail "social.sh failed"
check "social.sh removes svett's databases and its stored answers" test -z "$(ls "$container_sqlite")"
check "social.sh stops svett and drops every Clerk session before it changes the files" \
  only_simctl "simctl list devices available" "simctl terminate FAKE-UDID com.kron00.svett" "simctl keychain FAKE-UDID reset" \
  "simctl get_app_container FAKE-UDID com.kron00.svett data"
check "social.sh relaunches into the dev client, then opens each screen by its link" \
  only_open "$debug_open" "${social_links[@]}"
check "social.sh signs in a Clerk test account with the test code, at the field centres" \
  only_calls "fill" "fill 80 320 svett-social-c+clerk_test@example.com" "fill 80 320 $test_code"
check "social.sh scrolls to each control under the fold before it presses it" \
  only_calls "get attrs" \
  'get attrs id="continue-with-email"' 'get attrs id="email-field"' 'get attrs id="send-code"' \
  'get attrs id="code-field"' 'get attrs id="check-code"' 'get attrs id="save-profile"' \
  'get attrs id="person-social_proof_a"' 'get attrs id="follow-button"' 'get attrs id="follow-button"'
check "social.sh reaches the requests row below the fold" \
  bound_got '--session t3-test session --device FAKE-UDID scroll down --until id="requests-row"'
check "social.sh shoots each screen at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "social.sh screenshots the username, the profile, the search, the request, the followers and the requests" \
  only_calls "screenshot" \
  "screenshot $root/social/01-edit-profile.png" "screenshot $root/social/02-own-profile.png" \
  "screenshot $root/social/03-search.png" "screenshot $root/social/04-requested.png" \
  "screenshot $root/social/05-followers.png" "screenshot $root/social/06-requests.png"
check "social.sh says the saved username shows on Profile" \
  grep -qxF "Profile's username reads \"social_proof_c\"" "$output"
check "social.sh says asking to follow the private profile left a request" \
  grep -qxF 'The follow button after asking reads "Requested"' "$output"
check "social.sh takes the request back" \
  grep -qxF 'The follow button after taking the request back reads "Ask to follow"' "$output"
check "social.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="social.sh Release with SVETT_DEVICE_CMD"
run_social --release "$root/social-release"
[[ "$social_status" == 0 ]] || fail "social.sh --release failed"
check "social.sh Release relaunches the installed app without Metro" \
  only_open "com.kron00.svett --relaunch" "${social_links[@]}"

case_name="social.sh when the follow button does not change"
run_social FAKE_STUCK=1 "$root/social-stuck"
check "social.sh fails when asking to follow leaves no request" test "$social_status" -ne 0
check "social.sh says what the follow button reads instead" \
  grep -qF 'The follow button after asking should read "Requested", but it reads: Ask to follow' "$output"
check "social.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="social.sh when the search finds nobody"
run_social FAKE_NOBODY=1 "$root/social-nobody"
check "social.sh fails when the search does not find the other profile" test "$social_status" -ne 0
check "social.sh says to run the server proof first" \
  grep -qF 'Searching "social_proof_" did not find social_proof_a. Run apps/server/src/social-proof.ts' "$output"

case_name="social.sh when the username is taken"
run_social FAKE_TAKEN=1 "$root/social-taken"
check "social.sh fails when the username does not save" test "$social_status" -ne 0
check "social.sh says the username did not save" \
  grep -qF "Saving the username social_proof_c failed" "$output"

case_name="social.sh on a build without a Clerk key"
run_social FAKE_NO_CLERK=1 "$root/social-no-clerk"
check "social.sh fails on a build without a Clerk key" test "$social_status" -ne 0
check "social.sh says to build with the publishable key" \
  grep -qF "Build it with EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set" "$output"

feed_lift=0196f000-5e4f-4000-8000-0000000000a1
feed_run=0196f000-5e4f-4000-8000-0000000000a2

# Stands in for the bound command on the feed screens. It tracks the screen, the
# sign-in step and who signed in: the lifter sees the run and the runner sees the
# lifting session. Posts on Home and everything under a post's top show only after a
# scroll since the screen last changed, so the test proves the script scrolls to
# them. FAKE_LEAK shows the run's hidden heart rate, FAKE_NO_POSTS leaves Home empty.
cat >"$fake/feed-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
state="$root/feed-state"
get() { cat "\$state/\$1" 2>/dev/null || echo "\$2"; }
put() { echo "\$2" >"\$state/\$1"; }
mkdir -p "\$state"
screen=\$(get screen tabs)
step=\$(get step choose)
scrolled=\$(get scrolled no)
who=\$(get who nobody)
show() { put screen "\$1"; put scrolled no; }
id_of() { sed -nE 's/.*id="([^"]+)".*/\1/p' <<<"\$1"; }
label_of() { sed -nE 's/.*label="([^"]+)".*/\1/p' <<<"\$1"; }
lift=$feed_lift
run=$feed_run
# theirs is the post the signed-in account should see from the other one.
if [[ "\$who" == svett-feed-a* ]]; then theirs=\$run; else theirs=\$lift; fi
below() { [[ "\$scrolled" == yes ]]; }
on_screen() {
  case "\$screen:\$1" in
    account:account) true ;;
    account:*)
      case "\$step:\$1" in
        choose:sign-in-choose | email:sign-in-email | email:email-field | code:sign-in-code | \
          code:code-field | signedin:signed-in) true ;;
        choose:continue-with-email | email:send-code | code:check-code) below ;;
        *) false ;;
      esac ;;
    feed:feed) true ;;
    feed:post-\$theirs | feed:post-numbers-\$theirs) [[ -z "\${FAKE_NO_POSTS:-}" ]] && below ;;
    feed:post-route-\$run) [[ "\$theirs" == "\$run" ]] && below ;;
    feed:post-muscles-\$lift) [[ "\$theirs" == "\$lift" ]] && below ;;
    post-\$run:post-title | post-\$run:post-route | post-\$run:post-line) true ;;
    post-\$run:post-distance | post-\$run:post-time | post-\$run:post-pace | post-\$run:post-split-4 | \
      post-\$run:post-hidden) below ;;
    post-\$run:post-heart-rate) [[ -n "\${FAKE_LEAK:-}" ]] && below ;;
    post-\$lift:post-title | post-\$lift:post-hidden) true ;;
    post-\$lift:muscle-split | post-\$lift:post-exercises) below ;;
    inbox:inbox | inbox:inbox-items) true ;;
    *) false ;;
  esac
}
label() {
  case "\$screen:\$1" in
    feed:post-numbers-\$run) echo "4.44 km" ;;
    feed:post-numbers-\$lift) echo "2 exercises · 6 sets · 2,700 kg" ;;
    feed:post-muscles-\$lift) echo "Quadriceps 60% · Chest 40%" ;;
    post-\$run:post-title) echo "Feed proof, river loop" ;;
    post-\$run:post-distance) echo "Distance, 4.44 km" ;;
    post-\$run:post-time) echo "Time, Hidden" ;;
    post-\$run:post-pace) echo "Pace, Hidden" ;;
    post-\$run:post-split-4) echo "Split 4, 1.00 km, Hidden" ;;
    post-\$run:post-line) echo "Run · Duration hidden · Start time hidden" ;;
    post-\$run:post-hidden) echo "feed_proof_b hides heart rate and start time." ;;
    post-\$lift:post-title) echo "Feed proof, legs and bench" ;;
    post-\$lift:post-hidden) echo "feed_proof_a hides calories." ;;
    *) echo "" ;;
  esac
}
exists() { on_screen "\$1" || { scrolled=yes; on_screen "\$1"; }; }
args=" \$* "
target=\$(id_of "\$args")
case "\$args" in
  *" open com.kron00.svett svett://account "*) show account; put step choose ;;
  *" open com.kron00.svett svett://feed "*) show feed ;;
  *" open com.kron00.svett svett://post/\$run "*) show "post-\$run" ;;
  *" open com.kron00.svett svett://post/\$lift "*) show "post-\$lift" ;;
  *" open com.kron00.svett svett://inbox "*) show inbox ;;
  *" open com.kron00.svett "*) show tabs ;;
  *" scroll "*" --until "*) exists "\$target" && put scrolled yes ;;
  *" scroll "*) put scrolled yes ;;
  *" get attrs "*)
    on_screen "\$target" || exit 1
    put last "\$target"
    echo '{"label": "Field", "rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" fill 80 320 "*)
    case "\$(get last)" in
      email-field) put who "\$(sed -nE 's/.* fill 80 320 ([^ ]+) .*/\1/p' <<<"\$args")" ;;
      code-field) ;;
      *) exit 1 ;;
    esac ;;
  *" press 80 320 "*)
    case "\$screen:\$step:\$(get last)" in
      account:choose:continue-with-email) put step email ;;
      account:email:send-code) put step code ;;
      account:code:check-code) put step signedin ;;
      *) echo "fake device: press on \$(get last) on \$screen" >&2; exit 1 ;;
    esac ;;
  *" get text "*) label "\$target" ;;
  *" wait absent "*) ! on_screen "\$target" ;;
  *" is visible "* | *" wait "*)
    [[ -z "\$target" ]] && exit 0
    on_screen "\$target" || exit 1
    wanted=\$(label_of "\$args")
    [[ -z "\$wanted" || "\$(label "\$target")" == "\$wanted" ]] ;;
esac
EOF
chmod +x "$fake/feed-device"

# run_feed [VAR=value...] [feed.sh args...] leaves the exit status in feed_status.
run_feed() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/feed-state"
  feed_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="feed-device --session 't3-test session' --device FAKE-UDID" \
    SVETT_FEED_POSTS="$feed_lift $feed_run" "${vars[@]}" "$repo/scripts/sim/feed.sh" "$@" >"$output" 2>&1 ||
    feed_status=$?
}

feed_reset=("simctl terminate FAKE-UDID com.kron00.svett" "simctl keychain FAKE-UDID reset"
  "simctl get_app_container FAKE-UDID com.kron00.svett data")
feed_links() {
  printf '%s\n' "$1" "com.kron00.svett svett://account" "com.kron00.svett svett://feed" \
    "com.kron00.svett svett://post/$feed_run" "com.kron00.svett svett://inbox" \
    "$1" "com.kron00.svett svett://account" "com.kron00.svett svett://feed" \
    "com.kron00.svett svett://post/$feed_lift" "com.kron00.svett svett://inbox"
}

case_name="feed.sh Debug with SVETT_DEVICE_CMD"
echo stale >"$container_sqlite/svett-account-user_old.db"
run_feed "$root/feed"
[[ "$feed_status" == 0 ]] || fail "feed.sh failed"
check "feed.sh drops svett's data and every Clerk session before each sign-in" \
  only_simctl "simctl list devices available" "${feed_reset[@]}" "${feed_reset[@]}"
check "feed.sh removes svett's databases" test -z "$(ls "$container_sqlite")"
mapfile -t feed_debug_links < <(feed_links "$debug_open")
check "feed.sh relaunches into the dev client for each account, then opens each screen by its link" \
  only_open "${feed_debug_links[@]}"
check "feed.sh signs in as the lifter, then as the runner, with the test code" \
  only_calls "fill" "fill 80 320 svett-feed-a+clerk_test@example.com" "fill 80 320 $test_code" \
  "fill 80 320 svett-feed-b+clerk_test@example.com" "fill 80 320 $test_code"
check "feed.sh scrolls Home to the run before it checks it" \
  bound_got "$bound_prefix scroll down --until id=\"post-$feed_run\""
check "feed.sh scrolls the run's post to its distance below the fold" \
  bound_got "$bound_prefix scroll down --until id=\"post-distance\""
check "feed.sh scrolls the lifting post to its muscle split" \
  bound_got "$bound_prefix scroll down --until id=\"muscle-split\""
check "feed.sh shoots each screen at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "feed.sh screenshots both feeds, both posts and both inboxes" \
  only_calls "screenshot" \
  "screenshot $root/feed/01-lifter-feed.png" "screenshot $root/feed/02-run-route.png" \
  "screenshot $root/feed/03-run-detail.png" "screenshot $root/feed/04-lifter-inbox.png" \
  "screenshot $root/feed/05-runner-feed.png" "screenshot $root/feed/06-lifting-split.png" \
  "screenshot $root/feed/07-lifting-sets.png" "screenshot $root/feed/08-runner-inbox.png"
check "feed.sh says the run shows its distance without its pace in the lifter's feed" \
  grep -qxF "The run's distance, without its pace, on Home reads \"4.44 km\"" "$output"
check "feed.sh says the lifting session shows its muscles in the runner's feed" \
  grep -qxF "The lifting post's muscles on Home reads \"Quadriceps 60% · Chest 40%\"" "$output"
check "feed.sh says the run's start time is hidden" \
  grep -qxF "The line under the run's title reads \"Run · Duration hidden · Start time hidden\"" "$output"
check "feed.sh says the run's time is hidden with its start" \
  grep -qxF "The run's time reads \"Time, Hidden\"" "$output"
check "feed.sh says the run's pace is hidden with its start" \
  grep -qxF "The run's pace reads \"Pace, Hidden\"" "$output"
check "feed.sh says the run's split times are hidden with its start" \
  grep -qxF "The run's fourth split reads \"Split 4, 1.00 km, Hidden\"" "$output"
check "feed.sh says the run's heart rate does not show" \
  grep -qxF "The run's heart rate does not show" "$output"
check "feed.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="feed.sh Release with SVETT_DEVICE_CMD"
run_feed --release "$root/feed-release"
[[ "$feed_status" == 0 ]] || fail "feed.sh --release failed"
mapfile -t feed_release_links < <(feed_links "com.kron00.svett --relaunch")
check "feed.sh Release relaunches the installed app without Metro" only_open "${feed_release_links[@]}"

case_name="feed.sh when a hidden field shows"
run_feed FAKE_LEAK=1 "$root/feed-leak"
check "feed.sh fails when the run shows its hidden heart rate" test "$feed_status" -ne 0
check "feed.sh says the hidden heart rate showed" \
  grep -qF "The run's heart rate shows, but the owner hid it" "$output"
check "feed.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="feed.sh when Home has no posts"
run_feed FAKE_NO_POSTS=1 "$root/feed-empty"
check "feed.sh fails when Home lacks the other account's post" test "$feed_status" -ne 0
check "feed.sh says to run the server proof first" \
  grep -qF "Home has no run from feed_proof_b. Run SVETT_PROOF_KEEP=1 node apps/server/src/feed-proof.ts" "$output"

case_name="feed.sh without post IDs or a Clerk key"
run_feed SVETT_FEED_POSTS= CLERK_SECRET_KEY= "$root/feed-no-posts"
check "feed.sh refuses to run without post IDs or a key to make them" test "$feed_status" -eq 64
check "feed.sh says what to set" grep -qF "Set SVETT_FEED_POSTS to the two post IDs" "$output"
check "feed.sh touches no simulator without post IDs" test ! -s "$root/simctl-calls"

# Stands in for the bound command on the safety screens. It tracks the screen, the
# sign-in step, the block and the deletion. Each control under a screen's top shows
# only after a scroll since the screen last changed, so the test proves the script
# scrolls to it. svett's own confirmations show as buttons by label. FAKE_NO_CLERK
# makes Account say the build has no Clerk key, FAKE_NOT_BLOCKED leaves the profile
# as it was, FAKE_DELETE_FAILS keeps the account signed in with a problem, and
# FAKE_NOT_KEPT finds no exercise after the deletion.
cat >"$fake/safety-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
state="$root/safety-state"
get() { cat "\$state/\$1" 2>/dev/null || echo "\$2"; }
put() { echo "\$2" >"\$state/\$1"; }
mkdir -p "\$state"
screen=\$(get screen tabs)
step=\$(get step choose)
scrolled=\$(get scrolled no)
show() { put screen "\$1"; put scrolled no; }
id_of() { sed -nE 's/.*id="([^"]+)".*/\1/p' <<<"\$1"; }
label_of() { sed -nE 's/.*label="([^"]+)".*/\1/p' <<<"\$1"; }
# key_of <args> names the element an id selector names, or label:<label> for a label alone.
key_of() {
  local id
  id=\$(id_of "\$1")
  if [[ -n "\$id" ]]; then echo "\$id"; elif [[ -n "\$(label_of "\$1")" ]]; then echo "label:\$(label_of "\$1")"; fi
}
under() { [[ "\$scrolled" == yes ]]; }
# on_screen <key> is true when the element is on screen now.
on_screen() {
  case "\$screen:\$1" in
    tabs:label:*) true ;;
    account:account) true ;;
    account:accounts-off) [[ -n "\${FAKE_NO_CLERK:-}" ]] ;;
    account:*) [[ -z "\${FAKE_NO_CLERK:-}" ]] || return 1
      case "\$step:\$1" in
        choose:sign-in-choose | email:sign-in-email | email:email-field | code:sign-in-code | \
          code:code-field | signedin:signed-in | choice:delete-keep-copy | \
          confirm:label:Delete\ account | signedout:sign-in-choose | failed:sign-in-problem | \
          choice:signed-in | confirm:signed-in | failed:signed-in) true ;;
        choose:continue-with-email | email:send-code | code:check-code | signedin:delete-account | \
          choice:delete-erase-copy) under ;;
        *) false ;;
      esac ;;
    edit:username-field) true ;;
    edit:save-profile | form:save-exercise) under ;;
    form:exercise-form | detail:exercise-name) true ;;
    profile:profile-username) [[ "\$(get block none)" != blocked ]] ;;
    profile:label:Block\ safety_proof_a) [[ "\$(get block none)" == none ]] ;;
    profile:label:Block) [[ "\$(get block none)" == asking ]] ;;
    profile:profile-blocked) [[ "\$(get block none)" == blocked ]] ;;
    profile:block-problem) [[ "\$(get block none)" == refused ]] ;;
    blocks:blocks) true ;;
    blocks:blocked-safety_proof_a) [[ "\$(get block none)" == blocked ]] ;;
    blocks:unblock-safety_proof_a) [[ "\$(get block none)" == blocked ]] && under ;;
    blocks:blocks-empty) [[ "\$(get block none)" == unblocked ]] ;;
    library:exercise-library) true ;;
    library:exercise-result-0) [[ -z "\${FAKE_NOT_KEPT:-}" ]] ;;
    *) false ;;
  esac
}
label() {
  case "\$1" in
    profile-username) echo safety_proof_a ;;
    exercise-name) get exercise "" ;;
    sign-in-problem) echo "Your data is gone from svett, but signing you out everywhere did not finish. Try again." ;;
    block-problem) echo "That was a lot at once. Try again in 30 seconds." ;;
    *) echo "" ;;
  esac
}
exists() { on_screen "\$1" || { scrolled=yes; on_screen "\$1"; }; }
args=" \$* "
target=\$(key_of "\$args")
case "\$args" in
  *" open com.kron00.svett svett://account "*) show account ;;
  *" open com.kron00.svett svett://profile/edit?username="*) show edit ;;
  *" open com.kron00.svett svett://exercises/new?name="*)
    put exercise "\$(node -e 'console.log(decodeURIComponent(process.argv[1]))' "\$(sed -nE 's/.*name=([^&]+)&.*/\1/p' <<<"\$args")")"
    show form ;;
  *" open com.kron00.svett svett://profile/blocked "*) show blocks ;;
  *" open com.kron00.svett svett://people/safety_proof_a "*) show profile ;;
  *" open com.kron00.svett svett://exercises?q="*) show library ;;
  *" open com.kron00.svett "*) show tabs ;;
  *" scroll "*" --until "*) exists "\$target" && put scrolled yes ;;
  *" scroll "*) put scrolled yes ;;
  *" get attrs "*)
    on_screen "\$target" || exit 1
    put last "\$target"
    if [[ "\$target" == exercise-result-0 ]]; then
      echo "{\"label\": \"\$(get exercise ""), Chest, Cable\", \"rect\": {\"x\": 20, \"y\": 300, \"width\": 120, \"height\": 40}}"
    else
      echo '{"label": "Field", "rect": {"x": 20, "y": 300, "width": 120, "height": 40}}'
    fi ;;
  *" fill 80 320 "*)
    [[ "\$(get last)" == email-field || "\$(get last)" == code-field ]] || exit 1 ;;
  *" press 80 320 "*)
    case "\$screen:\$step:\$(get last)" in
      account:choose:continue-with-email) put step email ;;
      account:email:send-code) put step code ;;
      account:code:check-code) put step signedin ;;
      account:signedin:delete-account) put step choice; put scrolled no ;;
      account:choice:delete-keep-copy) put step confirm ;;
      account:confirm:label:Delete\ account)
        if [[ -n "\${FAKE_DELETE_FAILS:-}" ]]; then put step failed; else put step signedout; fi ;;
      edit:*:save-profile) show tabs ;;
      form:*:save-exercise) show detail ;;
      profile:*:label:Block\ safety_proof_a) put block asking ;;
      profile:*:label:Block)
        if [[ -n "\${FAKE_NOT_BLOCKED:-}" ]]; then put block refused; else put block blocked; fi ;;
      blocks:*:unblock-safety_proof_a) put block unblocked ;;
      *) echo "fake device: press on \$(get last) on \$screen" >&2; exit 1 ;;
    esac ;;
  *" get text "*) label "\$target" ;;
  *" wait absent "*) ! on_screen "\$target" ;;
  *" is visible "* | *" wait "*)
    [[ -z "\$target" ]] && exit 0
    if [[ "\$target" == label:* ]]; then on_screen "\$target"; exit; fi
    on_screen "\$target" || exit 1
    wanted=\$(label_of "\$args")
    [[ -z "\$wanted" || "\$(label "\$target")" == "\$wanted" ]] ;;
esac
EOF
chmod +x "$fake/safety-device"

# run_safety [VAR=value...] [safety.sh args...] leaves the exit status in safety_status.
run_safety() {
  local -a vars=()
  while [[ "${1:-}" == *=* ]]; do
    vars+=("$1")
    shift
  done
  rm -rf "$root/simctl-calls" "$root/bound-calls" "$root/safety-state"
  safety_status=0
  env PATH="$fake:$PATH" SVETT_DEVICE_CMD="safety-device --session 't3-test session' --device FAKE-UDID" \
    "${vars[@]}" "$repo/scripts/sim/safety.sh" "$@" >"$output" 2>&1 || safety_status=$?
}

safety_links=("com.kron00.svett svett://account" "com.kron00.svett svett://profile/edit?username=safety_proof_d"
  "com.kron00.svett svett://exercises/new?name=Safety%20proof%20press&muscle=chest&equipment=cable"
  "com.kron00.svett svett://people/safety_proof_a" "com.kron00.svett svett://profile/blocked"
  "com.kron00.svett svett://account" "com.kron00.svett svett://exercises?q=Safety%20proof%20press")

case_name="safety.sh Debug with SVETT_DEVICE_CMD"
for stale in svett-anonymous.db svett-account-user_old.db-wal ExpoSQLiteStorage; do
  echo stale >"$container_sqlite/$stale"
done
run_safety "$root/safety"
[[ "$safety_status" == 0 ]] || fail "safety.sh failed"
check "safety.sh removes svett's databases and its stored answers" test -z "$(ls "$container_sqlite")"
check "safety.sh stops svett and drops every Clerk session before it changes the files" \
  only_simctl "simctl list devices available" "simctl terminate FAKE-UDID com.kron00.svett" "simctl keychain FAKE-UDID reset" \
  "simctl get_app_container FAKE-UDID com.kron00.svett data"
check "safety.sh relaunches into the dev client, then opens each screen by its link" \
  only_open "$debug_open" "${safety_links[@]}"
check "safety.sh signs in a Clerk test account with the test code, at the field centres" \
  only_calls "fill" "fill 80 320 svett-safety-d+clerk_test@example.com" "fill 80 320 $test_code"
check "safety.sh presses Block and svett's own confirmations by their labels, never alert accept" \
  only_calls "get attrs label|alert" \
  'get attrs label="Block safety_proof_a"' 'get attrs label="Block safety_proof_a"' \
  'get attrs label="Block"' 'get attrs label="Block"' \
  'get attrs label="Delete account"' 'get attrs label="Delete account"'
check "safety.sh scrolls to Delete account before it presses it" \
  bound_got '--session t3-test session --device FAKE-UDID scroll down --until id="delete-account"'
check "safety.sh scrolls to the erase choice to check it is offered" \
  bound_got '--session t3-test session --device FAKE-UDID scroll down --until id="delete-erase-copy"'
check "safety.sh scrolls to Unblock before it presses it" \
  bound_got '--session t3-test session --device FAKE-UDID scroll down --until id="unblock-safety_proof_a"'
check "safety.sh shoots each screen at the largest text size, then restores the default" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"
check "safety.sh screenshots the profile, the block, the blocked accounts, the choice, the sign-out and the kept copy" \
  only_calls "screenshot" \
  "screenshot $root/safety/01-profile.png" "screenshot $root/safety/02-blocked.png" \
  "screenshot $root/safety/03-blocked-accounts.png" "screenshot $root/safety/04-delete-choice.png" \
  "screenshot $root/safety/05-signed-out.png" "screenshot $root/safety/06-kept-copy.png"
check "safety.sh says the kept copy holds the exercise with no account" \
  grep -qF 'The kept copy holds "Safety proof press" with no account.' "$output"
check "safety.sh with SVETT_DEVICE_CMD calls neither simctl launch nor openurl" no_simctl_launch_or_openurl

case_name="safety.sh Release with SVETT_DEVICE_CMD"
run_safety --release "$root/safety-release"
[[ "$safety_status" == 0 ]] || fail "safety.sh --release failed"
check "safety.sh Release relaunches the installed app without Metro" \
  only_open "com.kron00.svett --relaunch" "${safety_links[@]}"

case_name="safety.sh when the block does not take"
run_safety FAKE_NOT_BLOCKED=1 "$root/safety-not-blocked"
check "safety.sh fails when the profile does not say it is blocked" test "$safety_status" -ne 0
check "safety.sh says why the block did not finish" \
  grep -qF "Blocking safety_proof_a did not finish: That was a lot at once." "$output"
check "safety.sh restores the default text size after a failure" \
  only_calls "settings text-size" \
  "settings text-size accessibility-extra-extra-extra-large" "settings text-size large"

case_name="safety.sh when the deletion fails"
run_safety FAKE_DELETE_FAILS=1 "$root/safety-delete-fails"
check "safety.sh fails when deleting the account does not sign out" test "$safety_status" -ne 0
check "safety.sh says what Account said" \
  grep -qF "Deleting the account did not sign out: Your data is gone from svett, but signing you out everywhere did not finish." "$output"

case_name="safety.sh when the kept copy is missing"
run_safety FAKE_NOT_KEPT=1 "$root/safety-not-kept"
check "safety.sh fails when the exercise is gone after keeping a copy" test "$safety_status" -ne 0
check "safety.sh says the kept copy is missing" \
  grep -qF '"Safety proof press" is not on the phone after the deletion kept a copy' "$output"

case_name="safety.sh on a build without a Clerk key"
run_safety FAKE_NO_CLERK=1 "$root/safety-no-clerk"
check "safety.sh fails on a build without a Clerk key" test "$safety_status" -ne 0
check "safety.sh says to build with the publishable key" \
  grep -qF "Build it with EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY set" "$output"

echo "$passed passed"
