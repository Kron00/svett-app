import { DurationSeconds, formatDuration } from "./duration.ts";
import {
  editNumberEntry,
  type KeypadKey,
  type NumberEntryLimits,
  REPS_ENTRY,
  WEIGHT_KG_ENTRY,
} from "./number-entry.ts";
import type { PlannedSet } from "./repositories/activities.ts";
import type { ActivitySet, Exercise, SetFields, SetType } from "./schema.ts";
import { formatWeight, kgFromText, WEIGHT_ENTRY, type WeightUnit } from "./weight-unit.ts";

/** One value a set records. */
export type SetColumn = "weight" | "reps" | "time" | "distance";

/** The columns the logger shows for each kind of exercise, in order. */
export const SET_FIELD_COLUMNS: Readonly<Record<SetFields, ReadonlyArray<SetColumn>>> = {
  weight_reps: ["weight", "reps"],
  reps: ["reps"],
  time: ["time"],
  weight_time: ["weight", "time"],
  distance_time: ["distance", "time"],
  weight_distance: ["weight", "distance"],
};

export const SET_FIELDS_LABEL: Readonly<Record<SetFields, string>> = {
  weight_reps: "Weight and reps",
  reps: "Reps",
  time: "Time",
  weight_time: "Weight and time",
  distance_time: "Distance and time",
  weight_distance: "Weight and distance",
};

export const SET_FIELDS_OPTIONS = (Object.keys(SET_FIELDS_LABEL) as Array<SetFields>).map(
  (value) => ({ value, label: SET_FIELDS_LABEL[value] }),
);

export const SET_TYPE_LABEL: Readonly<Record<SetType, string>> = {
  warm_up: "Warm-up",
  normal: "Normal",
  failure: "Failure",
  drop: "Drop",
};

export const SET_TYPE_OPTIONS = (["warm_up", "normal", "failure", "drop"] as const).map(
  (value) => ({ value, label: SET_TYPE_LABEL[value] }),
);

/** The column title above the logger's sets, and the unit after a value. */
export const SET_COLUMN: Readonly<
  Record<SetColumn, { readonly title: string; readonly name: string; readonly unit: string }>
> = {
  weight: { title: "KG", name: "weight", unit: "kg" },
  reps: { title: "REPS", name: "reps", unit: "reps" },
  time: { title: "TIME", name: "time", unit: "" },
  distance: { title: "METRES", name: "distance", unit: "m" },
};

/** Time is typed as digits that fill in from the right, as a timer does: 1, 3, 0 is 1:30. */
export const TIME_ENTRY: NumberEntryLimits = { decimals: 0, maxIntegerDigits: 6, step: 5 };
export const DISTANCE_M_ENTRY: NumberEntryLimits = { decimals: 0, maxIntegerDigits: 6, step: 10 };

export const COLUMN_ENTRY: Readonly<Record<SetColumn, NumberEntryLimits>> = {
  weight: WEIGHT_KG_ENTRY,
  reps: REPS_ENTRY,
  time: TIME_ENTRY,
  distance: DISTANCE_M_ENTRY,
};

/** The column title and unit after a value in the user's weight unit, such as "LB" and "lb". */
export const columnTitle = (column: SetColumn, unit: WeightUnit): string =>
  column === "weight" ? unit.toUpperCase() : SET_COLUMN[column].title;

export const columnUnit = (column: SetColumn, unit: WeightUnit): string =>
  column === "weight" ? unit : SET_COLUMN[column].unit;

/** How a column is typed, with weights in the user's unit. */
export const columnEntry = (column: SetColumn, unit: WeightUnit): NumberEntryLimits =>
  column === "weight" ? WEIGHT_ENTRY[unit] : COLUMN_ENTRY[column];

type SetValues = Pick<ActivitySet, "weightKg" | "reps" | "durationS" | "distanceM">;

const COLUMN_KEY = {
  weight: "weightKg",
  reps: "reps",
  time: "durationS",
  distance: "distanceM",
} as const satisfies Record<SetColumn, keyof SetValues>;

export const columnValue = (set: SetValues, column: SetColumn): number | null =>
  set[COLUMN_KEY[column]];

/** The change that stores `value` in one column of a set. */
export const columnPatch = (column: SetColumn, value: number | null): Partial<SetValues> =>
  column === "time"
    ? { durationS: value === null ? null : DurationSeconds.make(value) }
    : { [COLUMN_KEY[column]]: value };

/** Seconds from timer digits: the last two are seconds, the two before minutes, the rest hours. */
export const secondsFromTimeDigits = (digits: string): number | null => {
  if (digits === "") return null;
  const padded = digits.padStart(6, "0");
  return (
    Number(padded.slice(0, -4)) * 3600 +
    Number(padded.slice(-4, -2)) * 60 +
    Number(padded.slice(-2))
  );
};

/** What a time field shows while it is typed, such as "1:30" for the digits 130. */
export const formatTimeDigits = (digits: string): string => {
  if (digits === "") return "";
  const padded = digits.padStart(3, "0");
  const seconds = padded.slice(-2);
  const rest = padded.slice(0, -2);
  if (rest.length <= 2) return `${Number(rest)}:${seconds}`;
  return `${Number(rest.slice(0, -2))}:${rest.slice(-2)}:${seconds}`;
};

const timeDigits = (seconds: number): string =>
  formatDuration(DurationSeconds.make(seconds)).replaceAll(":", "").replace(/^0+/, "");

/** The text a field holds when the keypad opens on a stored value. Weights read in `unit`. */
export const entryText = (
  column: SetColumn,
  value: number | null,
  unit: WeightUnit = "kg",
): string => {
  if (value === null) return "";
  if (column === "time") return timeDigits(value);
  if (column === "weight") return formatWeight(value, unit);
  return String(value);
};

/** A stored value as a field shows it while the keypad is closed. */
export const columnText = (
  column: SetColumn,
  value: number | null,
  unit: WeightUnit = "kg",
): string => {
  if (value === null) return "";
  if (column === "time") return formatDuration(DurationSeconds.make(value));
  if (column === "weight") return formatWeight(value, unit);
  return String(value);
};

/**
 * The value to store for a field's text, or null while it is empty. A weight is typed in
 * `unit` and stored in kilograms, and text that still reads as `stored` keeps it exactly.
 */
export const entryValue = (
  column: SetColumn,
  text: string,
  unit: WeightUnit = "kg",
  stored: number | null = null,
): number | null => {
  if (column === "time") return secondsFromTimeDigits(text);
  if (column === "weight") return kgFromText(text, stored, unit);
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
};

/**
 * A field the keypad has just opened on is replaced by the first key typed, so 60 becomes 62.5
 * by typing 6, 2, ., 5 rather than 6062.5. Delete still edits what is there.
 */
export const typeIntoField = (
  column: SetColumn,
  text: string,
  key: KeypadKey,
  fresh: boolean,
  unit: WeightUnit = "kg",
): string => editNumberEntry(fresh && key !== "delete" ? "" : text, key, columnEntry(column, unit));

const has = (sets: ReadonlyArray<SetValues>, key: keyof SetValues) =>
  sets.some((set) => set[key] !== null);

/** What sets with these values record, or null when none records anything yet. */
export const setFieldsFromSets = (sets: ReadonlyArray<SetValues>): SetFields | null => {
  const weight = has(sets, "weightKg");
  if (has(sets, "distanceM")) return weight ? "weight_distance" : "distance_time";
  if (has(sets, "durationS")) return weight ? "weight_time" : "time";
  if (weight) return "weight_reps";
  return has(sets, "reps") ? "reps" : null;
};

/** How an exercise is logged the first time: cardio by distance and time, stretches by time. */
export const defaultSetFields = (exercise: Pick<Exercise, "category" | "equipment">): SetFields => {
  if (exercise.category === "cardio") return "distance_time";
  if (exercise.category === "stretching") return "time";
  return exercise.equipment === "none" ? "reps" : "weight_reps";
};

const covers = (fields: SetFields, needed: SetFields) =>
  SET_FIELD_COLUMNS[needed].every((column) => SET_FIELD_COLUMNS[fields].includes(column));

/**
 * How an exercise is logged in a new workout: as it was last time, else by its kind, so a
 * change of fields carries over to the next workout. Either must show every value the
 * planned sets hold, so a routine with only a reps target keeps the weight a barbell lift
 * logs, while a routine timing a plank logs it by time.
 */
export const chooseSetFields = ({
  planned,
  previous,
  exercise,
}: {
  readonly planned: ReadonlyArray<SetValues>;
  readonly previous: SetFields | null;
  readonly exercise: Pick<Exercise, "category" | "equipment"> | null;
}): SetFields => {
  const usual = exercise === null ? "weight_reps" : defaultSetFields(exercise);
  const needed = setFieldsFromSets(planned);
  if (needed === null) return previous ?? usual;
  return [previous, usual].find((fields) => fields !== null && covers(fields, needed)) ?? needed;
};

/**
 * The set from last time that each set lines up with: the nth set of a type takes the nth set
 * of that type last time, so warm-ups compare with warm-ups and working sets with working sets.
 */
export const matchPrevious = <S extends { readonly setType: SetType }>(
  types: ReadonlyArray<SetType>,
  previous: ReadonlyArray<S>,
): ReadonlyArray<S | null> => {
  const seen = new Map<SetType, number>();
  return types.map((type) => {
    const nth = seen.get(type) ?? 0;
    seen.set(type, nth + 1);
    return previous.filter((set) => set.setType === type)[nth] ?? null;
  });
};

/** What a set shows and what VoiceOver reads for it. */
export type SetText = { readonly text: string; readonly label: string };

const repsText = (reps: number) => `${reps} ${reps === 1 ? "rep" : "reps"}`;

/**
 * A set's values in the fields it records, such as "60 kg × 8" or "500 m in 2:00", or null
 * when it holds none of them.
 */
export const setValuesText = (
  set: SetValues,
  fields: SetFields,
  unit: WeightUnit = "kg",
): SetText | null => {
  const parts = SET_FIELD_COLUMNS[fields].flatMap((column): Array<SetText> => {
    const value = columnValue(set, column);
    if (value === null) return [];
    switch (column) {
      case "weight": {
        const weight = `${formatWeight(value, unit)} ${unit}`;
        return [{ text: weight, label: weight }];
      }
      case "reps":
        return [
          {
            text: fields === "weight_reps" ? String(value) : repsText(value),
            label: repsText(value),
          },
        ];
      case "time":
        return [
          {
            text: formatDuration(DurationSeconds.make(value)),
            label: `${Math.round(value)} seconds`,
          },
        ];
      case "distance":
        return [{ text: `${value} m`, label: `${value} metres` }];
    }
  });
  if (parts.length === 0) return null;
  const separator = fields === "distance_time" ? " in " : " × ";
  return {
    text: parts.map((part) => part.text).join(separator),
    label: parts.map((part) => part.label).join(", "),
  };
};

/** What an empty field shows dimmed, and the value marking the set done takes from it. */
export type Placeholder = { readonly text: string; readonly value: number | null };

/**
 * An empty field shows the same set's value from last time, which marking it done fills in.
 * Without one, an empty reps field shows the routine's rep range, which it never fills in.
 */
export const placeholderFor = (
  set: Pick<ActivitySet, "targetRepsMin" | "targetRepsMax">,
  column: SetColumn,
  previous: SetValues | null,
  unit: WeightUnit = "kg",
): Placeholder | null => {
  const last = previous === null ? null : columnValue(previous, column);
  if (last !== null) return { text: columnText(column, last, unit), value: last };
  if (column !== "reps") return null;
  const { targetRepsMin: min, targetRepsMax: max } = set;
  if (min !== null && max !== null && min !== max) return { text: `${min}-${max}`, value: null };
  if (min !== null || max !== null) return { text: `${min ?? max}`, value: null };
  return null;
};

export type SetPatch = { -readonly [K in keyof SetValues | "done" | "setType"]?: ActivitySet[K] };

export type DoneResult =
  | { readonly ok: true; readonly patch: SetPatch }
  | { readonly ok: false; readonly problem: string };

/**
 * Marks a set done. Its empty fields take last time's values first. A set must then record
 * something besides its weight: reps, a time or a distance.
 */
export const markDone = (
  set: SetValues & Pick<ActivitySet, "targetRepsMin" | "targetRepsMax">,
  fields: SetFields,
  previous: SetValues | null,
): DoneResult => {
  const filled = SET_FIELD_COLUMNS[fields].flatMap((column) => {
    const value =
      columnValue(set, column) === null
        ? (placeholderFor(set, column, previous)?.value ?? null)
        : null;
    return value === null ? [] : [columnPatch(column, value)];
  });
  const patch: SetPatch = Object.assign({ done: true }, ...filled);
  const after = { ...set, ...patch };
  const recorded = SET_FIELD_COLUMNS[fields].some(
    (column) => column !== "weight" && columnValue(after, column) !== null,
  );
  if (recorded) return { ok: true, patch };
  const missing = SET_FIELD_COLUMNS[fields]
    .filter((column) => column !== "weight")
    .map((column) => SET_COLUMN[column].name)
    .join(" or ");
  return { ok: false, problem: `Enter the ${missing} first.` };
};

/**
 * The change one typed value makes to a set. A done set whose last recorded value is cleared
 * goes back to to do, since a done set must record something.
 */
export const fieldPatch = (
  set: SetValues & Pick<ActivitySet, "done">,
  fields: SetFields,
  column: SetColumn,
  value: number | null,
): SetPatch => {
  const patch: SetPatch = columnPatch(column, value);
  const after = { ...set, ...patch };
  const records = SET_FIELD_COLUMNS[fields].some(
    (kept) => kept !== "weight" && columnValue(after, kept) !== null,
  );
  if (set.done && !records) patch.done = false;
  return patch;
};

/** The changes that keep only the values the new fields show. A set left recording nothing is no longer done. */
export const setsForFields = <
  S extends SetValues & { readonly id: unknown; readonly done: boolean },
>(
  sets: ReadonlyArray<S>,
  fields: SetFields,
): ReadonlyArray<{ readonly id: S["id"]; readonly patch: SetPatch }> => {
  const kept = SET_FIELD_COLUMNS[fields];
  return sets.flatMap((set) => {
    const cleared = (["weight", "reps", "time", "distance"] as const).filter(
      (column) => !kept.includes(column) && columnValue(set, column) !== null,
    );
    const patch: SetPatch = Object.assign(
      {},
      ...cleared.map((column) => columnPatch(column, null)),
    );
    const after = { ...set, ...patch };
    const records = kept.some(
      (column) => column !== "weight" && columnValue(after, column) !== null,
    );
    if (set.done && !records) patch.done = false;
    return Object.keys(patch).length === 0 ? [] : [{ id: set.id, patch }];
  });
};

/** A new set at the end repeats the values of the last one, still to do. */
export const nextSet = (
  sets: ReadonlyArray<SetValues & Pick<ActivitySet, "setType">>,
): PlannedSet => {
  const last = sets.at(-1);
  return {
    setType: last === undefined || last.setType === "warm_up" ? "normal" : last.setType,
    weightKg: last?.weightKg ?? null,
    reps: last?.reps ?? null,
    durationS: last?.durationS ?? null,
    distanceM: last?.distanceM ?? null,
    targetRepsMin: null,
    targetRepsMax: null,
  };
};

/** A replaced exercise keeps its sets and their types, empty and still to do. */
export const REPLACED_SET: Omit<SetPatch, "setType"> &
  Pick<ActivitySet, "targetRepsMin" | "targetRepsMax"> = {
  weightKg: null,
  reps: null,
  durationS: null,
  distanceM: null,
  done: false,
  targetRepsMin: null,
  targetRepsMax: null,
};

export type FinishPlan<ExerciseId, SetId> =
  | {
      readonly ok: true;
      /** Sets not marked done are left out of the finished workout. */
      readonly dropSets: ReadonlyArray<SetId>;
      /** So are exercises left with no done set. */
      readonly dropExercises: ReadonlyArray<ExerciseId>;
      readonly doneSets: number;
    }
  | { readonly ok: false; readonly problem: string };

/** What finishing a workout keeps: only the sets marked done, and the exercises that have one. */
export const finishPlan = <ExerciseId, SetId>(
  exercises: ReadonlyArray<{
    readonly id: ExerciseId;
    readonly sets: ReadonlyArray<{ readonly id: SetId; readonly done: boolean }>;
  }>,
): FinishPlan<ExerciseId, SetId> => {
  const doneSets = exercises.reduce(
    (count, exercise) => count + exercise.sets.filter((set) => set.done).length,
    0,
  );
  if (doneSets === 0) {
    return { ok: false, problem: "Mark at least one set done, or discard the workout." };
  }
  return {
    ok: true,
    dropSets: exercises.flatMap((exercise) =>
      exercise.sets.filter((set) => !set.done).map((set) => set.id),
    ),
    dropExercises: exercises
      .filter((exercise) => !exercise.sets.some((set) => set.done))
      .map((exercise) => exercise.id),
    doneSets,
  };
};

/** How many sets finishing would leave out, for the question before it does. */
export const unfinishedSets = (
  exercises: ReadonlyArray<{ readonly sets: ReadonlyArray<{ readonly done: boolean }> }>,
): number =>
  exercises.reduce((count, exercise) => count + exercise.sets.filter((set) => !set.done).length, 0);

/** An empty workout's title by the hour it starts, such as "Morning workout". */
export const emptyWorkoutTitle = (hour: number): string => {
  if (hour >= 5 && hour < 12) return "Morning workout";
  if (hour >= 12 && hour < 17) return "Afternoon workout";
  if (hour >= 17 && hour < 22) return "Evening workout";
  return "Night workout";
};
