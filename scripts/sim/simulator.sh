# shellcheck shell=bash
# Sourced by devbook-build.sh and sim/tabs.sh so both use the same simulator.
#
# SVETT_SIMULATOR names the simulator. The default is a dedicated one that
# devbook-build.sh creates when it is missing.

default_simulator="svett iPhone 16 Pro Max"
simulator_name=${SVETT_SIMULATOR:-$default_simulator}

# Prints the UDID of the available iOS 27 simulator whose name is exactly $1.
# A literal prefix match keeps "iPhone 16 Pro Max" and "svett iPhone 16 Pro Max" apart.
simulator_udid() {
  xcrun simctl list devices available | awk -v name="$1" '
    /^-- / { ios27 = ($0 ~ /^-- iOS 27\./); next }
    ios27 {
      line = $0
      sub(/^ +/, "", line)
      if (index(line, name " (") == 1) {
        rest = substr(line, length(name) + 3)
        print substr(rest, 1, index(rest, ")") - 1)
        exit
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
