#!/usr/bin/env bash
# Runs the ChatGPT sign-in's Swift tests on a Mac. They replay every answer OpenAI documents
# against a stand-in, and need neither a simulator nor an account.
#
# Usage: scripts/chatgpt-tests.sh [build-dir]
#
# The build goes to build-dir, by default ~/svett-app-build/chatgpt-core, and never inside
# the repo, where CocoaPods would take its generated Swift files for the app's own.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
build=${1:-$HOME/svett-app-build/chatgpt-core}
swift test --package-path "$repo/apps/mobile/modules/svett-native/ios/ChatGPTCore" --scratch-path "$build"
