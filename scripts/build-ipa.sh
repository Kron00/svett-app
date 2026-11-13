#!/usr/bin/env bash
# Builds svett.ipa for AltStore from the checked-out commit, on a Mac with Xcode 27.2.
#
# Usage: scripts/build-ipa.sh
#
# The build number is the commit count, so HEAD must have full history. The
# Release build is unsigned, then signed ad hoc with the entitlements file that
# `expo prebuild` generates: AltStore re-signs with the entitlements it finds in
# the app, and an unsigned app carries none. Writes build/release/svett.ipa and,
# for the AltStore source, the app's Info.plist and signed entitlements as XML.
set -euo pipefail

cd "$(dirname "$0")/.."
repo=$(pwd)
out="$repo/build/release"
derived_data="$repo/build/release-derived"
app_name=svett.app

build_number=$(git rev-list --count HEAD)
echo "Build number $build_number"

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

entitlements="$out/signing.entitlements"
plutil -convert xml1 -o "$entitlements" apps/mobile/ios/svett/svett.entitlements

# Nested code is signed before the code that contains it, and without the app's entitlements.
while IFS= read -r -d '' nested; do
  codesign --force --sign - "$nested"
done < <(find "$app" -mindepth 1 -depth \( -name '*.framework' -o -name '*.dylib' -o -name '*.appex' \) -print0)
codesign --force --sign - --entitlements "$entitlements" "$app"
codesign --verify --deep --strict "$app"

codesign -d --entitlements - --xml "$app" >"$out/entitlements.plist"

(cd "$out" && zip -qry svett.ipa Payload)
echo "Built svett $version ($build_number) at $out/svett.ipa"
