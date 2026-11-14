import {
  type ActivityExerciseId,
  ActivityRepository,
  type ActivitySet,
  addExercisesToWorkout,
  changeSetFields,
  type ExerciseId,
  fieldPatch,
  type LoggedExercise,
  moveItem,
  nextSet,
  replaceWorkoutExercise,
  type SetColumn,
  type SetFields,
  type SetType,
  startEmptyWorkout,
  toggleDone,
} from "@svett/core";
import { Effect } from "effect";

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
  void saveWorkout(changeSetFields(exercise.row.id, exercise.sets, fields));

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
    withActivities((activities) => activities.updateSet(set.id, { setType })),
  );

/** Marks a set done, or to do again. Returns why it cannot be done yet, or null. */
export const toggleSetDone = (exercise: LoggedExercise, index: number): string | null => {
  const set = exercise.sets[index];
  if (set === undefined) return null;
  const result = toggleDone(set, exercise.row.setFields, exercise.previous[index] ?? null);
  if (!result.ok) return result.problem;
  changeSet(
    set.id,
    result.patch,
    withActivities((activities) => activities.updateSet(set.id, result.patch)),
  );
  return null;
};

export const typeValue = (
  exercise: LoggedExercise,
  set: ActivitySet,
  column: SetColumn,
  value: number | null,
) => {
  const patch = fieldPatch(set, exercise.row.setFields, column, value);
  changeSet(
    set.id,
    patch,
    withActivities((activities) => activities.updateSet(set.id, patch)),
  );
};

export const renameWorkout = (title: string) => {
  const id = inProgress();
  if (id === null) return;
  changeWorkout(
    (log) => ({ ...log, activity: { ...log.activity, title } }),
    withActivities((activities) => activities.update(id, { title })),
  );
};

export const setWorkoutNotes = (notes: string) => {
  const id = inProgress();
  if (id === null) return;
  changeWorkout(
    (log) => ({ ...log, activity: { ...log.activity, notes } }),
    withActivities((activities) => activities.update(id, { notes })),
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

/** Finishes the workout in progress with its done sets, or says why it cannot. */
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
  );
  return result ?? { finished: false, problem: "The workout was not saved." };
};

/** Discards the workout in progress. Nothing from it reaches history. */
export const discard = async () => {
  const id = inProgress();
  if (id !== null) await saveWorkout(withActivities((activities) => activities.remove(id)));
};
