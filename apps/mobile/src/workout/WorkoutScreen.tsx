import {
  type ActivitySet,
  COLUMN_ENTRY,
  type KeypadKey,
  type LoggedExercise,
  SET_FIELDS_OPTIONS,
  SET_TYPE_OPTIONS,
  type SetColumn,
  setBadges,
  type WorkoutLog,
} from "@svett/core";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Alert, type HostInstance, ScrollView, type ScrollViewInstance, View } from "react-native";

import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Keypad } from "../ui/NumberEntry";
import { OptionSheet } from "../ui/OptionSheet";
import { TextField } from "../ui/TextField";
import {
  discard,
  logBy,
  removeSet,
  renameWorkout,
  setSetType,
  setWorkoutNotes,
  startEmpty,
  typeValue,
} from "./actions";
import { ExerciseCard } from "./ExerciseCard";
import { finishItems } from "./finish";
import { type Focus, focusField, liveFocus, nextField, pressKey } from "./focus";
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
  const [focusState, setFocus] = useState<Focus | null>(null);
  const [typeSheet, setTypeSheet] = useState<ActivitySet | null>(null);
  const [fieldsSheet, setFieldsSheet] = useState<LoggedExercise | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const content = useRef<HostInstance>(null);

  // Keeps the row being typed into above the keypad.
  const measure = useCallback((row: HostInstance) => {
    if (content.current === null) return;
    row.measureLayout(content.current, (_x, y) =>
      scroll.current?.scrollTo({ y: Math.max(0, y - 120), animated: true }),
    );
  }, []);

  const focus = liveFocus(log, focusState, failures)?.focus ?? null;
  const press = (key: KeypadKey) => {
    const typed = pressKey(log, focus, key, failures);
    if (typed === null) return;
    setFocus(typed.focus);
    typeValue(typed.set, typed.focus.column, typed.value);
  };

  const onFocus = useCallback(
    (exercise: LoggedExercise, set: ActivitySet, column: SetColumn) =>
      setFocus(focusField(exercise, set, column, failures)),
    [failures],
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
              onFocus={onFocus}
              onPressSetType={setTypeSheet}
              onReplace={replace}
              onLogBy={setFieldsSheet}
              measure={measure}
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
              onPress={() =>
                Alert.alert("Discard this workout?", "Nothing from it is saved to your history.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Discard",
                    style: "destructive",
                    onPress: () => void discard().then(() => navigation.goBack()),
                  },
                ])
              }
              testID="discard-workout"
            />
          </View>
          {showTiming() ? <Timing /> : null}
        </View>
      </ScrollView>
      {focus !== null ? (
        <View
          className="gap-2 border-t border-separator bg-surface px-gutter pt-3 pb-8"
          testID="keypad"
        >
          <Keypad onKey={press} limits={COLUMN_ENTRY[focus.column]} />
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
