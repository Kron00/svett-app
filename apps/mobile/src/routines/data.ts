import {
  type Activity,
  ActivityRepository,
  type ExerciseId,
  ExerciseRepository,
  exerciseName,
  type Folder,
  type Routine,
  type RoutineDetail,
  type RoutineDraft,
  RoutineId,
  RoutineRepository,
  routinePosition,
  type TrainOverview,
  trainOverview,
} from "@svett/core";
import { Effect, Option, Schema } from "effect";
import { useCallback } from "react";

import { appDatabase } from "../data/database";
import { markLaunch } from "../data/launch-timing";
import { useOnFocus } from "../data/loaded";

type Repositories = RoutineRepository | ActivityRepository | ExerciseRepository;

/** Runs one effect on the repositories of the database this launch opened. */
export const runOnDatabase = <A, E>(effect: Effect.Effect<A, E, Repositories>): Promise<A> =>
  appDatabase().runPromise(effect);

/** The names of exercises by ID. A missing exercise, such as one deleted since, has none. */
const exerciseNames = (ids: Iterable<ExerciseId>) =>
  Effect.flatMap(Effect.service(ExerciseRepository), (exercises) => exercises.names(ids));

export { exerciseName };

export type RoutineOverview = TrainOverview;

const loadOverview = () =>
  runOnDatabase(trainOverview).then((overview) => {
    markLaunch("queried");
    return overview;
  });

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
