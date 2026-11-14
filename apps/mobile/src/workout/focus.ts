import {
  type ActivitySet,
  columnValue,
  entryText,
  entryValue,
  type ExerciseId,
  type KeypadKey,
  type LoggedExercise,
  SET_FIELD_COLUMNS,
  type SetColumn,
  typeIntoField,
  type WeightUnit,
  type WorkoutLog,
} from "@svett/core";

/** The field the keypad types into, and the text typed so far. */
export interface Focus {
  readonly setId: ActivitySet["id"];
  /** The exercise the set held when the keypad opened. Replacing it closes the keypad. */
  readonly exerciseId: ExerciseId;
  readonly column: SetColumn;
  readonly text: string;
  /** True until the first key, which replaces the stored value instead of adding to it. */
  readonly fresh: boolean;
  /** The store's count of failed saves when the text was set. */
  readonly failures: number;
  /** The unit weights are typed in. */
  readonly unit: WeightUnit;
  /** The value stored when the keypad opened. Text that still reads as it keeps it exactly. */
  readonly stored: number | null;
}

/** The keypad opened on one field, holding the value stored there. */
export const focusField = (
  exercise: LoggedExercise,
  set: ActivitySet,
  column: SetColumn,
  failures: number,
  unit: WeightUnit,
): Focus => ({
  setId: set.id,
  exerciseId: exercise.row.exerciseId,
  column,
  text: entryText(column, columnValue(set, column), unit),
  fresh: true,
  failures,
  unit,
  stored: columnValue(set, column),
});

/**
 * The focused field while the workout still shows it: its set is there, its exercise was not
 * replaced, and the exercise still logs its column. Otherwise the keypad closes, so a key never
 * adds to an old value or writes a column the set does not show. After a save fails, the field
 * shows the value stored again, so its text never claims a value that was not kept.
 */
export const liveFocus = (log: WorkoutLog, focus: Focus | null, failures: number) => {
  if (focus === null) return null;
  for (const exercise of log.exercises) {
    const set = exercise.sets.find((candidate) => candidate.id === focus.setId);
    if (set === undefined) continue;
    const shown =
      exercise.row.exerciseId === focus.exerciseId &&
      SET_FIELD_COLUMNS[exercise.row.setFields].includes(focus.column);
    if (!shown) return null;
    return {
      focus:
        focus.failures === failures
          ? focus
          : focusField(exercise, set, focus.column, failures, focus.unit),
      exercise,
      set,
    };
  }
  return null;
};

/** What one key does: the field's new text, and the value to save. Null when nothing is focused. */
export const pressKey = (
  log: WorkoutLog,
  focus: Focus | null,
  key: KeypadKey,
  failures: number,
) => {
  const live = liveFocus(log, focus, failures);
  if (live === null) return null;
  const { column, unit, stored } = live.focus;
  const text = typeIntoField(column, live.focus.text, key, live.focus.fresh, unit);
  return {
    focus: { ...live.focus, text, fresh: false },
    exercise: live.exercise,
    set: live.set,
    value: entryValue(column, text, unit, stored),
  };
};

/** The field after `focus`: the next column of the set, else the first of the next set. */
export const nextField = (log: WorkoutLog, focus: Focus): Focus | null => {
  const fields = log.exercises.flatMap((exercise) =>
    exercise.sets.map((set) => ({
      exercise,
      set,
      columns: SET_FIELD_COLUMNS[exercise.row.setFields],
    })),
  );
  const at = fields.findIndex(({ set }) => set.id === focus.setId);
  if (at === -1) return null;
  const { exercise, set, columns } = fields[at]!;
  const column = columns[columns.indexOf(focus.column) + 1];
  if (column !== undefined) return focusField(exercise, set, column, focus.failures, focus.unit);
  const next = fields[at + 1];
  return next === undefined
    ? null
    : focusField(next.exercise, next.set, next.columns[0]!, focus.failures, focus.unit);
};
