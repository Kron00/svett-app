import { Effect, Option } from "effect";

import {
  chooseSetFields,
  emptyWorkoutTitle,
  markDone,
  matchPrevious,
  nextSet,
  REPLACED_SET,
  setsForFields,
} from "./logger.ts";
import {
  ActivityRepository,
  type LastPerformance,
  type PlannedSet,
} from "./repositories/activities.ts";
import { ExerciseRepository } from "./repositories/exercises.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { workoutFromRoutine } from "./routine-plan.ts";
import type {
  Activity,
  ActivityExercise,
  ActivityExerciseId,
  ActivityId,
  ActivitySet,
  ActivitySetId,
  Exercise,
  ExerciseId,
  RoutineId,
  SetFields,
} from "./schema.ts";
import { RowNotFoundError } from "./table.ts";

const exercisesById = (ids: Iterable<ExerciseId>) =>
  Effect.gen(function* () {
    const exercises = yield* ExerciseRepository;
    const found = new Map<ExerciseId, Exercise>();
    for (const id of new Set(ids)) {
      const exercise = yield* exercises.get(id);
      if (Option.isSome(exercise)) found.set(id, exercise.value);
    }
    return found;
  });

/**
 * Starts a workout from a routine: its exercises in order, each set still to do and filled
 * in from the routine's target. Each exercise records what its targets hold, else what it
 * recorded last time. Fails with WorkoutInProgressError while another workout is in progress.
 */
export const startWorkoutFromRoutine = (id: RoutineId) =>
  Effect.gen(function* () {
    const routines = yield* RoutineRepository;
    const activities = yield* ActivityRepository;
    const detail = yield* routines.getRoutine(id);
    if (Option.isNone(detail)) return yield* new RowNotFoundError({ table: "routine", id });
    const start = workoutFromRoutine(detail.value);
    const ids = start.exercises.map((exercise) => exercise.exerciseId);
    const last = yield* activities.lastPerformances(ids);
    const known = yield* exercisesById(ids);
    return yield* activities.startWorkout({
      ...start,
      exercises: start.exercises.map((exercise) =>
        Object.assign({}, exercise, {
          setFields: chooseSetFields({
            planned: exercise.sets,
            previous: last.get(exercise.exerciseId)?.setFields ?? null,
            exercise: known.get(exercise.exerciseId) ?? null,
          }),
        }),
      ),
    });
  });

/** Starts a workout with no exercises yet, named for the hour it starts, such as "Evening workout". */
export const startEmptyWorkout = (hour: number) =>
  Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
    activities.startWorkout({ title: emptyWorkoutTitle(hour), routineId: null, exercises: [] }),
  );

const EMPTY_SET: PlannedSet = nextSet([]);

/** The sets an exercise starts with: last time's set types, empty, or one set the first time. */
const startingSets = (last: LastPerformance | undefined): ReadonlyArray<PlannedSet> =>
  last === undefined || last.sets.length === 0
    ? [EMPTY_SET]
    : last.sets.map((set) => ({ ...EMPTY_SET, setType: set.setType }));

/** Adds exercises at the end of the workout in progress, each logged as it was last time. */
export const addExercisesToWorkout = (activityId: ActivityId, ids: ReadonlyArray<ExerciseId>) =>
  Effect.gen(function* () {
    const activities = yield* ActivityRepository;
    const last = yield* activities.lastPerformances(ids, activityId);
    const known = yield* exercisesById(ids);
    return yield* activities.addExercises(
      activityId,
      ids.map((exerciseId) => ({
        exerciseId,
        supersetGroup: null,
        notes: "",
        setFields: chooseSetFields({
          planned: [],
          previous: last.get(exerciseId)?.setFields ?? null,
          exercise: known.get(exerciseId) ?? null,
        }),
        sets: startingSets(last.get(exerciseId)),
      })),
    );
  });

/** Swaps an exercise of the workout in progress for another. Its sets stay, emptied. */
export const replaceWorkoutExercise = (
  activityId: ActivityId,
  id: ActivityExerciseId,
  exerciseId: ExerciseId,
) =>
  Effect.gen(function* () {
    const activities = yield* ActivityRepository;
    const last = yield* activities.lastPerformances([exerciseId], activityId);
    const known = yield* exercisesById([exerciseId]);
    yield* activities.replaceExercise(
      id,
      exerciseId,
      chooseSetFields({
        planned: [],
        previous: last.get(exerciseId)?.setFields ?? null,
        exercise: known.get(exerciseId) ?? null,
      }),
      REPLACED_SET,
    );
  });

/** Logs an exercise by other fields, such as time instead of reps. Values it no longer shows are cleared. */
export const changeSetFields = (
  id: ActivityExerciseId,
  sets: ReadonlyArray<ActivitySet>,
  setFields: SetFields,
) =>
  Effect.gen(function* () {
    const activities = yield* ActivityRepository;
    yield* activities.updateExercise(id, { setFields });
    for (const { id: setId, patch } of setsForFields(sets, setFields)) {
      yield* activities.updateSet(setId, patch);
    }
  });

/** One exercise of the workout in progress, as the logger shows it. */
export interface LoggedExercise {
  readonly row: ActivityExercise;
  /** Null when the exercise was deleted from the library since. */
  readonly exercise: Exercise | null;
  readonly sets: ReadonlyArray<ActivitySet>;
  /** The set from last time each set lines up with, by matchPrevious. */
  readonly previous: ReadonlyArray<ActivitySet | null>;
}

export interface WorkoutLog {
  readonly activity: Activity;
  readonly exercises: ReadonlyArray<LoggedExercise>;
  /** What each exercise held the last time it was done. */
  readonly last: ReadonlyMap<ExerciseId, LastPerformance>;
}

/** Lines up each exercise's sets with last time's again, after its sets changed. */
export const withPrevious = (
  exercise: Omit<LoggedExercise, "previous">,
  last: LastPerformance | undefined,
): LoggedExercise => ({
  ...exercise,
  previous: matchPrevious(
    exercise.sets.map((set) => set.setType),
    last?.sets ?? [],
  ),
});

/** The workout in progress with its exercises and last time's values, or none. */
export const loadWorkoutLog = Effect.gen(function* () {
  const activities = yield* ActivityRepository;
  const current = yield* activities.inProgress;
  if (Option.isNone(current)) return Option.none<WorkoutLog>();
  const { activity, exercises } = current.value;
  const ids = exercises.map(({ exercise }) => exercise.exerciseId);
  const last = yield* activities.lastPerformances(ids, activity.id);
  const known = yield* exercisesById(ids);
  return Option.some<WorkoutLog>({
    activity,
    last,
    exercises: exercises.map(({ exercise, sets }) =>
      withPrevious(
        { row: exercise, exercise: known.get(exercise.exerciseId) ?? null, sets },
        last.get(exercise.exerciseId),
      ),
    ),
  });
});

export type DoneToggle =
  | { readonly ok: true; readonly id: ActivitySetId; readonly patch: Partial<ActivitySet> }
  | { readonly ok: false; readonly problem: string };

/** Marks a set done, filling empty fields from last time, or marks a done set to do again. */
export const toggleDone = (
  set: ActivitySet,
  fields: SetFields,
  previous: ActivitySet | null,
): DoneToggle => {
  if (set.done) return { ok: true, id: set.id, patch: { done: false } };
  const result = markDone(set, fields, previous);
  return result.ok ? { ok: true, id: set.id, patch: result.patch } : result;
};
