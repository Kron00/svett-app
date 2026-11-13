import { Context, Effect, Layer, Option } from "effect";

import { Ids } from "../ids.ts";
import {
  type EpochMillis,
  type Folder,
  FolderId,
  type Routine,
  type RoutineExercise,
  RoutineExerciseId,
  RoutineId,
  type RoutineSet,
  RoutineSetId,
} from "../schema.ts";
import { Sql } from "../sql.ts";
import {
  currentTime,
  insertRows,
  type Patch,
  RowNotFoundError,
  selectById,
  selectRows,
  softDeleteRows,
  TABLES,
  updateRow,
} from "../table.ts";
import { MADE_HERE, rowId } from "./origin.ts";

type Draft<A, Parent extends string = never> = Omit<
  A,
  "id" | "updatedAt" | "deletedAt" | "position" | Parent
>;

export type RoutineSetDraft = Draft<RoutineSet, "routineExerciseId">;

export interface RoutineDraft extends Omit<Routine, "id" | "updatedAt" | "deletedAt"> {
  readonly exercises: ReadonlyArray<
    Draft<RoutineExercise, "routineId"> & { readonly sets: ReadonlyArray<RoutineSetDraft> }
  >;
}

export interface RoutineDetail {
  readonly routine: Routine;
  readonly exercises: ReadonlyArray<{
    readonly exercise: RoutineExercise;
    readonly sets: ReadonlyArray<RoutineSet>;
  }>;
}

const routinesIn = (column: "id" | "folder_id") => ({
  routines: `${column} = ?`,
  exercises: `routine_id IN (SELECT id FROM routine WHERE ${column} = ?)`,
  sets: `routine_exercise_id IN (SELECT id FROM routine_exercise WHERE routine_id IN (SELECT id FROM routine WHERE ${column} = ?))`,
});

/** Deletes the routines that `column` selects, with their exercises and sets, in one go. */
const removeRoutines = (column: "id" | "folder_id", id: string, at: EpochMillis) =>
  Effect.gen(function* () {
    const scope = routinesIn(column);
    yield* softDeleteRows(TABLES.routineSet, scope.sets, [id], at);
    yield* softDeleteRows(TABLES.routineExercise, scope.exercises, [id], at);
    return yield* softDeleteRows(TABLES.routine, scope.routines, [id], at);
  });

const makeRoutineRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const ids = yield* Ids;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql | Ids>) =>
    effect.pipe(Effect.provideService(Sql, sql), Effect.provideService(Ids, ids));
  const newId = rowId(MADE_HERE);

  const createRoutine = ({ exercises, ...fields }: RoutineDraft) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const updatedAt = yield* currentTime;
          const id = RoutineId.make(yield* newId);
          yield* insertRows(TABLES.routine, [{ ...fields, id, updatedAt, deletedAt: null }]);
          for (const [position, { sets, ...exercise }] of exercises.entries()) {
            const exerciseId = RoutineExerciseId.make(yield* newId);
            yield* insertRows(TABLES.routineExercise, [
              { ...exercise, id: exerciseId, routineId: id, position, updatedAt, deletedAt: null },
            ]);
            yield* insertRows(
              TABLES.routineSet,
              yield* Effect.forEach(sets.entries(), ([setPosition, set]) =>
                Effect.map(newId, (setId) => ({
                  ...set,
                  id: RoutineSetId.make(setId),
                  routineExerciseId: exerciseId,
                  position: setPosition,
                  updatedAt,
                  deletedAt: null,
                })),
              ),
            );
          }
          return id;
        }),
      ),
    );

  const getRoutine = (id: RoutineId) =>
    run(
      Effect.gen(function* () {
        const routine = yield* selectById(TABLES.routine, id);
        if (Option.isNone(routine)) return Option.none<RoutineDetail>();
        const scope = routinesIn("id");
        const exercises = yield* selectRows(
          TABLES.routineExercise,
          scope.exercises,
          [id],
          "position",
        );
        const sets = yield* selectRows(TABLES.routineSet, scope.sets, [id], "position");
        return Option.some<RoutineDetail>({
          routine: routine.value,
          exercises: exercises.map((exercise) => ({
            exercise,
            sets: sets.filter((set) => set.routineExerciseId === exercise.id),
          })),
        });
      }),
    );

  const removeRoutine = (id: RoutineId) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const removed = yield* removeRoutines("id", id, yield* currentTime);
          if (removed === 0) return yield* new RowNotFoundError({ table: "routine", id });
        }),
      ),
    );

  const createFolder = (folder: Omit<Folder, "id" | "updatedAt" | "deletedAt">) =>
    run(
      Effect.gen(function* () {
        const id = FolderId.make(yield* newId);
        yield* insertRows(TABLES.folder, [
          { ...folder, id, updatedAt: yield* currentTime, deletedAt: null },
        ]);
        return id;
      }),
    );

  /** Deletes the folder with every routine in it, as Hevy does. */
  const removeFolder = (id: FolderId) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const at = yield* currentTime;
          const removed = yield* softDeleteRows(TABLES.folder, "id = ?", [id], at);
          if (removed === 0) return yield* new RowNotFoundError({ table: "folder", id });
          yield* removeRoutines("folder_id", id, at);
        }),
      ),
    );

  return {
    createRoutine,
    getRoutine,
    removeRoutine,
    createFolder,
    removeFolder,
    listRoutines: run(selectRows(TABLES.routine, "1 = 1", [], "position, id")),
    updateRoutine: (id: RoutineId, patch: Patch<Routine>) =>
      run(updateRow(TABLES.routine, id, patch)),
    updateRoutineSet: (id: RoutineSetId, patch: Omit<Patch<RoutineSet>, "routineExerciseId">) =>
      run(updateRow(TABLES.routineSet, id, patch)),
    listFolders: run(selectRows(TABLES.folder, "1 = 1", [], "position, id")),
    updateFolder: (id: FolderId, patch: Patch<Folder>) => run(updateRow(TABLES.folder, id, patch)),
  };
});

/** The only writer of routine, routine_exercise, routine_set and folder. */
export class RoutineRepository extends Context.Service<
  RoutineRepository,
  Effect.Success<typeof makeRoutineRepository>
>()("svett/RoutineRepository") {
  static readonly layer = Layer.effect(RoutineRepository, makeRoutineRepository);
}
