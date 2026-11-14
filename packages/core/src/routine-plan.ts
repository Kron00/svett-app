import { Schema } from "effect";

import { type DurationSeconds, formatDuration } from "./duration.ts";
import { linkParam, linkParams } from "./link-params.ts";
import type { PlannedSet, NewWorkout } from "./repositories/activities.ts";
import type { RoutineDetail, RoutineDraft, RoutineSetDraft } from "./repositories/routines.ts";
import {
  type ActivitySet,
  type ExerciseId,
  type Folder,
  FolderId,
  type Routine,
  type RoutineId,
  type SetType,
} from "./schema.ts";
import { formatWeightKg } from "./set-format.ts";
import { formatWeight, formatWeightWithUnit, kgFromText, type WeightUnit } from "./weight-unit.ts";

/** The position after the last of `rows`, so a new row goes to the end. */
export const endPosition = (rows: ReadonlyArray<{ readonly position: number }>): number =>
  rows.reduce((end, row) => Math.max(end, row.position + 1), 0);

/**
 * The title for a copy of a routine, such as "Push copy", that no other routine has. A long
 * title is shortened so the copy's title still fits `ROUTINE_TITLE_MAX_LENGTH`.
 */
export const copyTitle = (title: string, taken: Iterable<string>): string => {
  const names = new Set(taken);
  const named = (suffix: string) =>
    `${title.slice(0, ROUTINE_TITLE_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
  let candidate = named(" copy");
  for (let number = 2; names.has(candidate); number += 1) candidate = named(` copy ${number}`);
  return candidate;
};

/** The list with the item at `from` moved to `to`. Out of range moves change nothing. */
export const moveItem = <A>(
  items: ReadonlyArray<A>,
  from: number,
  to: number,
): ReadonlyArray<A> => {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as A);
  return next;
};

/** A block of the Train tab's routine list: the routines in no folder, or one folder's. */
export interface RoutineSection {
  readonly folder: Folder | null;
  readonly routines: ReadonlyArray<Routine>;
}

/**
 * Routines grouped by folder, each group in its stored order. Routines in no folder come
 * first, and their group shows only when it has routines or there are no folders. A
 * routine whose folder is missing, as sync may deliver it before the folder, counts as in
 * no folder.
 */
export const routineSections = (
  folders: ReadonlyArray<Folder>,
  routines: ReadonlyArray<Routine>,
): ReadonlyArray<RoutineSection> => {
  const known = new Set<FolderId>(folders.map((folder) => folder.id));
  const byPosition = [...routines].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1),
  );
  const loose = byPosition.filter(
    (routine) => routine.folderId === null || !known.has(routine.folderId),
  );
  const sections = [...folders]
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
    .map((folder) => ({
      folder,
      routines: byPosition.filter((routine) => routine.folderId === folder.id),
    }));
  return loose.length > 0 || sections.length === 0
    ? [{ folder: null, routines: loose }, ...sections]
    : sections;
};

/** The exercises a routine row lists under its title, such as "Squat, Bench Press and 2 more". */
export const exerciseNamesSummary = (names: ReadonlyArray<string>): string => {
  if (names.length === 0) return "No exercises";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
};

/** What a target shows, and what VoiceOver reads for it. */
export type TargetText = { readonly text: string; readonly label: string };

const repWord = (reps: number) => (reps === 1 ? "rep" : "reps");

const repTarget = (min: number | null, max: number | null): TargetText | null => {
  if (min !== null && (max === null || max === min)) {
    return max === null
      ? { text: `${min}+ reps`, label: `${min} or more reps` }
      : { text: `${min} ${repWord(min)}`, label: `${min} ${repWord(min)}` };
  }
  if (min !== null && max !== null) {
    return { text: `${min}-${max} reps`, label: `${min} to ${max} reps` };
  }
  if (max !== null)
    return { text: `up to ${max} ${repWord(max)}`, label: `up to ${max} ${repWord(max)}` };
  return null;
};

export type TargetValues = Pick<
  RoutineSetDraft,
  "weightKg" | "repsMin" | "repsMax" | "durationS" | "distanceM"
>;

/** A routine set's target, such as "60 kg × 8-12 reps", or "No target" when it has none. */
export const setTargetText = (set: TargetValues, unit: WeightUnit = "kg"): TargetText => {
  const parts: Array<TargetText> = [];
  if (set.weightKg !== null) {
    const weight = formatWeightWithUnit(set.weightKg, unit);
    parts.push({ text: weight, label: weight });
  }
  const reps = repTarget(set.repsMin, set.repsMax);
  if (reps !== null) parts.push(reps);
  if (set.durationS !== null) {
    parts.push({
      text: formatDuration(set.durationS),
      label: `${Math.round(set.durationS)} seconds`,
    });
  }
  if (set.distanceM !== null) {
    const distance = `${formatWeightKg(set.distanceM)} m`;
    parts.push({ text: distance, label: `${formatWeightKg(set.distanceM)} metres` });
  }
  return parts.length === 0
    ? { text: "No target", label: "No target" }
    : {
        text: parts.map((part) => part.text).join(" × "),
        label: parts.map((part) => part.label).join(", "),
      };
};

/**
 * What a set of a workout in progress shows: the values filled in, and the routine's rep
 * range while the reps are still empty.
 */
export const plannedSetText = (
  set: Pick<
    ActivitySet,
    "weightKg" | "reps" | "durationS" | "distanceM" | "targetRepsMin" | "targetRepsMax"
  >,
  unit: WeightUnit = "kg",
): TargetText =>
  setTargetText(
    {
      weightKg: set.weightKg,
      repsMin: set.reps ?? set.targetRepsMin,
      repsMax: set.reps ?? set.targetRepsMax,
      durationS: set.durationS,
      distanceM: set.distanceM,
    },
    unit,
  );

/**
 * Where a saved routine goes: it keeps its place while it stays in its folder, and goes to
 * the end of the folder it is new to.
 */
export const routinePosition = (
  routines: ReadonlyArray<Routine>,
  id: RoutineId | null,
  folderId: FolderId | null,
): number => {
  const current = routines.find((routine) => routine.id === id);
  if (current !== undefined && current.folderId === folderId) return current.position;
  return endPosition(
    routines.filter((routine) => routine.folderId === folderId && routine.id !== id),
  );
};

/** A set still to do in a workout started from a routine. */
const plannedSet = ({
  setType,
  weightKg,
  repsMin,
  repsMax,
  durationS,
  distanceM,
}: RoutineSetDraft): PlannedSet => ({
  setType,
  weightKg,
  // An exact target is the value to log. A range leaves the reps to fill in.
  reps: repsMin !== null && repsMin === repsMax ? repsMin : null,
  durationS,
  distanceM,
  targetRepsMin: repsMin,
  targetRepsMax: repsMax,
});

/** The workout a routine starts: its exercises in order, each set filled in from its target. */
export const workoutFromRoutine = ({ routine, exercises }: RoutineDetail): NewWorkout => ({
  title: routine.title,
  routineId: routine.id,
  exercises: exercises.map(({ exercise, sets }) => ({
    exerciseId: exercise.exerciseId,
    supersetGroup: exercise.supersetGroup,
    restS: exercise.restS,
    notes: exercise.notes,
    sets: sets.map(plannedSet),
  })),
});

export const ROUTINE_TITLE_MAX_LENGTH = 80;

export const EMPTY_TARGET: RoutineSetDraft = {
  setType: "normal",
  weightKg: null,
  repsMin: null,
  repsMax: null,
  durationS: null,
  distanceM: null,
};

export interface RoutineFormExercise {
  /** Stays with the exercise while it moves, so the list keeps track of it. */
  readonly key: number;
  readonly exerciseId: ExerciseId;
  readonly supersetGroup: number | null;
  readonly restS: DurationSeconds | null;
  readonly notes: string;
  readonly sets: ReadonlyArray<RoutineSetDraft>;
}

/** What the routine editor holds while the user builds a routine. */
export interface RoutineForm {
  readonly title: string;
  readonly notes: string;
  readonly folderId: FolderId | null;
  readonly exercises: ReadonlyArray<RoutineFormExercise>;
  readonly nextKey: number;
}

export const newRoutineForm = (title = "", folderId: FolderId | null = null): RoutineForm => ({
  title,
  notes: "",
  folderId,
  exercises: [],
  nextKey: 0,
});

/**
 * A new routine form filled from a link such as svett://routines/new?title=Push&folder=<id>.
 * A folder that is not a folder ID is left out.
 */
export const routineFormFromParams = (params: unknown): RoutineForm => {
  const record = linkParams(params);
  return newRoutineForm(
    (linkParam(Schema.String, record["title"]) ?? "").slice(0, ROUTINE_TITLE_MAX_LENGTH),
    linkParam(FolderId, record["folder"]),
  );
};

export const routineForm = ({ routine, exercises }: RoutineDetail): RoutineForm => ({
  title: routine.title,
  notes: routine.notes,
  folderId: routine.folderId,
  exercises: exercises.map(({ exercise, sets }, key) => ({
    key,
    exerciseId: exercise.exerciseId,
    supersetGroup: exercise.supersetGroup,
    restS: exercise.restS,
    notes: exercise.notes,
    sets: sets.map(({ setType, weightKg, repsMin, repsMax, durationS, distanceM }) => ({
      setType,
      weightKg,
      repsMin,
      repsMax,
      durationS,
      distanceM,
    })),
  })),
  nextKey: exercises.length,
});

/** Adds exercises at the end, each with one set and no target yet. */
export const addExercises = (form: RoutineForm, ids: ReadonlyArray<ExerciseId>): RoutineForm => ({
  ...form,
  exercises: [
    ...form.exercises,
    ...ids.map((exerciseId, index) => ({
      key: form.nextKey + index,
      exerciseId,
      supersetGroup: null,
      restS: null,
      notes: "",
      sets: [EMPTY_TARGET],
    })),
  ],
  nextKey: form.nextKey + ids.length,
});

export const removeExercise = (form: RoutineForm, index: number): RoutineForm => ({
  ...form,
  exercises: form.exercises.filter((_, at) => at !== index),
});

export const moveExercise = (form: RoutineForm, from: number, to: number): RoutineForm => ({
  ...form,
  exercises: moveItem(form.exercises, from, to),
});

const changeSets = (
  form: RoutineForm,
  exerciseIndex: number,
  change: (sets: ReadonlyArray<RoutineSetDraft>) => ReadonlyArray<RoutineSetDraft>,
): RoutineForm => ({
  ...form,
  exercises: form.exercises.map((exercise, at) =>
    at === exerciseIndex ? { ...exercise, sets: change(exercise.sets) } : exercise,
  ),
});

/** Adds a set that copies the exercise's last set, as most sets repeat the one before. */
export const addSet = (form: RoutineForm, exerciseIndex: number): RoutineForm =>
  changeSets(form, exerciseIndex, (sets) => [...sets, sets.at(-1) ?? EMPTY_TARGET]);

export const removeSet = (
  form: RoutineForm,
  exerciseIndex: number,
  setIndex: number,
): RoutineForm =>
  changeSets(form, exerciseIndex, (sets) => sets.filter((_, at) => at !== setIndex));

export const replaceSet = (
  form: RoutineForm,
  exerciseIndex: number,
  setIndex: number,
  set: RoutineSetDraft,
): RoutineForm =>
  changeSets(form, exerciseIndex, (sets) => sets.map((old, at) => (at === setIndex ? set : old)));

export type RoutineFormResult =
  | { readonly ok: true; readonly routine: Omit<RoutineDraft, "position"> }
  | { readonly ok: false; readonly error: string };

/** The routine to save, or what the user still has to fix. */
export const routineFromForm = (form: RoutineForm): RoutineFormResult => {
  const title = form.title.trim();
  if (title === "") return { ok: false, error: "Give the routine a name." };
  if (form.exercises.length === 0) return { ok: false, error: "Add at least one exercise." };
  return {
    ok: true,
    routine: {
      title: title.slice(0, ROUTINE_TITLE_MAX_LENGTH),
      notes: form.notes.trim(),
      folderId: form.folderId,
      exercises: form.exercises.map(({ key: _key, ...exercise }) => exercise),
    },
  };
};

/** The text the set sheet's fields hold while the user types a target. */
export interface SetTargetEntry {
  readonly setType: SetType;
  readonly weight: string;
  readonly repsFrom: string;
  readonly repsTo: string;
}

/** The fields a set's target opens with, its weight in `unit`. */
export const setTargetEntry = (set: RoutineSetDraft, unit: WeightUnit = "kg"): SetTargetEntry => ({
  setType: set.setType,
  weight: set.weightKg === null ? "" : formatWeight(set.weightKg, unit),
  repsFrom: set.repsMin === null ? "" : String(set.repsMin),
  repsTo: set.repsMax === null || set.repsMax === set.repsMin ? "" : String(set.repsMax),
});

const entryNumber = (text: string): number | null => {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
};

/**
 * The target the set sheet's fields describe. One rep count is an exact target, two are a
 * range, and a range typed high to low is turned round. Time and distance stay as they were.
 * The weight is typed in `unit`, and one that still reads as the stored weight keeps it.
 */
export const setTargetFromEntry = (
  entry: SetTargetEntry,
  base: RoutineSetDraft,
  unit: WeightUnit = "kg",
): RoutineSetDraft => {
  const from = entryNumber(entry.repsFrom);
  const to = entryNumber(entry.repsTo);
  const low = from === null ? to : to === null ? from : Math.min(from, to);
  const high = from === null ? to : to === null ? from : Math.max(from, to);
  return {
    ...base,
    setType: entry.setType,
    weightKg: kgFromText(entry.weight, base.weightKg, unit),
    repsMin: low === null ? null : Math.round(low),
    repsMax: high === null ? null : Math.round(high),
  };
};
