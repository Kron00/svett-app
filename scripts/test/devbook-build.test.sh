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
    if [[ -n "${FAKE_FIXTURE_DB:-}" ]]; then cp "$FAKE_FIXTURE_DB" "$3"; else echo "fake fixture" >"$3"; fi ;;
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
# is "never". Every element has the same frame.
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
    echo '{"label": "Save", "rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
  *" press "*)
    attrs=\$(cat "\$state/last-attrs" 2>/dev/null || true)
    case "\$attrs" in
      *workout-delete*) touch "\$state/deleted" ;;
      *undo-delete*) [[ -n "\${FAKE_UNDO_BROKEN:-}" ]] || rm -f "\$state/deleted"; touch "\$state/undone" ;;
      *set-edit-save*) [[ -n "\${FAKE_EDIT_LOST:-}" ]] || touch "\$state/edited" ;;
      *workout-save-routine*) touch "\$state/routine" ;;
    esac ;;
  *' get text id="workout-counts" '*)
    if flag deleted; then echo "299 workouts, 6000 sets"; else echo "300 workouts, 6023 sets"; fi ;;
  *' get text id="set-first" '*)
    if flag edited; then echo "Set 1, 222.5 kg × 8, Heaviest weight record"; else echo "Set 1, 92.5 kg × 8"; fi ;;
  *' get text id="workout-records" '*) echo "Records, 3" ;;
  *' get text id="calendar-month" '*) echo "October 2026" ;;
  *' get text id="calendar-count" '*) echo "13 workouts in October 2026" ;;
  *' wait id="history-row" '*) exit 1 ;;
  *' is visible id="history-row" '*)
    # The first row starts below the fold until a scroll brings it up.
    grep -q -- '--until id="history-row"' "$root/bound-calls" || exit 1
    scrolls=\$(grep -c ' scroll down\$' "$root/bound-calls" || true)
    [[ -z "\${FAKE_BLANK_AFTER:-}" ]] || ((scrolls < FAKE_BLANK_AFTER)) ;;
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
check "history.sh looks for rows after each scroll, after scrolling to the first" \
  test "$(grep -cxF -- "$bound_prefix is visible id=\"history-row\"" "$root/bound-calls")" -eq 121
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
echo "$passed passed"
