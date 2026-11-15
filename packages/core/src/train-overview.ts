import { Effect, Option } from "effect";

import { ActivityRepository } from "./repositories/activities.ts";
import { ExerciseRepository } from "./repositories/exercises.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { exerciseNamesSummary, type RoutineSection, routineSections } from "./routine-plan.ts";
import type { Activity, ExerciseId, Folder, RoutineId } from "./schema.ts";

/** An exercise's name from a map of names, or "Deleted exercise" when the map has none. */
export const exerciseName = (names: ReadonlyMap<ExerciseId, string>, id: ExerciseId) =>
  names.get(id) ?? "Deleted exercise";

export interface TrainOverview {
  readonly sections: ReadonlyArray<RoutineSection>;
  readonly folders: ReadonlyArray<Folder>;
  /** The exercises each routine lists under its title. */
  readonly summaries: ReadonlyMap<RoutineId, string>;
  readonly inProgress: Activity | null;
}

/**
 * What the Train tab shows first: routines by folder with their exercises, and the workout in
 * progress. It is the read a cold start waits on, so it never reads the workout history.
 */
export const trainOverview = Effect.gen(function* () {
  const routines = yield* RoutineRepository;
  const activities = yield* ActivityRepository;
  const exercises = yield* ExerciseRepository;
  const folders = yield* routines.listFolders;
  const list = yield* routines.listRoutines;
  const routineExercises = yield* routines.listRoutineExercises;
  const names = yield* exercises.names(routineExercises.map((exercise) => exercise.exerciseId));
  const summaries = new Map<RoutineId, string>();
  for (const routine of list) {
    summaries.set(
      routine.id,
      exerciseNamesSummary(
        routineExercises
          .filter((exercise) => exercise.routineId === routine.id)
          .map((exercise) => exerciseName(names, exercise.exerciseId)),
      ),
    );
  }
  const inProgress = yield* activities.inProgress;
  return {
    sections: routineSections(folders, list),
    folders,
    summaries,
    inProgress: Option.isSome(inProgress) ? inProgress.value.activity : null,
  } satisfies TrainOverview;
});
