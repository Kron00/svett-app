import {
  type Activity,
  ActivityRepository,
  type ExerciseId,
  ExerciseRepository,
  type Folder,
  exerciseNamesSummary,
  type Routine,
  type RoutineDetail,
  type RoutineDraft,
  RoutineId,
  RoutineRepository,
  type RoutineSection,
  routinePosition,
  routineSections,
} from "@svett/core";
import { Effect, Option, Schema } from "effect";
import { useCallback } from "react";

import { appDatabase } from "../data/database";
import { useOnFocus } from "../data/loaded";

type Repositories = RoutineRepository | ActivityRepository | ExerciseRepository;

/** Runs one effect on the repositories of the database this launch opened. */
export const runOnDatabase = <A, E>(effect: Effect.Effect<A, E, Repositories>): Promise<A> =>
  appDatabase().runPromise(effect);

/** The names of exercises by ID. A missing exercise, such as one deleted since, has none. */
const exerciseNames = (ids: Iterable<ExerciseId>) =>
  Effect.gen(function* () {
    const exercises = yield* ExerciseRepository;
    const names = new Map<ExerciseId, string>();
    for (const id of new Set(ids)) {
      const exercise = yield* exercises.get(id);
      if (Option.isSome(exercise)) names.set(id, exercise.value.name);
    }
    return names;
  });

export const exerciseName = (names: ReadonlyMap<ExerciseId, string>, id: ExerciseId) =>
  names.get(id) ?? "Deleted exercise";

export interface RoutineOverview {
  readonly sections: ReadonlyArray<RoutineSection>;
  readonly folders: ReadonlyArray<Folder>;
  /** The exercises each routine lists under its title. */
  readonly summaries: ReadonlyMap<RoutineId, string>;
  readonly inProgress: Activity | null;
}

const loadOverview = () =>
  runOnDatabase(
    Effect.gen(function* () {
      const routines = yield* RoutineRepository;
      const activities = yield* ActivityRepository;
      const folders = yield* routines.listFolders;
      const list = yield* routines.listRoutines;
      const routineExercises = yield* routines.listRoutineExercises;
      const names = yield* exerciseNames(routineExercises.map((exercise) => exercise.exerciseId));
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
      } satisfies RoutineOverview;
    }),
  );

/** The Train tab's routines by folder, and the workout in progress. */
export const useRoutineOverview = () => useOnFocus(loadOverview);

export interface RoutineView {
  readonly detail: RoutineDetail;
  readonly names: ReadonlyMap<ExerciseId, string>;
  readonly folders: ReadonlyArray<Folder>;
  /** The routines in the same folder, in order, this one among them. */
  readonly siblings: ReadonlyArray<Routine>;
}

/** A routine with its exercise names, or null when a link names no routine. */
export function useRoutine(id: string) {
  const load = useCallback(
    () =>
      Schema.is(RoutineId)(id)
        ? runOnDatabase(
            Effect.gen(function* () {
              const routines = yield* RoutineRepository;
              const detail = yield* routines.getRoutine(id);
              if (Option.isNone(detail)) return null;
              const { routine, exercises } = detail.value;
              const list = yield* routines.listRoutines;
              return {
                detail: detail.value,
                names: yield* exerciseNames(exercises.map(({ exercise }) => exercise.exerciseId)),
                folders: yield* routines.listFolders,
                siblings: list.filter((row) => row.folderId === routine.folderId),
              } satisfies RoutineView;
            }),
          )
        : Promise.resolve(null),
    [id],
  );
  return useOnFocus(load);
}

/** Saves the editor's routine, new or edited, and gives back its ID. */
export const saveRoutine = (id: RoutineId | null, routine: Omit<RoutineDraft, "position">) =>
  runOnDatabase(
    Effect.gen(function* () {
      const routines = yield* RoutineRepository;
      const position = routinePosition(yield* routines.listRoutines, id, routine.folderId);
      if (id === null) return yield* routines.createRoutine({ ...routine, position });
      yield* routines.saveRoutine(id, { ...routine, position });
      return id;
    }),
  );

export const withRoutines = <A, E>(
  body: (routines: typeof RoutineRepository.Service) => Effect.Effect<A, E>,
): Promise<A> => runOnDatabase(Effect.flatMap(Effect.service(RoutineRepository), body));
