#!/usr/bin/env bash
# Regenerates apps/mobile/ios from app.config.ts. ios/ is never committed.
# CocoaPods are left to the caller, which runs `pod install` in apps/mobile/ios.
set -euo pipefail

cd "$(dirname "$0")/../apps/mobile"
EXPO_NO_GIT_STATUS=1 pnpm exec expo prebuild --platform ios --clean --no-install "$@"
