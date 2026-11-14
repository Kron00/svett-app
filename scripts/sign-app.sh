#!/usr/bin/env bash
# Signs a built svett.app ad hoc. The app and each app extension get the
# entitlements file their target names, with build variables expanded, and
# nested code is signed before the code that contains it. Each bundle's
# entitlements are written to the signing folder.
#
# Usage: scripts/sign-app.sh <svett.app> <build-settings.json> <signing folder>
# where build-settings.json is `xcodebuild -showBuildSettings -json -alltargets`
# for the configuration and SDK the app was built with.
set -euo pipefail

[[ $# -eq 3 ]] || {
  echo "Usage: $0 <svett.app> <build-settings.json> <signing folder>" >&2
  exit 64
}
app=$1
settings=$2
signing=$3
scripts=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$signing"

sign_bundle() {
  local bundle=$1 entitlements
  entitlements="$signing/$(basename "$bundle").entitlements"
  node "$scripts/signing-entitlements.ts" --build-settings "$settings" --product "$(basename "$bundle")" >"$entitlements"
  if [[ -s "$entitlements" ]]; then
    codesign --force --sign - --entitlements "$entitlements" "$bundle"
  else
    codesign --force --sign - "$bundle"
  fi
}

while IFS= read -r -d '' nested; do
  case $nested in
    *.appex) sign_bundle "$nested" ;;
    *) codesign --force --sign - "$nested" ;;
  esac
done < <(find "$app" -mindepth 1 -depth \( -name '*.framework' -o -name '*.dylib' -o -name '*.appex' \) -print0)
sign_bundle "$app"
codesign --verify --deep --strict "$app"
