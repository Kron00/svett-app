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
  "fixture --out") echo "fake fixture" >"$3" ;;
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
# marker counts as on screen after FAKE_GALLERY_SCROLLS scrolls since the last open.
cat >"$fake/bound-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
if [[ "\$*" == *" is visible "* ]]; then
  scrolls=\$(awk '/ open / { n = 0 } / scroll down 0[.]6$/ { n++ } END { print n + 0 }' "$root/bound-calls")
  ((scrolls >= \${FAKE_GALLERY_SCROLLS:-0}))
fi
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

# Stands in for swift on the Mac. FAKE_SWIFT_FAIL fails the tests.
cat >"$fake/swift" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/swift-calls"
echo "fake swift test output"
[[ -z "\${FAKE_SWIFT_FAIL:-}" ]]
EOF

# Stands in for the bound command on the ChatGPT settings. Every element has the same
# frame, every wait succeeds except one for text containing FAKE_MISSING, the signed-in
# state is always on screen, and no system alert shows.
cat >"$fake/chatgpt-device" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$root/bound-calls"
args=" \$* "
case "\$args" in
  *" get attrs "*) echo '{"rect": {"x": 20, "y": 300, "width": 120, "height": 40}}' ;;
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
  rm -f "$root/simctl-calls" "$root/bound-calls" "$root/swift-calls"
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

echo "$passed passed"
