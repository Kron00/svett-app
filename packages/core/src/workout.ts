import { Option, Schema } from "effect";

import { DurationSeconds } from "./duration.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Rpe = Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 10 }));

export const SetKind = Schema.Literals(["warmup", "normal", "failure", "drop"]);
export type SetKind = typeof SetKind.Type;

export const WorkoutSet = Schema.Struct({
  id: Schema.String,
  kind: SetKind,
  weightKg: Schema.optionalKey(NonNegative),
  reps: Schema.optionalKey(NonNegativeInt),
  seconds: Schema.optionalKey(NonNegative),
  meters: Schema.optionalKey(NonNegative),
  rpe: Schema.optionalKey(Rpe),
  restSeconds: Schema.optionalKey(NonNegativeInt),
  completedAt: Schema.NullOr(NonNegativeInt),
});
export type WorkoutSet = typeof WorkoutSet.Type;

export const WorkoutExercise = Schema.Struct({
  id: Schema.String,
  exerciseId: Schema.String,
  restSeconds: NonNegativeInt,
  sets: Schema.Array(WorkoutSet),
});
export type WorkoutExercise = typeof WorkoutExercise.Type;

export const RestTimer = Schema.Struct({ setId: Schema.String, endsAt: NonNegativeInt });
export type RestTimer = typeof RestTimer.Type;

export const WorkoutPhase = Schema.TaggedUnion({
  Active: { rest: Schema.NullOr(RestTimer) },
  Finished: { endedAt: NonNegativeInt },
  Discarded: { endedAt: NonNegativeInt },
});
export type WorkoutPhase = typeof WorkoutPhase.Type;

export const Workout = Schema.Struct({
  id: Schema.String,
  startedAt: NonNegativeInt,
  exercises: Schema.Array(WorkoutExercise),
  phase: WorkoutPhase,
});
export type Workout = typeof Workout.Type;

export const SetFields = Schema.Struct({
  kind: Schema.optionalKey(SetKind),
  weightKg: Schema.optionalKey(Schema.NullOr(NonNegative)),
  reps: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  seconds: Schema.optionalKey(Schema.NullOr(NonNegative)),
  meters: Schema.optionalKey(Schema.NullOr(NonNegative)),
  rpe: Schema.optionalKey(Schema.NullOr(Rpe)),
});
export type SetFields = typeof SetFields.Type;

export const WorkoutCommand = Schema.TaggedUnion({
  AddExercise: { entryId: Schema.String, exerciseId: Schema.String, restSeconds: NonNegativeInt },
  RemoveExercise: { entryId: Schema.String },
  MoveExercise: {
    entryId: Schema.String,
    toIndex: NonNegativeInt,
  },
  AddSet: { entryId: Schema.String, setId: Schema.String, kind: SetKind },
  RemoveSet: { setId: Schema.String },
  UpdateSet: { setId: Schema.String, fields: SetFields },
  CompleteSet: { setId: Schema.String, at: NonNegativeInt },
  UncompleteSet: { setId: Schema.String },
  SetRest: { setId: Schema.String, restSeconds: Schema.NullOr(NonNegativeInt) },
  AdjustRest: { setId: Schema.String, endsAt: NonNegativeInt },
  SkipRest: { setId: Schema.String },
  Finish: { at: NonNegativeInt },
  Discard: { at: NonNegativeInt },
});
export type WorkoutCommand = typeof WorkoutCommand.Type;

type Draft<T> = { -readonly [K in keyof T]: T[K] };

const measureKeys = ["weightKg", "reps", "seconds", "meters", "rpe"] as const;
const prefillKeys = ["weightKg", "reps", "seconds", "meters"] as const;

export const startWorkout = (id: string, startedAt: number): Workout => ({
  id,
  startedAt,
  exercises: [],
  phase: { _tag: "Active", rest: null },
});

const findSet = (
  workout: Workout,
  setId: string,
): { readonly exercise: WorkoutExercise; readonly set: WorkoutSet } | undefined => {
  for (const exercise of workout.exercises) {
    const set = exercise.sets.find((candidate) => candidate.id === setId);
    if (set !== undefined) return { exercise, set };
  }
  return undefined;
};

const mapSets = (
  workout: Workout,
  exerciseId: string,
  map: (sets: ReadonlyArray<WorkoutSet>) => ReadonlyArray<WorkoutSet>,
): Workout => ({
  ...workout,
  exercises: workout.exercises.map((exercise) =>
    exercise.id === exerciseId ? { ...exercise, sets: map(exercise.sets) } : exercise,
  ),
});

const replaceSet = (workout: Workout, exerciseId: string, next: WorkoutSet): Workout =>
  mapSets(workout, exerciseId, (sets) => sets.map((set) => (set.id === next.id ? next : set)));

const withRest = (workout: Workout, rest: RestTimer | null): Workout => ({
  ...workout,
  phase: { _tag: "Active", rest },
});

const editSet = (set: WorkoutSet, fields: SetFields): WorkoutSet => {
  const next: Draft<WorkoutSet> = { ...set, kind: fields.kind ?? set.kind };
  for (const key of measureKeys) {
    const value = fields[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next;
};

const prefilledSet = (id: string, kind: SetKind, previous: WorkoutSet | undefined): WorkoutSet => {
  const next: Draft<WorkoutSet> = { id, kind, completedAt: null };
  for (const key of prefillKeys) {
    const value = previous?.[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
};

const isCommand = Schema.is(WorkoutCommand);

const step = (workout: Workout, rest: RestTimer | null, command: WorkoutCommand): Workout =>
  WorkoutCommand.match(command, {
    AddExercise: ({ entryId, exerciseId, restSeconds }): Workout => {
      if (workout.exercises.some((exercise) => exercise.id === entryId)) return workout;
      const exercise = { id: entryId, exerciseId, restSeconds, sets: [] };
      return { ...workout, exercises: [...workout.exercises, exercise] };
    },
    RemoveExercise: ({ entryId }): Workout => {
      const removed = workout.exercises.find((exercise) => exercise.id === entryId);
      if (removed === undefined) return workout;
      const exercises = workout.exercises.filter((exercise) => exercise !== removed);
      const timerGone = removed.sets.some((set) => set.id === rest?.setId);
      return withRest({ ...workout, exercises }, timerGone ? null : rest);
    },
    MoveExercise: ({ entryId, toIndex }): Workout => {
      const from = workout.exercises.findIndex((exercise) => exercise.id === entryId);
      const moving = workout.exercises[from];
      const to = Math.min(toIndex, workout.exercises.length - 1);
      if (moving === undefined || from === to) return workout;
      return {
        ...workout,
        exercises: workout.exercises.toSpliced(from, 1).toSpliced(to, 0, moving),
      };
    },
    AddSet: ({ entryId, setId, kind }): Workout => {
      const exercise = workout.exercises.find((candidate) => candidate.id === entryId);
      if (exercise === undefined || findSet(workout, setId) !== undefined) return workout;
      const set = prefilledSet(setId, kind, exercise.sets.at(-1));
      return mapSets(workout, exercise.id, (sets) => [...sets, set]);
    },
    RemoveSet: ({ setId }): Workout => {
      const found = findSet(workout, setId);
      if (found === undefined) return workout;
      const next = mapSets(workout, found.exercise.id, (sets) =>
        sets.filter((set) => set.id !== setId),
      );
      return withRest(next, rest?.setId === setId ? null : rest);
    },
    UpdateSet: ({ setId, fields }): Workout => {
      const found = findSet(workout, setId);
      if (found === undefined) return workout;
      return replaceSet(workout, found.exercise.id, editSet(found.set, fields));
    },
    CompleteSet: ({ setId, at }): Workout => {
      const found = findSet(workout, setId);
      if (found === undefined || found.set.completedAt !== null) return workout;
      const restSeconds = found.set.restSeconds ?? found.exercise.restSeconds;
      const next = replaceSet(workout, found.exercise.id, { ...found.set, completedAt: at });
      const runningSince =
        rest === null ? null : (findSet(workout, rest.setId)?.set.completedAt ?? null);
      // A replayed older completion must not take the timer from a set finished after it.
      if (runningSince !== null && runningSince > at) return next;
      return withRest(next, restSeconds > 0 ? { setId, endsAt: at + restSeconds * 1000 } : null);
    },
    UncompleteSet: ({ setId }): Workout => {
      const found = findSet(workout, setId);
      if (found === undefined || found.set.completedAt === null) return workout;
      const next = replaceSet(workout, found.exercise.id, { ...found.set, completedAt: null });
      return withRest(next, rest?.setId === setId ? null : rest);
    },
    SetRest: ({ setId, restSeconds }): Workout => {
      const found = findSet(workout, setId);
      if (found === undefined) return workout;
      const set: Draft<WorkoutSet> = { ...found.set };
      if (restSeconds === null) delete set.restSeconds;
      else set.restSeconds = restSeconds;
      return replaceSet(workout, found.exercise.id, set);
    },
    AdjustRest: ({ setId, endsAt }): Workout => {
      const completedAt = findSet(workout, setId)?.set.completedAt ?? null;
      if (rest?.setId !== setId || completedAt === null) return workout;
      return withRest(workout, { setId, endsAt: Math.max(endsAt, completedAt) });
    },
    SkipRest: ({ setId }): Workout => (rest?.setId === setId ? withRest(workout, null) : workout),
    Finish: ({ at }): Workout => ({ ...workout, phase: { _tag: "Finished", endedAt: at } }),
    Discard: ({ at }): Workout => ({ ...workout, phase: { _tag: "Discarded", endedAt: at } }),
  });

export const applyCommand = (workout: Workout, command: WorkoutCommand): Workout =>
  WorkoutPhase.match(workout.phase, {
    Active: ({ rest }) => (isCommand(command) ? step(workout, rest, command) : workout),
    Finished: () => workout,
    Discarded: () => workout,
  });

export const restRemainingSeconds = (workout: Workout, now: number): number | null =>
  WorkoutPhase.match(workout.phase, {
    Active: ({ rest }) =>
      rest === null ? null : Math.max(0, Math.ceil((rest.endsAt - now) / 1000)),
    Finished: () => null,
    Discarded: () => null,
  });

export const workoutDurationSeconds = (workout: Workout, now: number): DurationSeconds => {
  const end = WorkoutPhase.match(workout.phase, {
    Active: () => now,
    Finished: ({ endedAt }) => endedAt,
    Discarded: ({ endedAt }) => endedAt,
  });
  return DurationSeconds.make(Math.max(0, (end - workout.startedAt) / 1000));
};

// An app update kills a workout in progress. The version lets a build that changes this shape
// migrate an older save instead of failing to read it.
const SavedWorkout = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), workout: Workout }),
);

export const encodeWorkout = (workout: Workout): string =>
  Schema.encodeSync(SavedWorkout)({ version: 1, workout });

/** Undefined means the text could not be read. Keep that text instead of overwriting it. */
export const restoreWorkout = (text: string): Workout | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(SavedWorkout)(text))?.workout;
