import {
  type ActivitySet,
  columnText,
  columnTitle,
  columnUnit,
  columnValue,
  formatTimeDigits,
  type LoggedExercise,
  placeholderFor,
  plannedSetText,
  restText,
  SET_COLUMN,
  SET_FIELD_COLUMNS,
  SET_FIELDS_LABEL,
  type SetColumn,
  setBadges,
  setValuesText,
  type WeightUnit,
} from "@svett/core";
import { memo, useEffect, useRef } from "react";
import { ActionSheetIOS, Alert, type HostInstance, View } from "react-native";

import { useIsAccessibilityTextSize } from "../design/hooks";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { IconButton } from "../ui/IconButton";
import { SetRow, SetRowHeader } from "../ui/SetRow";
import { TextField } from "../ui/TextField";
import { addSet, moveExercise, removeExercise, setExerciseNotes, toggleSetDone } from "./actions";
import type { Focus } from "./focus";
import { shownDone, timeDonePress } from "./timing";

/** What VoiceOver reads for a set's done box, such as "Set 1, 60 kg, 8 reps, RPE 8, Done". */
const doneLabel = (badge: string, set: ActivitySet, unit: WeightUnit) =>
  [
    badge,
    plannedSetText(set, unit).label,
    set.rpe === null ? null : `RPE ${set.rpe}`,
    set.done ? "Done" : "To do",
  ]
    .filter((part) => part !== null)
    .join(", ");

/** The tools a workout exercise's options open, which the workout screen handles. */
export type ExerciseTool = "rest" | "superset" | "warm-up" | "plates";

function LoggedSetRow({
  exercise,
  exerciseIndex,
  index,
  badge,
  focus,
  unit,
  logRpe,
  onFocus,
  onPressSetType,
  onPressRpe,
  onSetDone,
  measure,
}: {
  readonly exercise: LoggedExercise;
  readonly exerciseIndex: number;
  readonly index: number;
  readonly badge: { readonly label: string; readonly normal: number };
  readonly focus: Focus | null;
  readonly unit: WeightUnit;
  readonly logRpe: boolean;
  readonly onFocus: (exercise: LoggedExercise, set: ActivitySet, column: SetColumn) => void;
  readonly onPressSetType: (set: ActivitySet) => void;
  readonly onPressRpe: (set: ActivitySet) => void;
  readonly onSetDone: (exerciseIndex: number) => void;
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
        : columnText(column, columnValue(set, column), unit);
    return {
      name: SET_COLUMN[column].name,
      value: shown,
      placeholder: placeholderFor(set, column, previous, unit)?.text,
      unit: columnUnit(column, unit) === "" ? undefined : columnUnit(column, unit),
      testID: `set-${exerciseIndex}-${index}-${column}`,
    };
  });
  const rpeField = {
    name: "RPE",
    value: set.rpe === null ? "" : String(set.rpe),
    placeholder: previous === null || previous.rpe === null ? undefined : String(previous.rpe),
    testID: `set-${exerciseIndex}-${index}-rpe`,
  };

  return (
    <View ref={row}>
      <SetRow
        setType={set.setType}
        normalSetNumber={badge.normal}
        previous={
          previous === null
            ? null
            : (setValuesText(previous, exercise.row.setFields, unit)?.text ?? null)
        }
        columns={setColumns(columns, unit, logRpe)}
        fields={logRpe ? [...fields, rpeField] : fields}
        done={set.done}
        focusedField={focused ? columns.indexOf(focus.column) : undefined}
        onPressSetType={() => onPressSetType(set)}
        onPressField={(field) =>
          field < columns.length ? onFocus(exercise, set, columns[field]!) : onPressRpe(set)
        }
        onToggleDone={() => {
          timeDonePress(set.id);
          const problem = toggleSetDone(exercise, index);
          if (problem !== null) Alert.alert(`${badge.label} is not done yet`, problem);
          else if (!set.done) onSetDone(exerciseIndex);
        }}
        doneLabel={doneLabel(badge.label, set, unit)}
        testID={`workout-set-${exerciseIndex}-${index}`}
      />
    </View>
  );
}

const setColumns = (columns: ReadonlyArray<SetColumn>, unit: WeightUnit, logRpe: boolean) => [
  ...columns.map((column) => ({ title: columnTitle(column, unit), wide: column !== "reps" })),
  ...(logRpe ? [{ title: "RPE", wide: false }] : []),
];

/**
 * One exercise of the workout: its name, tools, notes, and sets. It is memoised, so a set
 * marked done redraws only its own exercise.
 */
export const ExerciseCard = memo(function ExerciseCard({
  exercise,
  index,
  count,
  focus,
  unit,
  logRpe,
  superset,
  joinsNext,
  onFocus,
  onPressSetType,
  onPressRpe,
  onSetDone,
  onReplace,
  onLogBy,
  onTool,
  measure,
}: {
  readonly exercise: LoggedExercise;
  readonly index: number;
  readonly count: number;
  readonly focus: Focus | null;
  readonly unit: WeightUnit;
  readonly logRpe: boolean;
  /** The letter of the superset it is in, such as "A", or null. */
  readonly superset: string | null;
  /** Whether it is in a superset with the exercise after it. */
  readonly joinsNext: boolean;
  readonly onFocus: (exercise: LoggedExercise, set: ActivitySet, column: SetColumn) => void;
  readonly onPressSetType: (set: ActivitySet) => void;
  readonly onPressRpe: (set: ActivitySet) => void;
  readonly onSetDone: (exerciseIndex: number) => void;
  readonly onReplace: (exercise: LoggedExercise) => void;
  readonly onLogBy: (exercise: LoggedExercise) => void;
  readonly onTool: (exercise: LoggedExercise, index: number, tool: ExerciseTool) => void;
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

  // The tools come first, so their buttons sit clear of the bottom of the screen.
  const choices: ReadonlyArray<{ readonly label: string; readonly run: () => void }> = [
    ...(superset !== null
      ? [{ label: "Remove from superset", run: () => onTool(exercise, index, "superset") }]
      : index < count - 1 && !joinsNext
        ? [{ label: "Superset with next exercise", run: () => onTool(exercise, index, "superset") }]
        : []),
    {
      label: `Rest timer: ${restText(exercise.row.restS)}`,
      run: () => onTool(exercise, index, "rest"),
    },
    { label: "Warm-up sets", run: () => onTool(exercise, index, "warm-up") },
    { label: "Plate calculator", run: () => onTool(exercise, index, "plates") },
    { label: "Replace exercise", run: () => onReplace(exercise) },
    { label: `Log by: ${SET_FIELDS_LABEL[exercise.row.setFields]}`, run: () => onLogBy(exercise) },
    { label: "Remove exercise", run: remove },
  ];
  const openOptions = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: name,
        options: [...choices.map((choice) => choice.label), "Cancel"],
        destructiveButtonIndex: choices.length - 1,
        cancelButtonIndex: choices.length,
      },
      (chosen) => choices[chosen]?.run(),
    );

  return (
    <View className="gap-3">
      {superset !== null ? (
        <View
          className="flex-row items-center gap-2 px-gutter"
          testID={`workout-superset-${index}`}
          accessible
          accessibilityLabel={`Superset ${superset}`}
        >
          <Icon name="link" color="accent" size={14} weight="semibold" />
          <AppText variant="subheadline" tone="accent">
            {`Superset ${superset}`}
          </AppText>
        </View>
      ) : null}
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
        <SetRowHeader columns={setColumns(columns, unit, logRpe)} />
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
            unit={unit}
            logRpe={logRpe}
            onFocus={onFocus}
            onPressSetType={onPressSetType}
            onPressRpe={onPressRpe}
            onSetDone={onSetDone}
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
