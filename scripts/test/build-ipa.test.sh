#!/usr/bin/env bash
# Runs scripts/build-ipa.sh on Linux against fake Xcode, codesign, plutil,
# CocoaPods, pnpm and fnm. It checks that each app extension is signed with its
# own entitlements with build variables expanded, that frameworks are signed with
# none, that push entitlements fail the build, and where fnm and CocoaPods are
# found.
#
# Usage: scripts/test/build-ipa.test.sh
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

fake="$root/bin"
mkdir -p "$fake" "$root/home"

# The generated project: the app's entitlements come from FAKE_APP_ENTITLEMENTS.
cat >"$fake/pnpm" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2 $3" == "exec expo prebuild" ]] || { echo "fake pnpm: unexpected $*" >&2; exit 1; }
rm -rf ios
mkdir -p ios/svett ios/Widgets
cp "$FAKE_APP_ENTITLEMENTS" ios/svett/svett.entitlements
cat >ios/Widgets/Widgets.entitlements <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.application-groups</key><array><string>group.$(PRODUCT_BUNDLE_IDENTIFIER)</string></array></dict></plist>
PLIST
EOF

cat >"$fake/pod" <<EOF
#!/usr/bin/env bash
echo "pod \$*" >>"$root/calls"
EOF

cat >"$fake/xcodebuild" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == -showBuildSettings ]]; then
  srcroot="$PWD/apps/mobile/ios"
  cat <<JSON
[{"action":"build","target":"svett","buildSettings":{"FULL_PRODUCT_NAME":"svett.app","SRCROOT":"$srcroot","CODE_SIGN_ENTITLEMENTS":"svett/svett.entitlements","PRODUCT_BUNDLE_IDENTIFIER":"com.kron00.svett","DEVELOPMENT_TEAM":""}},
 {"action":"build","target":"Widgets","buildSettings":{"FULL_PRODUCT_NAME":"Widgets.appex","SRCROOT":"$srcroot","CODE_SIGN_ENTITLEMENTS":"Widgets/Widgets.entitlements","PRODUCT_BUNDLE_IDENTIFIER":"com.kron00.svett.widgets","DEVELOPMENT_TEAM":""}}]
JSON
  exit 0
fi
while [[ $# -gt 0 ]]; do
  [[ $1 == -derivedDataPath ]] && derived_data=$2
  shift
done
app="$derived_data/Build/Products/Release-iphoneos/svett.app"
mkdir -p "$app/PlugIns/Widgets.appex" "$app/Frameworks/Hermes.framework"
printf '<plist><dict><key>CFBundleShortVersionString</key><string>0.1.%s</string><key>CFBundleVersion</key><string>%s</string></dict></plist>\n' \
  "$SVETT_BUILD_NUMBER" "$SVETT_BUILD_NUMBER" >"$app/Info.plist"
EOF

cat >"$fake/plutil" <<'EOF'
#!/usr/bin/env bash
case $1 in
  -convert) cp "$5" "$4" ;;
  -extract) sed -n "s:.*<key>$2</key><string>\([^<]*\)</string>.*:\1:p" "$4" ;;
esac
EOF

# Records what each bundle was signed with in the bundle, and prints it back for -d.
cat >"$fake/codesign" <<EOF
#!/usr/bin/env bash
echo "codesign \$*" >>"$root/calls"
case \$1 in
  --force)
    if [[ \$4 == --entitlements ]]; then cp "\$5" "\$6/.signed-with"; else : >"\$4/.signed-with"; fi ;;
  -d)
    signed="\${@: -1}/.signed-with"
    if [[ -n "\${FAKE_SIGNED_PUSH:-}" && "\$signed" == *Widgets.appex* ]]; then
      echo '<plist><dict><key>aps-environment</key><string>development</string></dict></plist>'
    else
      cat "\$signed"
    fi ;;
esac
EOF

chmod +x "$fake"/*

entitlements() {
  printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>%s</dict></plist>\n' "$1" >"$root/$2"
}
entitlements '<key>com.apple.developer.healthkit</key><true/><key>com.apple.developer.healthkit.access</key><array/>' health.plist
entitlements '<key>com.apple.developer.healthkit</key><true/><key>aps-environment</key><string>development</string>' push.plist

work="$root/work"
mkdir -p "$work/scripts" "$work/apps/mobile"
cp "$repo/scripts/build-ipa.sh" "$repo/scripts/ios-prebuild.sh" "$repo/scripts/sign-app.sh" "$work/scripts/"
cp "$repo/.node-version" "$work/"
# A link, so Node resolves the script's packages from the repo.
ln -s "$repo/scripts/signing-entitlements.ts" "$work/scripts/"

passed=0
output="$root/output"

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

# run [VAR=value...]
run() {
  rm -f "$root/calls"
  env HOME="$root/home" PATH="$fake:$PATH" SVETT_BUILD_NUMBER=42 FAKE_APP_ENTITLEMENTS="$root/health.plist" \
    "$@" "$work/scripts/build-ipa.sh" >"$output" 2>&1
}

signed_with() {
  local bundle="$work/build/release/Payload/svett.app/$1"
  grep -qF -- "$2" "$bundle/.signed-with" || fail "$1 was not signed with $2"
}

signed_without_entitlements() {
  [[ ! -s "$work/build/release/Payload/svett.app/$1/.signed-with" ]] || fail "$1 was signed with entitlements"
}

case_name="build"
run || fail "build-ipa.sh failed"
check "the app is signed with its own entitlements" signed_with . "<key>com.apple.developer.healthkit</key>"
check "an app extension is signed with its own entitlements, variables expanded" \
  signed_with PlugIns/Widgets.appex "<string>group.com.kron00.svett.widgets</string>"
check "a framework is signed without entitlements" signed_without_entitlements Frameworks/Hermes.framework
signed_before() {
  local first second
  first=$(grep -n -- "--force.*$1\$" "$root/calls" | cut -d: -f1)
  second=$(grep -n -- "--force.*$2\$" "$root/calls" | cut -d: -f1)
  [[ -n "$first" && -n "$second" && "$first" -lt "$second" ]] || fail "$1 was not signed before $2"
}
check "the extension is signed before the app that contains it" signed_before Widgets.appex svett.app
check "the signed entitlements are written for the AltStore source" \
  grep -qF "<key>com.apple.developer.healthkit</key>" "$work/build/release/entitlements.plist"
check "the ipa is written" test -s "$work/build/release/svett.ipa"

case_name="push in the app's entitlements"
! run FAKE_APP_ENTITLEMENTS="$root/push.plist" || fail "build-ipa.sh succeeded"
check "push in the app's entitlements fails the build" \
  grep -qF "aps-environment cannot be signed by a free Apple account" "$output"
check "no ipa is written when push is refused" test ! -e "$work/build/release/svett.ipa"

case_name="push in a signed extension"
! run FAKE_SIGNED_PUSH=1 || fail "build-ipa.sh succeeded"
check "push in any signed bundle fails the build" grep -qF \
  "Payload/svett.app/PlugIns/Widgets.appex is signed with aps-environment, which a free Apple account cannot sign" "$output"

# PATH without fnm and pod, so only the copies in their install folders can be found.
bare="$root/bare-bin"
mkdir -p "$bare" "$root/home/.local/share/fnm" "$root/home/.local/share/mise/installs/ruby/3.10.0/bin"
for tool in "$fake"/*; do
  [[ "${tool##*/}" == pod ]] || ln -s "$tool" "$bare/"
done
ln -s "$(command -v node)" "$bare/node"
printf '#!/usr/bin/env bash\necho "fnm $*" >>"%s"\n' "$root/calls" >"$root/home/.local/share/fnm/fnm"
cp "$fake/pod" "$root/home/.local/share/mise/installs/ruby/3.10.0/bin/pod"
chmod +x "$root/home/.local/share/fnm/fnm"
case_name="tools off PATH"
rm -f "$root/calls"
env HOME="$root/home" PATH="$bare:/usr/bin:/bin" SVETT_BUILD_NUMBER=42 FAKE_APP_ENTITLEMENTS="$root/health.plist" \
  "$work/scripts/build-ipa.sh" >"$output" 2>&1 || fail "build-ipa.sh failed without fnm and pod on PATH"
check "fnm off PATH is found in its install folder" grep -qxF "fnm use --install-if-missing" "$root/calls"
check "CocoaPods off PATH is found in the newest mise Ruby" grep -qxF "pod install" "$root/calls"

echo "$passed passed"
