# shellcheck shell=bash
# Sourced by devbook-build.sh and the sim/ scripts so all use the same simulator.
#
# SVETT_SIMULATOR names the simulator. The default is a dedicated one that
# devbook-build.sh creates when it is missing. SVETT_METRO is the host:port of the
# Metro server a Debug build loads from. Without a port it means port 8081, as in
# devbook-build.sh.

default_simulator="svett iPhone 16 Pro Max"
simulator_name=${SVETT_SIMULATOR:-$default_simulator}
# shellcheck disable=SC2034 # read by tabs.sh and launch.sh
metro=${SVETT_METRO:-localhost:8081}
[[ "$metro" == *:* ]] || metro="$metro:8081"

# Prints the UDID of the available iOS 27 simulator whose name is exactly $1.
# A literal prefix match keeps "iPhone 16 Pro Max" and "svett iPhone 16 Pro Max" apart.
# awk reads the whole list: stopping at the match could cut off simctl mid-write,
# and pipefail would then fail the caller.
simulator_udid() {
  xcrun simctl list devices available | awk -v name="$1" '
    /^-- / { ios27 = ($0 ~ /^-- iOS 27\./); next }
    ios27 && !found {
      line = $0
      sub(/^ +/, "", line)
      if (index(line, name " (") == 1) {
        rest = substr(line, length(name) + 3)
        print substr(rest, 1, index(rest, ")") - 1)
        found = 1
      }
    }'
}

# Prints the UDID of $simulator_name, creating the default simulator on the
# newest installed iOS 27 runtime when it does not exist yet.
ensure_simulator() {
  local udid runtime
  udid=$(simulator_udid "$simulator_name")
  if [[ -z "$udid" && "$simulator_name" == "$default_simulator" ]]; then
    runtime=$(xcrun simctl list runtimes available | awk '/^iOS 27\./ { print $NF }' | sort -V | tail -1)
    [[ -n "$runtime" ]] || {
      echo "No iOS 27 simulator runtime is installed" >&2
      return 1
    }
    echo "Creating the \"$simulator_name\" simulator on $runtime" >&2
    udid=$(xcrun simctl create "$simulator_name" "iPhone 16 Pro Max" "$runtime")
  fi
  [[ -n "$udid" ]] || {
    echo "No available iOS 27 simulator named \"$simulator_name\"" >&2
    return 1
  }
  echo "$udid"
}

# Prints the deep link that makes the development client load the app from the
# Metro server at $1, such as http://localhost:8081.
dev_client_url() {
  printf 'svett://expo-development-client/?url=%s' \
    "$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1")"
}

# Runs agent-device on the simulator whose UDID is in $udid. Inside T3 Code,
# SVETT_DEVICE_CMD holds the command that device_open returned, already bound to
# one device and session, and every call goes through it instead.
agent_device() {
  if [[ -n "${SVETT_DEVICE_CMD:-}" ]]; then
    eval "$SVETT_DEVICE_CMD $(printf '%q ' "$@")"
  else
    npx --yes agent-device@0.21.37 "$@" --platform ios --udid "$udid" --session svett-proof
  fi
}
