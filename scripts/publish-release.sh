#!/usr/bin/env bash
# Publishes the build from scripts/build-ipa.sh as a GitHub release with the
# AltStore source attached. Runs in the release job after a merge to main.
#
# Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/repo scripts/publish-release.sh
#
# The release stays a draft until both assets are uploaded, so the source address
# never points at a release without altstore.json. A rerun for the same commit
# reuses its draft and does nothing once the release is published.
set -euo pipefail

cd "$(dirname "$0")/.."
out=build/release
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY names the repo to release to}

version=$(plutil -extract CFBundleShortVersionString raw "$out/Info.plist")
tag="v$version"
sha=$(git rev-parse HEAD)

is_draft=$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft 2>/dev/null || echo missing)
case $is_draft in
  false)
    echo "$tag is already published"
    exit 0
    ;;
  missing)
    gh release create "$tag" --repo "$repo" --draft --target "$sha" \
      --title "svett $version" --notes "$(git log -1 --format=%s)"
    ;;
esac

gh release upload "$tag" "$out/svett.ipa" --repo "$repo" --clobber
gh api "repos/$repo/releases" --paginate --slurp >"$out/releases.json"
node scripts/altstore-source.ts \
  --releases "$out/releases.json" \
  --info-plist "$out/Info.plist" \
  --entitlements "$out/entitlements.plist" \
  --pending "$tag" >"$out/altstore.json"
gh release upload "$tag" "$out/altstore.json" --repo "$repo" --clobber
gh release edit "$tag" --repo "$repo" --draft=false --latest

echo "Published $tag"
