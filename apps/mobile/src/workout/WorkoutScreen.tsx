import {
  type ActivitySet,
  columnEntry,
  DurationSeconds,
  formatDuration,
  type KeypadKey,
  type LoggedExercise,
  REST_ADJUST_S,
  REST_OPTIONS,
  restAfterSet,
  restLabel,
  restLeft,
  type RestTimer,
  revealDistance,
  RPE_OPTIONS,
  rpeFromChoice,
  SET_FIELDS_OPTIONS,
  SET_TYPE_OPTIONS,
  type SetColumn,
  setBadges,
  supersetPlaces,
  type WorkoutLog,
} from "@svett/core";
import { useHeaderHeight } from "@react-navigation/elements";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, type HostInstance, ScrollView, type ScrollViewInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Keypad } from "../ui/NumberEntry";
import { OptionSheet } from "../ui/OptionSheet";
import { RestTimerBar } from "../ui/RestTimerBar";
import { TextField } from "../ui/TextField";
import { useWorkoutSettings } from "../settings/store";
import {
  logBy,
  removeSet,
  renameWorkout,
  setRestTime,
  setSetRpe,
  setSetType,
  setWorkoutNotes,
  startEmpty,
  leaveSupersetAt,
  supersetWithNextAt,
  typeValue,
} from "./actions";
import { ExerciseCard, type ExerciseTool } from "./ExerciseCard";
import { confirmDiscard, finishItems } from "./finish";
import { type Focus, focusField, liveFocus, nextField, pressKey } from "./focus";
import { adjustRestTimer, restEnded, skipRestTimer, startRestTimer, useRestTimer } from "./rest";
import { reloadWorkout, useWorkout } from "./store";
import { showTiming, useElapsed, useLastDoneTiming } from "./timing";

const findSet = (log: WorkoutLog, id: ActivitySet["id"]) => {
  for (const exercise of log.exercises) {
    const set = exercise.sets.find((candidate) => candidate.id === id);
    if (set !== undefined) return { exercise, set };
  }
  return null;
};

function Timing() {
  const timing = useLastDoneTiming();
  return (
    <AppText variant="footnote" tone="secondary" className="px-gutter" testID="set-done-timing">
      {timing === null ? "No set marked done yet" : `Set shown done in ${Math.round(timing)} ms`}
    </AppText>
  );
}

/** The running rest, counting down each second. It goes when it reaches zero. */
function Rest({ timer, keypad }: { readonly timer: RestTimer; readonly keypad: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, []);
  const left = restLeft(timer, now);
  useEffect(() => {
    if (left === 0) restEnded(timer);
  }, [left, timer]);
  return (
    <RestTimerBar
      left={formatDuration(DurationSeconds.make(left))}
      leftLabel={left === 0 ? "no time" : restLabel(left)}
      progress={timer.totalS === 0 ? 0 : left / timer.totalS}
      onLess={() => adjustRestTimer(-REST_ADJUST_S)}
      onMore={() => adjustRestTimer(REST_ADJUST_S)}
      onSkip={skipRestTimer}
      atBottom={!keypad}
      compact={keypad}
      testID="rest-timer"
    />
  );
}

/** The heaviest weight an exercise's sets hold, for the plate and warm-up calculators. */
const heaviest = (exercise: LoggedExercise): number | null =>
  exercise.sets.reduce<number | null>(
    (most, set) =>
      set.weightKg !== null && set.setType !== "warm_up" && (most === null || set.weightKg > most)
        ? set.weightKg
        : most,
    null,
  );

function Header({ log }: { readonly log: WorkoutLog }) {
  const elapsed = useElapsed(log.activity.startedAt);
  const rename = () =>
    Alert.prompt(
      "Rename workout",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          isPreferred: true,
          onPress: (text?: string) => {
            const title = text?.trim() ?? "";
            if (title !== "") renameWorkout(title);
          },
        },
      ],
      "plain-text",
      log.activity.title,
    );
  return (
    <View className="gap-3 px-gutter">
      <View className="flex-row items-center gap-2">
        <View className="min-w-0 flex-1 gap-1">
          <AppText variant="title1" accessibilityRole="header" testID="workout-title">
            {log.activity.title}
          </AppText>
          <AppText tone="secondary" numeric testID="workout-elapsed">
            {elapsed}
          </AppText>
        </View>
        <IconButton
          symbol="pencil"
          label="Rename workout"
          onPress={rename}
          testID="rename-workout"
        />
      </View>
      <TextField
        label="Workout notes"
        value={log.activity.notes}
        onChangeText={setWorkoutNotes}
        placeholder="How did it go?"
        testID="workout-notes"
      />
    </View>
  );
}

function Logger({
  log,
  problem,
  failures,
}: {
  readonly log: WorkoutLog;
  readonly problem: string | null;
  readonly failures: number;
}) {
  const navigation = useNavigation<RootNavigation>();
  const { unit, logRpe } = useWorkoutSettings();
  const rest = useRestTimer();
  const [focusState, setFocus] = useState<Focus | null>(null);
  const [typeSheet, setTypeSheet] = useState<ActivitySet | null>(null);
  const [fieldsSheet, setFieldsSheet] = useState<LoggedExercise | null>(null);
  const [restSheet, setRestSheet] = useState<LoggedExercise | null>(null);
  const [rpeSheet, setRpeSheet] = useState<ActivitySet | null>(null);
  // Callbacks read the workout as it is now, so the memoised cards keep the same ones.
  const current = useRef(log);
  useLayoutEffect(() => {
    current.current = log;
  });
  const scroll = useRef<ScrollViewInstance>(null);
  const content = useRef<HostInstance>(null);
  const focusedRow = useRef<HostInstance>(null);
  const headerHeight = useHeaderHeight();
  const safeBottom = useSafeAreaInsets().bottom;

  const focus = liveFocus(log, focusState, failures)?.focus ?? null;

  // The rest timer and the keypad cover the bottom of the workout. Their height counts only once
  // they were laid out together as they show now, so a set is never placed above an old height.
  const coverKey = `${rest !== null}/${focus !== null}`;
  const [cover, setCover] = useState({ key: "false/false", height: 0 });
  const covered = coverKey === "false/false" ? 0 : cover.key === coverKey ? cover.height : null;
  // iOS already keeps the home indicator's strip clear, and the cover reaches over it.
  const inset = Math.max(0, (covered ?? cover.height) - safeBottom);

  // Scrolls the set being typed into until it shows whole between the navigation bar and what
  // covers the workout. It reads every position on screen, so it holds at any scroll.
  const reveal = useCallback(
    (row: HostInstance, coveredHeight: number) => {
      const list = scroll.current;
      const inner = content.current;
      if (list === null || inner === null) return;
      list.measureInWindow((_x, listTop, _width, listHeight) =>
        inner.measureInWindow((_innerX, contentTop) =>
          row.measureLayout(inner, (_rowX, rowY, _rowWidth, rowHeight) => {
            const top = contentTop + rowY;
            const by = revealDistance(
              { top, bottom: top + rowHeight },
              {
                top: Math.max(headerHeight, listTop),
                bottom: listTop + listHeight - coveredHeight,
              },
            );
            if (by !== 0) list.scrollTo({ y: listTop - contentTop + by, animated: true });
          }),
        ),
      );
    },
    [headerHeight],
  );
  const onFocusedRow = useCallback((row: HostInstance) => {
    focusedRow.current = row;
  }, []);
  const focusedSet = focus?.setId ?? null;
  // Runs as the keypad opens, as it moves to another set, and as the rest timer comes or goes.
  useEffect(() => {
    if (focusedSet === null || covered === null || focusedRow.current === null) return;
    reveal(focusedRow.current, covered);
  }, [focusedSet, covered, reveal]);

  const press = (key: KeypadKey) => {
    const typed = pressKey(log, focus, key, failures);
    if (typed === null) return;
    setFocus(typed.focus);
    typeValue(typed.set, typed.focus.column, typed.value);
  };

  const onFocus = useCallback(
    (exercise: LoggedExercise, set: ActivitySet, column: SetColumn) =>
      setFocus(focusField(exercise, set, column, failures, unit)),
    [failures, unit],
  );
  const onPressRpe = useCallback((set: ActivitySet) => {
    setFocus(null);
    setRpeSheet(set);
  }, []);
  const onSetDone = useCallback((index: number) => {
    const exercises = current.current.exercises;
    const next = restAfterSet(
      exercises.map((exercise) => exercise.row),
      index,
    );
    const after = exercises[next?.next ?? -1];
    if (next === null || after === undefined) return;
    void startRestTimer(next.seconds, {
      exercise: after.exercise?.name ?? "your next exercise",
      activityId: current.current.activity.id,
      activityExerciseId: after.row.id,
    });
  }, []);
  const onTool = useCallback(
    (exercise: LoggedExercise, index: number, tool: ExerciseTool) => {
      setFocus(null);
      switch (tool) {
        case "rest":
          return setRestSheet(exercise);
        case "superset":
          return void supersetWithNextAt(index);
        case "leave-superset":
          return void leaveSupersetAt(index);
        case "warm-up":
          return navigation.navigate("WarmUp", { exercise: exercise.row.id });
        case "plates": {
          const weight = heaviest(exercise);
          return navigation.navigate("Plates", weight === null ? {} : { kg: String(weight) });
        }
      }
    },
    [navigation],
  );
  // Another screen over the workout, such as the one replacing an exercise, closes the keypad
  // and drops what it held, so no key lands on a set that changed meanwhile.
  useFocusEffect(useCallback(() => () => setFocus(null), []));
  const replace = useCallback(
    (exercise: LoggedExercise) => {
      setFocus(null);
      navigation.navigate("ReplaceWorkoutExercise", { exercise: exercise.row.id });
    },
    [navigation],
  );

  const typeSheetSet = typeSheet === null ? null : findSet(log, typeSheet.id);
  const rpeSheetSet = rpeSheet === null ? null : findSet(log, rpeSheet.id);
  const supersets = supersetPlaces(log.exercises.map((exercise) => exercise.row));
  const typeSheetTitle =
    typeSheetSet === null
      ? "Set"
      : setBadges(typeSheetSet.exercise.sets.map((set) => set.setType))[
          typeSheetSet.exercise.sets.indexOf(typeSheetSet.set)
        ]!.label;

  return (
    <View className="flex-1">
      <ScrollView
        ref={scroll}
        testID="workout"
        contentInsetAdjustmentBehavior="automatic"
        // The last sets can scroll up above what covers the workout.
        contentInset={{ bottom: inset }}
        scrollIndicatorInsets={{ bottom: inset }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-background"
      >
        <View ref={content} collapsable={false} className="gap-6 py-4">
          <Header log={log} />
          {problem !== null ? (
            <AppText tone="destructive" className="px-gutter" testID="workout-problem">
              {`That change was not saved. ${problem}`}
            </AppText>
          ) : null}
          {log.exercises.map((exercise, index) => (
            <ExerciseCard
              key={exercise.row.id}
              exercise={exercise}
              index={index}
              count={log.exercises.length}
              // Only the exercise being typed into gets the focus, so the others stay memoised.
              focus={
                focus !== null && exercise.sets.some((set) => set.id === focus.setId) ? focus : null
              }
              unit={unit}
              logRpe={logRpe}
              superset={supersets[index]?.letter ?? null}
              joinsNext={supersets[index] !== null && supersets[index]?.last === false}
              onFocus={onFocus}
              onPressSetType={setTypeSheet}
              onPressRpe={onPressRpe}
              onSetDone={onSetDone}
              onReplace={replace}
              onLogBy={setFieldsSheet}
              onTool={onTool}
              onFocusedRow={onFocusedRow}
            />
          ))}
          {log.exercises.length === 0 ? (
            <AppText tone="secondary" className="px-gutter">
              Add the exercises you do, as you go.
            </AppText>
          ) : null}
          <View className="gap-3 px-gutter">
            <Button
              label="Add exercises"
              symbol="plus"
              variant="secondary"
              onPress={() => navigation.navigate("AddWorkoutExercise")}
              testID="add-workout-exercise"
            />
            <Button
              label="Discard workout"
              symbol="trash"
              variant="destructive"
              onPress={() => confirmDiscard(() => navigation.goBack())}
              testID="discard-workout"
            />
          </View>
          {showTiming() ? <Timing /> : null}
        </View>
      </ScrollView>
      {coverKey === "false/false" ? null : (
        <View
          className="absolute inset-x-0 bottom-0"
          onLayout={(event) => setCover({ key: coverKey, height: event.nativeEvent.layout.height })}
          testID="workout-cover"
        >
          {/* The rest stays in view above the keypad, as the next set is typed. */}
          {rest !== null ? <Rest timer={rest} keypad={focus !== null} /> : null}
          {focus !== null ? (
            <View
              className="gap-2 border-t border-separator bg-surface px-gutter pt-3 pb-8"
              testID="keypad"
            >
              <Keypad onKey={press} limits={columnEntry(focus.column, focus.unit)} />
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <Button
                    label="Next"
                    variant="secondary"
                    onPress={() => setFocus(nextField(log, focus))}
                    testID="keypad-next"
                  />
                </View>
                <View className="flex-1">
                  <Button label="Done" onPress={() => setFocus(null)} testID="keypad-done" />
                </View>
              </View>
            </View>
          ) : null}
        </View>
      )}
      <OptionSheet
        title={typeSheetTitle}
        mode="single"
        options={SET_TYPE_OPTIONS}
        selected={typeSheetSet?.set.setType ?? null}
        onSelect={(setType) => {
          if (typeSheetSet !== null && setType !== null) setSetType(typeSheetSet.set, setType);
        }}
        isPresented={typeSheetSet !== null}
        onDismiss={() => setTypeSheet(null)}
        action={{
          label: "Remove set",
          onPress: () => {
            if (typeSheetSet === null) return;
            if (focus?.setId === typeSheetSet.set.id) setFocus(null);
            removeSet(typeSheetSet.set);
          },
        }}
        testID="set-type-sheet"
      />
      <OptionSheet
        title="Log by"
        mode="single"
        options={SET_FIELDS_OPTIONS}
        selected={fieldsSheet?.row.setFields ?? null}
        onSelect={(fields) => {
          if (fieldsSheet !== null && fields !== null) {
            setFocus(null);
            logBy(fieldsSheet, fields);
          }
        }}
        isPresented={fieldsSheet !== null}
        onDismiss={() => setFieldsSheet(null)}
        testID="set-fields-sheet"
      />
      <OptionSheet
        title={`Rest after each set${restSheet?.exercise ? ` of ${restSheet.exercise.name}` : ""}`}
        mode="single"
        options={REST_OPTIONS}
        selected={restSheet === null ? null : String(restSheet.row.restS ?? 0)}
        onSelect={(value) => {
          if (restSheet !== null && value !== null) {
            setRestTime(restSheet.row.id, DurationSeconds.make(Number(value)));
          }
        }}
        isPresented={restSheet !== null}
        onDismiss={() => setRestSheet(null)}
        testID="rest-sheet"
      />
      <OptionSheet
        title="RPE"
        mode="single"
        options={RPE_OPTIONS}
        noneLabel="No RPE"
        selected={
          rpeSheetSet?.set.rpe === null || rpeSheetSet === null ? null : String(rpeSheetSet.set.rpe)
        }
        onSelect={(value) => {
          if (rpeSheetSet !== null) setSetRpe(rpeSheetSet.set, rpeFromChoice(value));
        }}
        isPresented={rpeSheetSet !== null}
        onDismiss={() => setRpeSheet(null)}
        testID="rpe-sheet"
      />
    </View>
  );
}

/**
 * The workout in progress. Every change is saved as it is made, so a workout cut off by a
 * crash or a killed app opens again as it was.
 */
export function WorkoutScreen() {
  const workout = useWorkout();
  const navigation = useNavigation<RootNavigation>();
  const ready = workout.status === "ready" && workout.log !== null;
  useLayoutEffect(() => {
    navigation.setOptions({
      unstable_headerRightItems: () => finishItems(ready, () => navigation.goBack()),
    });
  }, [navigation, ready]);
  useFocusEffect(
    useCallback(() => {
      void reloadWorkout();
    }, []),
  );
  if (workout.status === "ready" && workout.log !== null) {
    return <Logger log={workout.log} problem={workout.problem} failures={workout.failures} />;
  }
  return (
    <ScrollView
      testID="workout"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingVertical: 16 }}
    >
      {workout.status === "ready" ? (
        <EmptyState
          symbol="dumbbell"
          title="No workout in progress"
          message="Start an empty workout, or a routine from the Train tab."
          action={{ label: "Start empty workout", onPress: () => void startEmpty() }}
        />
      ) : null}
      {workout.status === "ready" && workout.problem !== null ? (
        <AppText tone="destructive" className="px-gutter" testID="workout-problem">
          {`That change was not saved. ${workout.problem}`}
        </AppText>
      ) : null}
      {workout.status === "failed" ? (
        <EmptyState
          symbol="exclamationmark.triangle"
          title="The workout did not load"
          message={workout.message}
        />
      ) : null}
    </ScrollView>
  );
}
