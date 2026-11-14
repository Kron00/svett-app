import {
  type ActivityExerciseId,
  ActivityRepository,
  type ActivitySet,
  addExercisesToWorkout,
  type ExerciseId,
  fieldPatch,
  type LoggedExercise,
  leaveSuperset,
  moveItem,
  nextSet,
  type PlannedSet,
  replaceWorkoutExercise,
  type SetColumn,
  type SetFields,
  type SetType,
  startEmptyWorkout,
  supersetWithNext,
  toggleDone,
  type DurationSeconds,
} from "@svett/core";
import { Effect } from "effect";

import { skipRestTimer } from "./rest";
import { changeSet, changeWorkout, currentWorkout, saveWorkout } from "./store";

const withActivities = <A, E>(
  body: (activities: typeof ActivityRepository.Service) => Effect.Effect<A, E>,
) => Effect.flatMap(Effect.service(ActivityRepository), body);

/** Starts an empty workout. False when another workout is in progress. */
export const startEmpty = () =>
  saveWorkout(
    startEmptyWorkout(new Date().getHours()).pipe(
      Effect.as(true),
      Effect.catchTag("WorkoutInProgressError", () => Effect.succeed(false)),
    ),
  );

const inProgress = () => currentWorkout()?.activity.id ?? null;

export const addExercises = (ids: ReadonlyArray<ExerciseId>) => {
  const id = inProgress();
  if (id !== null) void saveWorkout(addExercisesToWorkout(id, ids));
};

export const replaceExercise = (row: ActivityExerciseId, exerciseId: ExerciseId) => {
  const id = inProgress();
  if (id !== null) void saveWorkout(replaceWorkoutExercise(id, row, exerciseId));
};

export const removeExercise = (row: ActivityExerciseId) =>
  void saveWorkout(withActivities((activities) => activities.removeExercise(row)));

export const moveExercise = (from: number, to: number) => {
  const log = currentWorkout();
  if (log === null) return;
  const order = moveItem(
    log.exercises.map((exercise) => exercise.row.id),
    from,
    to,
  );
  void saveWorkout(
    withActivities((activities) => activities.orderExercises(log.activity.id, order)),
  );
};

export const logBy = (exercise: LoggedExercise, fields: SetFields) =>
  void saveWorkout(
    withActivities((activities) => activities.changeSetFields(exercise.row.id, fields)),
  );

export const addSet = (exercise: LoggedExercise) =>
  void saveWorkout(
    withActivities((activities) => activities.addSet(exercise.row.id, nextSet(exercise.sets))),
  );

export const removeSet = (set: ActivitySet) =>
  void saveWorkout(withActivities((activities) => activities.removeSet(set.id)));

export const setSetType = (set: ActivitySet, setType: SetType) =>
  changeSet(
    set.id,
    { setType },
    withActivities((activities) => activities.updateWorkoutSet(set.id, { setType })),
  );

/**
 * Marks a set done, or to do again, and shows it once it is saved. Returns why it cannot be
 * done yet, or null.
 */
export const toggleSetDone = (exercise: LoggedExercise, index: number): string | null => {
  const set = exercise.sets[index];
  if (set === undefined) return null;
  const result = toggleDone(set, exercise.row.setFields, exercise.previous[index] ?? null);
  if (!result.ok) return result.problem;
  changeSet(
    set.id,
    result.patch,
    withActivities((activities) => activities.updateWorkoutSet(set.id, result.patch)),
    "once saved",
  );
  return null;
};

/**
 * Types a value into a set. Clearing its last recorded value also marks it to do again, worked
 * out from the set as it is when the change applies, so a save still waiting ahead counts.
 */
export const typeValue = (set: ActivitySet, column: SetColumn, value: number | null) => {
  changeSet(
    set.id,
    (current, fields) => fieldPatch(current, fields, column, value),
    withActivities((activities) => activities.changeSetValue(set.id, column, value)),
  );
};

/** Changes how long the rest timer runs after each set of an exercise. 0 turns it off. */
export const setRestTime = (row: ActivityExerciseId, restS: DurationSeconds) =>
  changeWorkout(
    (log) => ({
      ...log,
      exercises: log.exercises.map((exercise) =>
        exercise.row.id === row ? { ...exercise, row: { ...exercise.row, restS } } : exercise,
      ),
    }),
    withActivities((activities) => activities.updateExercise(row, { restS })),
  );

/** Sets or clears a set's RPE. */
export const setSetRpe = (set: ActivitySet, rpe: number | null) =>
  changeSet(
    set.id,
    { rpe },
    withActivities((activities) => activities.updateWorkoutSet(set.id, { rpe })),
  );

const groupExercises = async (change: typeof supersetWithNext, index: number) => {
  const log = currentWorkout();
  if (log === null) return;
  const rows = log.exercises.map((exercise) => exercise.row);
  const changes = change(rows, index);
  if (changes.length === 0) return;
  await saveWorkout(
    withActivities((activities) =>
      activities.groupExercises(
        changes.map(({ index: at, supersetGroup }) => ({ id: rows[at]!.id, supersetGroup })),
      ),
    ),
  );
};

/** Joins the exercise at `index`, and any superset it is in, with the next exercise. */
export const supersetWithNextAt = (index: number): Promise<void> =>
  groupExercises(supersetWithNext, index);

/** Takes the exercise at `index` out of the superset it is in. */
export const leaveSupersetAt = (index: number): Promise<void> =>
  groupExercises(leaveSuperset, index);

/** Puts warm-up sets before an exercise's first set, in place of its warm-ups still to do. */
export const addWarmUpSets = (row: ActivityExerciseId, sets: ReadonlyArray<PlannedSet>) =>
  saveWorkout(withActivities((activities) => activities.replaceWarmUpSets(row, sets)));

export const renameWorkout = (title: string) => {
  const id = inProgress();
  if (id === null) return;
  changeWorkout(
    (log) => ({ ...log, activity: { ...log.activity, title } }),
    withActivities((activities) => activities.updateWorkout(id, { title })),
  );
};

export const setWorkoutNotes = (notes: string) => {
  const id = inProgress();
  if (id === null) return;
  changeWorkout(
    (log) => ({ ...log, activity: { ...log.activity, notes } }),
    withActivities((activities) => activities.updateWorkout(id, { notes })),
  );
};

export const setExerciseNotes = (row: ActivityExerciseId, notes: string) =>
  changeWorkout(
    (log) => ({
      ...log,
      exercises: log.exercises.map((exercise) =>
        exercise.row.id === row ? { ...exercise, row: { ...exercise.row, notes } } : exercise,
      ),
    }),
    withActivities((activities) => activities.updateExercise(row, { notes })),
  );

export type FinishResult =
  | { readonly finished: true }
  | { readonly finished: false; readonly problem: string };

/** Finishes the workout in progress with its done sets and ends its rest, or says why it cannot. */
export const finish = async (): Promise<FinishResult> => {
  const id = inProgress();
  if (id === null) return { finished: false, problem: "No workout is in progress." };
  const result = await saveWorkout(
    withActivities((activities) => activities.finishWorkout(id)).pipe(
      Effect.as<FinishResult>({ finished: true }),
      Effect.catchTag("NothingDoneError", ({ problem }) =>
        Effect.succeed<FinishResult>({ finished: false, problem }),
      ),
    ),
    true,
  );
  if (result?.finished === true) await skipRestTimer();
  return result ?? { finished: false, problem: "The workout was not saved." };
};

/**
 * Discards the workout in progress and ends its rest. Nothing from it reaches history. False
 * when the delete fails, so the workout and its rest stay and the screen shows why.
 */
export const discard = async (): Promise<boolean> => {
  const id = inProgress();
  const removed =
    id === null
      ? true
      : ((await saveWorkout(
          withActivities((activities) => activities.remove(id)).pipe(Effect.as(true)),
        )) ?? false);
  if (removed) await skipRestTimer();
  return removed;
};
