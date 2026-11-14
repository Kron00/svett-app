import {
  type ActivitySet,
  columnText,
  columnValue,
  formatTimeDigits,
  type LoggedExercise,
  placeholderFor,
  plannedSetText,
  SET_COLUMN,
  SET_FIELD_COLUMNS,
  SET_FIELDS_LABEL,
  type SetColumn,
  setBadges,
  setValuesText,
} from "@svett/core";
import { memo, useEffect, useRef } from "react";
import { ActionSheetIOS, Alert, type HostInstance, View } from "react-native";

import { useIsAccessibilityTextSize } from "../design/hooks";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { SetRow, SetRowHeader } from "../ui/SetRow";
import { TextField } from "../ui/TextField";
import { addSet, moveExercise, removeExercise, setExerciseNotes, toggleSetDone } from "./actions";
import type { Focus } from "./focus";
import { shownDone, timeDonePress } from "./timing";

/** What VoiceOver reads for a set's done box, such as "Set 1, 60 kg, 8 reps, Done". */
const doneLabel = (badge: string, set: ActivitySet) =>
  `${badge}, ${plannedSetText(set).label}, ${set.done ? "Done" : "To do"}`;

function LoggedSetRow({
  exercise,
  exerciseIndex,
  index,
  badge,
  focus,
  onFocus,
  onPressSetType,
  measure,
}: {
  readonly exercise: LoggedExercise;
  readonly exerciseIndex: number;
  readonly index: number;
  readonly badge: { readonly label: string; readonly normal: number };
  readonly focus: Focus | null;
  readonly onFocus: (exercise: LoggedExercise, set: ActivitySet, column: SetColumn) => void;
  readonly onPressSetType: (set: ActivitySet) => void;
  readonly measure: (row: HostInstance) => void;
}) {
  const set = exercise.sets[index]!;
  const previous = exercise.previous[index] ?? null;
  const columns = SET_FIELD_COLUMNS[exercise.row.setFields];
  const row = useRef<HostInstance>(null);
  const focused = focus?.setId === set.id;

  useEffect(() => {
    if (set.done) shownDone(set.id);
  }, [set.done, set.id]);
  useEffect(() => {
    if (focused && row.current !== null) measure(row.current);
  }, [focused, measure]);

  const fields = columns.map((column) => {
    const shown =
      focused && focus.column === column
        ? column === "time"
          ? formatTimeDigits(focus.text)
          : focus.text
        : columnText(column, columnValue(set, column));
    return {
      name: SET_COLUMN[column].name,
      value: shown,
      placeholder: placeholderFor(set, column, previous)?.text,
      unit: SET_COLUMN[column].unit === "" ? undefined : SET_COLUMN[column].unit,
      testID: `set-${exerciseIndex}-${index}-${column}`,
    };
  });

  return (
    <View ref={row}>
      <SetRow
        setType={set.setType}
        normalSetNumber={badge.normal}
        previous={
          previous === null ? null : (setValuesText(previous, exercise.row.setFields)?.text ?? null)
        }
        columns={columns.map((column) => ({
          title: SET_COLUMN[column].title,
          wide: column !== "reps",
        }))}
        fields={fields}
        done={set.done}
        focusedField={focused ? columns.indexOf(focus.column) : undefined}
        onPressSetType={() => onPressSetType(set)}
        onPressField={(field) => onFocus(exercise, set, columns[field]!)}
        onToggleDone={() => {
          timeDonePress(set.id);
          const problem = toggleSetDone(exercise, index);
          if (problem !== null) Alert.alert(`${badge.label} is not done yet`, problem);
        }}
        doneLabel={doneLabel(badge.label, set)}
        testID={`workout-set-${exerciseIndex}-${index}`}
      />
    </View>
  );
}

/**
 * One exercise of the workout: its name, tools, notes, and sets. It is memoised, so a set
 * marked done redraws only its own exercise.
 */
export const ExerciseCard = memo(function ExerciseCard({
  exercise,
  index,
  count,
  focus,
  onFocus,
  onPressSetType,
  onReplace,
  onLogBy,
  measure,
}: {
  readonly exercise: LoggedExercise;
  readonly index: number;
  readonly count: number;
  readonly focus: Focus | null;
  readonly onFocus: (exercise: LoggedExercise, set: ActivitySet, column: SetColumn) => void;
  readonly onPressSetType: (set: ActivitySet) => void;
  readonly onReplace: (exercise: LoggedExercise) => void;
  readonly onLogBy: (exercise: LoggedExercise) => void;
  readonly measure: (row: HostInstance) => void;
}) {
  const stacked = useIsAccessibilityTextSize();
  const name = exercise.exercise?.name ?? "Deleted exercise";
  const badges = setBadges(exercise.sets.map((set) => set.setType));
  const columns = SET_FIELD_COLUMNS[exercise.row.setFields];

  const remove = () =>
    Alert.alert(`Remove ${name}?`, "Its sets in this workout are removed with it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => removeExercise(exercise.row.id) },
    ]);

  const openOptions = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: name,
        options: [
          "Replace exercise",
          `Log by: ${SET_FIELDS_LABEL[exercise.row.setFields]}`,
          "Remove exercise",
          "Cancel",
        ],
        destructiveButtonIndex: 2,
        cancelButtonIndex: 3,
      },
      (chosen) => {
        if (chosen === 0) onReplace(exercise);
        if (chosen === 1) onLogBy(exercise);
        if (chosen === 2) remove();
      },
    );

  return (
    <View className="gap-3">
      <View className={`gap-2 px-gutter ${stacked ? "" : "flex-row items-center"}`}>
        <AppText
          variant="headline"
          accessibilityRole="header"
          className={stacked ? "" : "min-w-0 flex-1"}
          testID={`workout-exercise-${index}`}
        >
          {name}
        </AppText>
        <View className="flex-row gap-2">
          <IconButton
            symbol="arrow.up"
            label={`Move ${name} up`}
            disabled={index === 0}
            onPress={() => moveExercise(index, index - 1)}
            testID={`move-exercise-up-${index}`}
          />
          <IconButton
            symbol="arrow.down"
            label={`Move ${name} down`}
            disabled={index === count - 1}
            onPress={() => moveExercise(index, index + 1)}
            testID={`move-exercise-down-${index}`}
          />
          <IconButton
            symbol="ellipsis"
            label={`${name} options`}
            onPress={openOptions}
            testID={`exercise-options-${index}`}
          />
        </View>
      </View>
      <View className="px-gutter">
        <TextField
          label={`Notes for ${name}`}
          value={exercise.row.notes}
          onChangeText={(notes) => setExerciseNotes(exercise.row.id, notes)}
          placeholder="Add notes"
          testID={`exercise-notes-${index}`}
        />
      </View>
      <View className="mx-gutter gap-1 rounded-card bg-surface py-3">
        <SetRowHeader
          columns={columns.map((column) => ({
            title: SET_COLUMN[column].title,
            wide: column !== "reps",
          }))}
        />
        {exercise.sets.map((set, setIndex) => (
          <LoggedSetRow
            key={set.id}
            exercise={exercise}
            exerciseIndex={index}
            index={setIndex}
            badge={{
              label: badges[setIndex]!.label,
              // A normal set's badge is its number among the normal sets.
              normal: set.setType === "normal" ? Number(badges[setIndex]!.text) : 0,
            }}
            focus={focus}
            onFocus={onFocus}
            onPressSetType={onPressSetType}
            measure={measure}
          />
        ))}
        <View className="flex-row px-3">
          <Button
            label="Add set"
            symbol="plus"
            variant="plain"
            onPress={() => addSet(exercise)}
            testID={`add-workout-set-${index}`}
          />
        </View>
      </View>
    </View>
  );
});
