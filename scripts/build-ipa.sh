#!/usr/bin/env bash
# Builds svett.ipa for AltStore from the checked-out commit, on a Mac with Xcode 27.2.
#
# Usage: scripts/build-ipa.sh
#
# The build number is SVETT_BUILD_NUMBER when set, otherwise the commit count,
# which needs the full history of HEAD. The Release build is unsigned, then
# scripts/sign-app.sh signs it ad hoc with its entitlements: AltStore re-signs
# with the entitlements it finds in the app, and an unsigned app carries none.
# The build fails if anything is signed with push (aps-environment), which a
# free Apple account cannot sign. Writes build/release/svett.ipa and, for the
# AltStore source, the app's Info.plist and signed entitlements as XML.
# fnm and CocoaPods are also found in their default install folders, as in
# devbook-build.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
repo=$(pwd)
out="$repo/build/release"
derived_data="$repo/build/release-derived"
app_name=svett.app

if [[ -n "${SVETT_BUILD_NUMBER:-}" ]]; then
  build_number=$SVETT_BUILD_NUMBER
  echo "Build number $build_number, from SVETT_BUILD_NUMBER"
else
  build_number=$(git rev-list --count HEAD)
  echo "Build number $build_number, the commit count"
fi

if ! command -v fnm >/dev/null && [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
  PATH="$HOME/.local/share/fnm:$PATH"
fi
if command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
fi
if ! command -v pod >/dev/null; then
  ruby_bin=$(printf '%s\n' "$HOME"/.local/share/mise/installs/ruby/*/bin | sort -V | tail -1)
  if [[ -x "$ruby_bin/pod" ]]; then
    PATH="$ruby_bin:$PATH"
  fi
fi

SVETT_BUILD_NUMBER=$build_number scripts/ios-prebuild.sh
(cd apps/mobile/ios && pod install)

xcodebuild build \
  -workspace apps/mobile/ios/svett.xcworkspace \
  -scheme svett \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  -quiet

rm -rf "$out"
mkdir -p "$out/Payload"
cp -R "$derived_data/Build/Products/Release-iphoneos/$app_name" "$out/Payload/"
app="$out/Payload/$app_name"

plutil -convert xml1 -o "$out/Info.plist" "$app/Info.plist"
version=$(plutil -extract CFBundleShortVersionString raw "$out/Info.plist")
built_number=$(plutil -extract CFBundleVersion raw "$out/Info.plist")
[[ "$built_number" == "$build_number" && "$version" =~ ^[0-9]+\.[0-9]+\.$build_number$ ]] || {
  echo "The app says version $version ($built_number), expected <major>.<minor>.$build_number ($build_number)" >&2
  exit 1
}

settings="$out/build-settings.json"
xcodebuild -showBuildSettings -json \
  -project apps/mobile/ios/svett.xcodeproj \
  -alltargets \
  -configuration Release \
  -sdk iphoneos >"$settings"

scripts/sign-app.sh "$app" "$settings" "$out/signing"

codesign -d --entitlements - --xml "$app" >"$out/entitlements.plist"
while IFS= read -r -d '' signed; do
  if [[ "$(codesign -d --entitlements - --xml "$signed")" == *"<key>aps-environment</key>"* ]]; then
    echo "${signed#"$out/"} is signed with aps-environment, which a free Apple account cannot sign" >&2
    exit 1
  fi
done < <(find "$app" \( -name '*.app' -o -name '*.appex' \) -print0)

(cd "$out" && zip -qry svett.ipa Payload)
echo "Built svett $version ($build_number) at $out/svett.ipa"
