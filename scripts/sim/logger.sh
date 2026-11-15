#!/usr/bin/env bash
# Takes the logger proof on rena-devbook's simulator. Run it after
# devbook-build.sh, with the same --release choice.
#
# Usage: scripts/sim/logger.sh [--release] [out-dir]
#
# It generates the 300-workout fixture with pnpm fixture, copies it into the
# app's data container as Documents/svett-logger.db, and launches svett on it
# every time, with -svettTiming 1 so the workout screen shows how long the last
# set took to show done. Then, at the largest text size:
#
#   1. It starts the fixture's Legs routine and logs Barbell Squat on the keypad:
#      100 kg for 5 twice, a set changed to a failure set for 4, and one added
#      set that copies it. After it marks each typed set done, it checks the set
#      the way a person sees it, without a scroll: the row reads its values and
#      shows whole above the keypad and the rest timer. It moves Barbell Squat
#      below Romanian Deadlift, types 80 kg into Romanian Deadlift's first set
#      without marking it done, adds Plank through the exercise picker and logs it
#      for 1:00.
#   2. It kills svett with simctl terminate, launches it again, opens the
#      workout from the bar above the tabs, and checks every set and value came
#      back. It reads the database file and checks the same rows are there. svett
#      reopens on the tabs, with the bar above them. The bar sits low at the
#      largest text size and never scrolls, so it is pressed where it is: a drag
#      that starts on it presses it.
#   3. It finishes the workout and checks the database holds it finished with
#      every done set, and without the set that was never marked done.
#   4. It starts an empty workout from the Train tab, adds Barbell Squat, checks
#      the first set shows last time's 100 kg × 5, marks it done so it takes
#      those values, saves the time it took to show done as set-done.txt, and
#      finishes. It checks the database holds that workout too.
#
# It fails when a screen, a set, a value or a database row is missing. It reads
# the database from a copy of the file and its write-ahead log in out-dir.
#
# Every set marked done starts a rest, and the first rest asks for
# notifications. So it grants them ahead, and answers the prompt after the first
# set marked done if it shows anyway.
#
# Every step waits for a screen's top element, and reads or presses everything
# else through ready, because at the largest text size the workout is several
# screens tall. ready first clears the screen as a person does: it closes the
# keypad with Done and skips a running rest, because agent-device swipes low in
# the workout to scroll, and on the Mac a scroll that started on the rest moved
# nothing. Only Barbell Squat's sets are typed and checked with the keypad and
# the rest up, because those steps prove the set shows above them. Then ready
# brings the element on screen with a scroll, and drags it whole into the space
# nothing covers: below the navigation bar, and above the bottom edge, the open
# keypad and the running rest. It drags slowly and only as far as it needs.
# Last it reads the frame until two reads agree, because the screen glides on
# after a scroll or a drag, and only then does a step read or press it. It opens
# screens through svett:// links and presses an element at the centre of its
# frame, because agent-device 0.21.37 refuses a selector press inside screen
# content on iOS 27. It moves to a set's reps by pressing the field, and types
# only once the field it pressed is selected with the keypad open. It never
# presses the keypad's Next.
#
# When svett's tabs do not show within 120 seconds of a launch, it saves a
# screenshot and the screen's elements as launch-<n>.png and launch-<n>.txt. It
# goes on only when a system prompt over svett explains the wait, after it answers
# it. A launch that hung with nothing over it fails. At any failure it saves the
# screen as failure.png and its elements as failure.txt. When an exercise check
# fails, it then lists every exercise header a scroll reaches, without a press, in
# exercises.txt.
# Numbered screenshots go to out-dir, by default
# ~/svett-proof/<branch>/logger/. Like tabs.sh, Debug opens the development
# client on Metro at SVETT_METRO, --release opens the installed Release build,
# and every step runs through SVETT_DEVICE_CMD when it is set. simctl only finds
# the data container and kills svett.
set -euo pipefail

usage() {
  echo "Usage: $0 [--release] [out-dir]" >&2
  exit 64
}

release=false
if [[ "${1:-}" == --release ]]; then
  release=true
  shift
fi
[[ $# -le 1 ]] || usage
[[ "${1:-}" != -* ]] || usage

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
out=${1:-$HOME/svett-proof/$(git branch --show-current)/logger}
bundle_id=com.kron00.svett
# React Navigation labels each iOS tab button "<title>, tab, <n> of <count>".
# The Train tab showing means the app has loaded and can take a link.
train_tab='label="Train, tab, 2 of 5"'
# A press lower than this lands on iOS 27's home indicator area.
safe_bottom=${SVETT_SAFE_BOTTOM:-840}
# Below the workout's navigation bar, where a drag moves the workout.
safe_top=${SVETT_SAFE_TOP:-130}
# A press lower than this lands on the home indicator itself. On the Mac a press at
# y=880 still opened the keypad on the first set's weight field.
home_indicator=${SVETT_HOME_INDICATOR:-900}

if command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing
fi

# shellcheck source=scripts/sim/simulator.sh
source scripts/sim/simulator.sh
udid=$(simulator_udid "$simulator_name")
[[ -n "$udid" ]] || {
  echo "No available iOS 27 simulator named \"$simulator_name\". Run scripts/devbook-build.sh first." >&2
  exit 1
}

mkdir -p "$out"
out=$(cd "$out" && pwd)
pnpm fixture --out "$out/svett-fixture.db" >/dev/null
data=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
database="$data/Documents/svett-logger.db"
mkdir -p "$data/Documents"
# A journal left by an earlier run would be replayed onto the fresh copy.
rm -f "$database-wal" "$database-shm"
cp "$out/svett-fixture.db" "$database"
echo "Copied the fixture to $database"

open_flags=(--relaunch)
# Opening by bundle id alone shows the development client's launcher, and
# agent-device's own Expo detection falls back to that when it is inconclusive.
[[ "$release" == true ]] || open_flags+=(--launch-url "$(dev_client_url "http://$metro")")
open_flags+=(--launch-args=-svettFixture "--launch-args=$database" --launch-args=-svettTiming --launch-args=1)

# Leaves the simulator at the default text size, also when a step fails, and
# frees its own session.
restore() {
  agent_device settings text-size large || true
  [[ -n "${SVETT_DEVICE_CMD:-}" ]] || agent_device close || true
}
trap restore EXIT

# fail <message>: keeps the screen as failure.png and its elements as failure.txt,
# so a failed run shows what was on screen at the step that failed. Then it runs
# $failure_detail, a check's own report, which may scroll but never presses. It writes
# only to stderr and files, because it also runs inside $(...).
failure_detail=
fail() {
  local detail=$failure_detail
  failure_detail=
  echo "$1" >&2
  agent_device screenshot "$out/failure.png" >/dev/null 2>&1 || true
  agent_device snapshot >"$out/failure.txt" 2>&1 || true
  echo "The screen at the failure is in $out/failure.png and $out/failure.txt" >&2
  [[ -z "$detail" ]] || "$detail" >&2
  exit 1
}

# exercise_headers: prints the label of every exercise header of the workout, from the
# first on, as far as a scroll reaches, and saves the list as exercises.txt. It only
# scrolls and reads, and never presses, so it cannot change the workout it reports.
exercise_headers() {
  local n=0 selector attrs label
  {
    echo "The workout's exercise headers, as far as a scroll reaches:"
    while ((n < 20)); do
      selector="id=\"workout-exercise-$n\""
      if ! agent_device is visible "$selector" >/dev/null 2>&1 &&
        ! agent_device scroll down --until "$selector" --max-passes 200 >/dev/null 2>&1 &&
        ! agent_device scroll up --until "$selector" --max-passes 200 >/dev/null 2>&1; then
        echo "No workout-exercise-$n within reach, so the workout shows $n exercises"
        break
      fi
      label=
      attrs=$(agent_device get attrs "$selector" 2>/dev/null) &&
        label=$(node -e 'console.log(JSON.parse(process.argv[1]).label ?? "")' "$attrs" 2>/dev/null)
      echo "Exercise $((n + 1)), workout-exercise-$n: \"$label\""
      n=$((n + 1))
    done
  } | tee "$out/exercises.txt"
}

shot=0
screenshot() {
  shot=$((shot + 1))
  local path
  path=$(printf '%s/%02d-%s.png' "$out" "$shot" "$1")
  agent_device screenshot "$path"
  echo "Saved $path"
}

encode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

launches=0
# relaunch: launches svett on the fixture and waits for its tabs. When they do not
# show, it keeps what the screen held. A system prompt over svett explains the
# wait, so it answers the prompt and waits again. A launch that hung with no prompt
# fails, because a user would hit the same hang.
relaunch() {
  launches=$((launches + 1))
  agent_device open "$bundle_id" "${open_flags[@]}"
  agent_device wait "$train_tab" 120000 >/dev/null 2>&1 && return 0
  local screen="$out/launch-$launches"
  agent_device screenshot "$screen.png" >/dev/null 2>&1 || true
  agent_device snapshot >"$screen.txt" 2>&1 || true
  echo "svett did not show its tabs within 120 seconds of launch $launches. The screen is in $screen.png and $screen.txt" >&2
  if ! agent_device alert wait 1000 >/dev/null 2>&1; then
    fail "svett hung on launch $launches with no system prompt over it. See $screen.png and $screen.txt"
  fi
  agent_device alert accept >/dev/null 2>&1 ||
    fail "Could not answer the system prompt over launch $launches. See $screen.png and $screen.txt"
  echo "Answered a system prompt over svett after launch $launches" >&2
  agent_device wait "$train_tab" 30000 >/dev/null 2>&1 ||
    fail "svett did not show its tabs after the system prompt over launch $launches was answered. See $screen.png and $screen.txt"
}

link() {
  agent_device open "$bundle_id" "$1"
}

# expect <selector> <what is missing, for the failure message>: waits for a
# screen's top element, which is on screen as soon as the screen opens.
expect() {
  agent_device wait "$1" 10000 >/dev/null || fail "$2"
}

# agent-device gives up a scroll --until after 12 passes unless told otherwise. At the
# largest text size the Legs workout with Plank is about 13 screens tall, and on the
# Mac 12 passes from its top stopped at Standing Calf Raises, short of Plank.
max_passes=60

# outside_list <selector>: whether the element sits outside the scrolling workout:
# the workout bar and the tab buttons at the foot of the screen, the navigation bar's
# items and an alert's buttons.
outside_list() {
  case "$1" in
  *'id="workout-bar"'* | *', tab, '* | *'label="Home"'* | *'label="Finish"'* | *'label="Finish workout"'*) return 0 ;;
  *) return 1 ;;
  esac
}

# bring <selector> [what is missing]: scrolls until the element is on screen, up
# or down, because at the largest text size the workout is taller than the screen.
# A failure also says what the scroll down said. It refuses an element outside the
# scrolling workout, which a scroll cannot move and press_fixed presses where it is.
bring() {
  local said
  ! outside_list "$1" ||
    fail "$1 sits outside the scrolling workout, so no scroll or drag can bring it. Press it with press_fixed"
  agent_device is visible "$1" >/dev/null 2>&1 && return 0
  agent_device scroll up --until "$1" --max-passes "$max_passes" >/dev/null 2>&1 && return 0
  said=$(agent_device scroll down --until "$1" --max-passes "$max_passes" 2>&1) && return 0
  fail "${2:-$1 never came on screen}
The scroll down to it said: $(tail -n 1 <<<"$said")"
}

# label_of <selector> [what is missing]: prints the element's label once it is ready.
label_of() {
  local attrs
  # Reading a label needs the element on screen, not clear of the bottom edge: only a
  # press there misses. The workout's last line, the set-done timing, can never scroll
  # above the edge, because the list ends there.
  clear_screen >&2
  bring "$@" >&2
  attrs=$(agent_device get attrs "$1") || fail "$1 is not on screen"
  node -e 'console.log(JSON.parse(process.argv[1]).label ?? "")' "$attrs"
}

centre_of() {
  local frame
  frame=$(agent_device get attrs "$1") || return 1
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

# frame_of <selector>: the top and bottom of the element's frame and its centre, as
# "top bottom x y", or nothing and a failure when it is not on screen.
frame_of() {
  local frame
  frame=$(agent_device get attrs "$1" 2>/dev/null) || return 1
  node -e '
    const { x, y, width, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(y), Math.round(y + height), Math.round(x + width / 2), Math.round(y + height / 2));
  ' "$frame"
}

# settled <reader> <selector>: what the reader prints for the element once two reads in
# a row agree, because the workout keeps gliding for a moment after a scroll or a drag,
# and a press at a frame read during the glide lands beside the element. It fails
# without a message when the element is not on screen.
settled() {
  local before after reads=0
  before=$("$1" "$2") || return 1
  while ((reads < 10)); do
    agent_device wait 250 >/dev/null
    after=$("$1" "$2") || return 1
    if [[ "$after" == "$before" ]]; then
      echo "$after"
      return 0
    fi
    before=$after
    reads=$((reads + 1))
  done
  fail "$2 kept moving on screen"
}

# settled_centre <selector>: the centre of the element's frame once two reads agree.
settled_centre() {
  settled centre_of "$1" || fail "$1 is not on screen"
}

# top_of <selector>: the top of the element's frame, or nothing when it is not on screen.
top_of() {
  local frame
  agent_device is visible "$1" >/dev/null 2>&1 || return 0
  frame=$(agent_device get attrs "$1" 2>/dev/null) || return 0
  node -e 'console.log(Math.round(JSON.parse(process.argv[1]).rect.y))' "$frame"
}

# clear_bottom: the lowest point a press on the workout reaches it, above the
# bottom edge, the open keypad and the running rest. At the largest text size
# they leave little more than 200 points of the workout between them.
clear_bottom() {
  local bottom=$safe_bottom top
  top=$(top_of 'id="key-1"')
  [[ -z "$top" ]] || ((top - 20 >= bottom)) || bottom=$((top - 20))
  top=$(top_of 'id="rest-timer"')
  [[ -z "$top" ]] || ((top - 10 >= bottom)) || bottom=$((top - 10))
  echo "$bottom"
}

# clear_point <selector>: prints the centre of the element's frame once the whole
# frame shows where a person sees it, below the navigation bar and above the clear
# bottom, and two reads agree. An element out of that space is dragged into it, just
# far enough and slowly, so the workout stops where the finger lifts instead of
# gliding on. A fast drag on the Mac flung the field it was for off the top of the
# screen. A drag that still overshoots is corrected by the next, and an element it
# carried off screen is brought back first. The frame is read last, after any other
# element's, so the press goes where it was read.
clear_point() {
  local frame top bottom edge by start drags=0
  while :; do
    edge=$(clear_bottom)
    if ! frame=$(settled frame_of "$1"); then
      ((drags > 0)) || fail "$1 is not on screen"
      bring "$1" "$1 went off screen after a drag and never came back"
      frame=$(settled frame_of "$1") || fail "$1 is not on screen"
    fi
    read -r top bottom _ <<<"$frame"
    if ((top >= safe_top && bottom <= edge)); then
      echo "${frame#* * }"
      return 0
    fi
    ((drags < 6)) || fail "$1 stayed under the navigation bar, the keypad, the rest timer or the bottom edge of the screen"
    ((bottom - top <= edge - safe_top)) || fail "$1 is taller than the space the keypad and the rest timer leave, y=$safe_top to y=$edge"
    if ((bottom > edge)); then
      start=$((edge - 20))
      by=$((edge - 16 - bottom))
      ((start + by >= 60)) || by=$((60 - start))
    else
      start=$((safe_top + 20))
      by=$((safe_top + 16 - top))
      ((start + by <= edge - 10)) || by=$((edge - 10 - start))
    fi
    # At most 300 points a drag, at 50 points a second, which leaves the workout no speed
    # to glide on with when the finger lifts.
    ((by <= 300)) || by=300
    ((by >= -300)) || by=-300
    agent_device gesture pan 20 "$start" 0 "$by" "$((${by#-} * 20 > 600 ? ${by#-} * 20 : 600))" >/dev/null
    drags=$((drags + 1))
  done
}

# ready [--covered] <selector> [what is missing]: gets the element ready to read or
# press, and leaves the centre of its frame in $point as "x y". It clears the screen,
# brings the element on screen, drags it whole into the space nothing covers, and
# reads its frame until two reads agree. --covered leaves the keypad and the rest up,
# for the steps that check a set shows above them.
point=
ready() {
  if [[ "$1" == --covered ]]; then
    shift
  else
    clear_screen
  fi
  bring "$@"
  # A failure inside $(...) has already said why, and label_of runs this in a subshell
  # that does not stop at errors by itself.
  point=$(clear_point "$1") || exit 1
}

# tap [--covered] <selector> [what is missing]: presses the centre of the element
# once ready.
tap() {
  ready "$@"
  agent_device press "${point% *}" "${point#* }"
}

# press_fixed <selector> <what is missing>: presses an element outside the scrolling
# workout, such as a navigation bar item, the workout bar above the tabs or an alert's
# button. Nothing scrolls or drags for it, because it never moves, and a drag that
# starts on the workout bar presses it: on the Mac a drag meant to lift the bar clear
# of the bottom edge opened the workout instead. On a clear screen it fails at once
# when the element is not there, and presses its centre once two reads agree, only
# when that sits above the bottom edge.
press_fixed() {
  local x y
  clear_screen
  agent_device wait "$1" 5000 >/dev/null 2>&1 || fail "$2"
  point=$(settled_centre "$1") || exit 1
  read -r x y <<<"$point"
  ((y <= safe_bottom)) || fail "$1 sits at the bottom edge of the screen, with its centre at y=$y"
  agent_device press "$x" "$y"
}

# field [--covered] <id> <name>: presses an entry field of the workout and waits until
# it is selected with the keypad open, because keys pressed while the press missed go
# to another field or nowhere. A press that missed is tried once more.
field() {
  local flag='' selector attempt
  if [[ "$1" == --covered ]]; then
    flag=--covered
    shift
  fi
  selector="id=\"$1\""
  for attempt in 1 2; do
    ready ${flag:+"$flag"} "$selector" "$2 never came on screen"
    agent_device press "${point% *}" "${point#* }"
    if agent_device wait "$selector selected=true" 3000 >/dev/null 2>&1 &&
      agent_device wait 'id="key-1"' 3000 >/dev/null 2>&1; then
      return 0
    fi
    echo "Pressing $2 did not select it with the keypad open, try $attempt of 2" >&2
  done
  fail "Pressing $2 ($selector) did not select it and open the keypad, after two presses"
}

# keys <digits>: presses each digit on the keypad, which stays open below the workout.
keys() {
  local digit point
  for digit in $(echo "$1" | grep -o .); do
    point=$(centre_of "id=\"key-$digit\"") || fail "The keypad has no $digit key on screen"
    ((${point#* } <= safe_bottom)) || fail "The keypad's $digit key sits at the bottom edge of the screen"
    agent_device press "${point% *}" "${point#* }"
  done
}

# type_into [--covered] <field id> <name> <digits>: opens the keypad on a field and types.
type_into() {
  local flag=''
  if [[ "$1" == --covered ]]; then
    flag=--covered
    shift
  fi
  field ${flag:+"$flag"} "$1" "$2"
  keys "$3"
}

asked=false
# mark_done [--covered] <exercise> <set>: presses the set's done box. The first set
# marked done starts the first rest, which asks for notifications unless they were
# granted ahead. That prompt covers svett until it is answered.
mark_done() {
  local flag=''
  if [[ "$1" == --covered ]]; then
    flag=--covered
    shift
  fi
  tap ${flag:+"$flag"} "id=\"workout-set-$1-$2\""
  [[ "$asked" == false ]] || return 0
  asked=true
  if agent_device alert wait 3000 >/dev/null 2>&1; then
    agent_device alert accept >/dev/null || fail "Could not answer the notification prompt of the first rest"
    echo "Answered the notification prompt of the first rest"
  fi
}

# log_set <exercise> <set> <weight digits> <reps digits>: types a set's weight and
# reps, each by pressing its field, and marks the set done, with the keypad and the
# rest up as a person keeps them between sets.
log_set() {
  local name="set $(($2 + 1)) of exercise $(($1 + 1))"
  type_into --covered "set-$1-$2-weight" "the weight of $name" "$3"
  type_into --covered "set-$1-$2-reps" "the reps of $name" "$4"
  mark_done --covered "$1" "$2"
}

# edges_of <selector>: the top and bottom of the element's frame.
edges_of() {
  local frame
  frame=$(agent_device get attrs "$1") || fail "$1 is not on screen"
  node -e '
    const { y, height } = JSON.parse(process.argv[1]).rect;
    console.log(Math.round(y), Math.round(y + height));
  ' "$frame"
}

# shown_set <exercise> <set> <label>: checks a set just marked done, with the keypad
# still open on it and the rest running, as a person sees it. Without a scroll, its
# done box reads its values and state, and the row from its weight down to its done
# box shows between the navigation bar and the rest timer. The workout scrolls the
# set up as the rest appears, so the frames are read once they stop moving.
shown_set() {
  local name="Set $(($2 + 1)) of exercise $(($1 + 1))" box="id=\"workout-set-$1-$2\""
  local edges top bottom clear
  agent_device wait "$box label=\"$3\"" 5000 >/dev/null 2>&1 ||
    fail "$name does not show on screen reading \"$3\" after it was marked done"
  settled_centre "$box" >/dev/null
  edges=$(edges_of "id=\"set-$1-$2-weight\"") || exit 1
  top=${edges% *}
  edges=$(edges_of "$box") || exit 1
  bottom=${edges#* }
  clear=$(clear_bottom)
  ((top >= safe_top && bottom <= clear)) ||
    fail "$name is not whole on screen above the keypad and the rest timer. It reaches from y=$top to y=$bottom, and only y=$safe_top to y=$clear is clear"
  echo "$name shows above the keypad and the rest timer, from y=$top to y=$bottom"
}

# close_keypad: presses the keypad's Done when the keypad is open, and waits until it
# is gone. Done sits at the keypad's foot and never moves with the workout, with its
# centre below the line other presses keep to but above the home indicator.
close_keypad() {
  local point
  agent_device is visible 'id="key-1"' >/dev/null 2>&1 || return 0
  point=$(centre_of 'id="keypad-done"') || fail "The open keypad has no Done on screen"
  ((${point#* } <= home_indicator)) || fail "The keypad's Done sits on the home indicator, at y=${point#* }"
  agent_device press "${point% *}" "${point#* }"
  agent_device wait absent 'id="key-1"' 5000 >/dev/null 2>&1 || fail "Done did not close the keypad"
}

# skip_rest: presses the rest's Skip when a rest runs, and waits until the rest is
# gone. Like the keypad's Done, Skip sits at the foot of the screen and never moves
# with the workout.
skip_rest() {
  local point
  agent_device is visible 'id="rest-timer-skip"' >/dev/null 2>&1 || return 0
  point=$(centre_of 'id="rest-timer-skip"') || fail "The running rest has no Skip on screen"
  ((${point#* } <= home_indicator)) || fail "The rest's Skip sits on the home indicator, at y=${point#* }"
  agent_device press "${point% *}" "${point#* }"
  agent_device wait absent 'id="rest-timer"' 5000 >/dev/null 2>&1 || fail "Skip did not end the rest"
}

# clear_screen: closes the keypad, then skips the rest it leaves at the foot of the
# screen, so nothing covers the workout where agent-device swipes to scroll.
clear_screen() {
  close_keypad
  skip_rest
}

# see [--covered] <selector> <what is missing>: a check that reads the element only
# once it is ready, whole where a person sees it.
see() {
  ready "$@"
}

# expect_set [--covered] <exercise> <set> <label>: the set's done box reads its
# values and state.
expect_set() {
  local flag=''
  if [[ "$1" == --covered ]]; then
    flag=--covered
    shift
  fi
  see ${flag:+"$flag"} "id=\"workout-set-$1-$2\" label=\"$3\"" \
    "Set $(($2 + 1)) of exercise $(($1 + 1)) does not read \"$3\""
}

# expect_exercise <index> <name>: the exercise's header reads exactly its name, as the
# workout screen labels it. A failure says whether the header never came on screen or
# read another name, and lists every header a scroll reaches.
expect_exercise() {
  local selector="id=\"workout-exercise-$1\"" missing="Exercise $(($1 + 1)) of the workout is not $2" label
  failure_detail=exercise_headers
  label=$(label_of "$selector" "$missing
Its header, workout-exercise-$1, never came on screen") || exit 1
  [[ "$label" == "$2" ]] || fail "$missing
Its header, workout-exercise-$1, reads \"$label\""
  failure_detail=
}

# Checks the picker's first result is the exercise named $1, then presses it.
choose_first_result() {
  local attrs
  ready 'id="exercise-result-0"' "The search for \"$1\" showed no result"
  attrs=$(agent_device get attrs 'id="exercise-result-0"') || fail "The search for \"$1\" showed no result"
  # shellcheck disable=SC2016 # The ${...} are JavaScript template literals.
  node -e '
    const { label } = JSON.parse(process.argv[1]);
    if (typeof label !== "string" || (label !== process.argv[2] && !label.startsWith(`${process.argv[2]},`))) {
      console.error(`The first result was not "${process.argv[2]}". Its label is "${label}".`);
      process.exit(1);
    }
  ' "$attrs" "$1" || exit 1
  agent_device press "${point% *}" "${point#* }"
}

add_exercise() {
  link "svett://train/workout/exercises?q=$(encode "$1")"
  expect 'id="exercise-library"' "The exercise picker did not open"
  agent_device wait 1000
  choose_first_result "$2"
  expect 'id="workout"' "Choosing $2 did not go back to the workout"
}

# check_rows <name> <title> <expected line>...: copies the database with its
# write-ahead log and checks the workout's rows are exactly the lines given.
check_rows() {
  local name=$1 title=$2 copy
  shift 2
  copy="$out/$name.db"
  rm -f "$copy" "$copy-wal" "$copy-shm"
  cp "$database" "$copy"
  [[ ! -f "$database-wal" ]] || cp "$database-wal" "$copy-wal"
  node scripts/workout-rows.ts workout "$copy" "$title" >"$out/$name.txt" ||
    fail "The database holds no workout called \"$title\""
  printf '%s\n' "$@" >"$out/$name-expected.txt"
  diff -u "$out/$name-expected.txt" "$out/$name.txt" >&2 ||
    fail "The database does not hold \"$title\" as logged. See $out/$name.txt"
  echo "The database holds \"$title\" as logged. See $out/$name.txt"
}

finish_workout() {
  # Finish is a native bar item, which carries its label but no identifier.
  press_fixed 'label="Finish"' "The workout's navigation bar has no Finish"
  agent_device alert wait 5000 >/dev/null || fail "Finish asked nothing"
  # The confirmation is svett's own alert, which agent-device's alert accept cannot
  # answer, so its button is pressed by its label like any other control. The
  # alert nests its button in containers with the same label, so ask for the button.
  press_fixed 'role="button" label="Finish workout"' "The Finish alert has no Finish workout button"
  agent_device wait absent 'id="workout-bar"' 10000 >/dev/null ||
    fail "The workout bar still shows after Finish"
}

# The first rest asks for notifications, and the prompt would cover svett mid-set.
agent_device settings permission grant notifications ||
  echo "Could not grant notifications ahead, so the first set marked done answers the prompt" >&2

# Proof is at the largest text size. A running app adopts it only when it relaunches.
agent_device settings text-size accessibility-extra-extra-extra-large
relaunch
link "svett://train"
train_routines 10000 || fail "The Train tab did not list the routines"
screenshot train

routine=$(node scripts/workout-rows.ts routine "$out/svett-fixture.db" Legs) ||
  fail "The fixture has no Legs routine"
link "svett://routine/$routine"
expect 'id="routine-detail"' "The Legs routine did not open"
tap 'id="start-routine"'
expect 'id="workout"' "Start workout did not open the workout"
expect 'id="workout-title" label="Legs"' "The workout in progress is not Legs"
expect_exercise 0 "Barbell Squat"
screenshot workout-started

log_set 0 0 100 5
shown_set 0 0 "Set 1, 100 kg, 5 reps, Done"
log_set 0 1 100 5
shown_set 0 1 "Set 2, 100 kg, 5 reps, Done"
# Barbell Squat is logged as a person does it between sets, with the keypad and the
# rest up. Every step after the move clears them first.
tap --covered 'id="workout-set-0-2-type"'
expect 'id="set-type-sheet"' "The set type sheet did not open"
tap --covered 'id="set-type-sheet-failure"'
expect 'id="workout"' "Choosing a set type did not close the sheet"
log_set 0 2 100 4
shown_set 0 2 "Failure set, 100 kg, 4 reps, Done"
tap --covered 'id="add-workout-set-0"'
see --covered 'id="workout-set-0-3"' "Add set added no set"
mark_done --covered 0 3
expect_set --covered 0 3 "Failure set, 100 kg, 4 reps, Done"
screenshot squat-logged
tap --covered 'id="move-exercise-down-0"'

expect_exercise 1 "Barbell Squat"
expect_exercise 0 "Romanian Deadlift"
type_into set-0-0-weight "the weight of Romanian Deadlift's first set" 80
expect_set 0 0 "Set 1, 80 kg, 6 to 10 reps, To do"

add_exercise plank Plank
expect_exercise 5 "Plank"
type_into set-5-0-time "the time of Plank's first set" 100
mark_done 5 0
expect_set 5 0 "Set 1, 60 seconds, Done"
screenshot before-kill

xcrun simctl terminate "$udid" "$bundle_id"
echo "Killed svett mid-workout"
relaunch
expect 'id="workout-bar"' "The workout in progress did not show above the tabs after the kill"
screenshot restored-bar
press_fixed 'id="workout-bar"' "The workout in progress did not show above the tabs after the kill"
expect 'id="workout"' "The workout bar did not open the workout"
expect 'id="workout-title" label="Legs"' "Legs did not come back after the kill"
expect_exercise 0 "Romanian Deadlift"
expect_set 0 0 "Set 1, 80 kg, 6 to 10 reps, To do"
expect_exercise 1 "Barbell Squat"
expect_set 1 0 "Set 1, 100 kg, 5 reps, Done"
expect_set 1 1 "Set 2, 100 kg, 5 reps, Done"
expect_set 1 2 "Failure set, 100 kg, 4 reps, Done"
expect_set 1 3 "Failure set, 100 kg, 4 reps, Done"
expect_exercise 5 "Plank"
expect_set 5 0 "Set 1, 60 seconds, Done"
screenshot restored
check_rows restored Legs "Legs: in_progress" "Notes: none" "Workouts in progress: 1" \
  "Exercise 1: Romanian Deadlift, by weight_reps" "Set 1.1: normal, 80 kg, to do" \
  "Set 1.2: normal, to do" "Set 1.3: normal, to do" \
  "Exercise 2: Barbell Squat, by weight_reps" \
  "Set 2.1: normal, 100 kg, 5 reps, done" "Set 2.2: normal, 100 kg, 5 reps, done" \
  "Set 2.3: failure, 100 kg, 4 reps, done" "Set 2.4: failure, 100 kg, 4 reps, done" \
  "Exercise 3: Leg Press, by weight_reps" "Set 3.1: normal, to do" "Set 3.2: normal, to do" \
  "Set 3.3: normal, to do" \
  "Exercise 4: Lying Leg Curls, by weight_reps" "Set 4.1: normal, to do" \
  "Set 4.2: normal, to do" "Set 4.3: normal, to do" \
  "Exercise 5: Standing Calf Raises, by weight_reps" "Set 5.1: normal, to do" \
  "Set 5.2: normal, to do" "Set 5.3: normal, to do" \
  "Exercise 6: Plank, by time" "Set 6.1: normal, 60 s, done" "Set 6.2: normal, to do" \
  "Set 6.3: normal, to do"

finish_workout
screenshot finished
check_rows finished Legs "Legs: finished" "Notes: none" "Workouts in progress: 0" \
  "Exercise 1: Barbell Squat, by weight_reps" \
  "Set 1.1: normal, 100 kg, 5 reps, done" "Set 1.2: normal, 100 kg, 5 reps, done" \
  "Set 1.3: failure, 100 kg, 4 reps, done" "Set 1.4: failure, 100 kg, 4 reps, done" \
  "Exercise 2: Plank, by time" "Set 2.1: normal, 60 s, done"

link "svett://train"
expect 'id="train"' "The Train tab did not open"
tap 'id="start-empty-workout"' "The Train tab has no Start empty workout"
expect 'id="workout"' "Start empty workout did not open the workout"
title=$(label_of 'id="workout-title"')
[[ "$title" == *" workout" ]] || fail "The empty workout is called \"$title\""
add_exercise "barbell squat" "Barbell Squat"
expect_exercise 0 "Barbell Squat"
see 'label="Previous, 100 kg × 5"' "The first set does not show last time's 100 kg × 5"
mark_done 0 0
expect_set 0 0 "Set 1, 100 kg, 5 reps, Done"
timing=$(label_of 'id="set-done-timing"')
[[ "$timing" =~ ^Set\ shown\ done\ in\ ([0-9]+)\ ms$ ]] || fail "The workout did not time the set marked done. It says \"$timing\""
build=$([[ "$release" == true ]] && echo Release || echo "Debug, loaded from Metro")
echo "Marking a set done until the row showed it: ${BASH_REMATCH[1]} ms ($build, on the fixture database, timed in the app)" |
  tee "$out/set-done.txt"
screenshot empty-workout
finish_workout
check_rows empty "$title" "$title: finished" "Notes: none" "Workouts in progress: 0" \
  "Exercise 1: Barbell Squat, by weight_reps" "Set 1.1: normal, 100 kg, 5 reps, done"

echo "Logged Legs from its routine and \"$title\" from empty, restored Legs after a kill, and found both in the database. Screenshots are in $out"
