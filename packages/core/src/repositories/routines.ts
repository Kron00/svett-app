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
import { copyTitle, endPosition } from "../routine-plan.ts";
import { Sql, type SqlError } from "../sql.ts";
import {
  currentTime,
  insertRows,
  type Patch,
  RowNotFoundError,
  selectById,
  selectRows,
  selectRowsWithDeleted,
  softDeleteRows,
  type Table,
  TABLES,
  updateRow,
} from "../table.ts";

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

/** Rows of routines and folders, deleted ones too, by table. */
export interface AppliedRows {
  readonly folder: ReadonlyArray<Folder>;
  readonly routine: ReadonlyArray<Routine>;
  readonly routineExercise: ReadonlyArray<RoutineExercise>;
  readonly routineSet: ReadonlyArray<RoutineSet>;
}

const inList = (column: string) => `${column} IN (SELECT value FROM json_each(?))`;

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

const routinesInFolder = (folderId: FolderId | null) =>
  folderId === null
    ? selectRows(TABLES.routine, "folder_id IS NULL", [], "position, id")
    : selectRows(TABLES.routine, "folder_id = ?", [folderId], "position, id");

const makeRoutineRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const ids = yield* Ids;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql | Ids>) =>
    effect.pipe(Effect.provideService(Sql, sql), Effect.provideService(Ids, ids));
  const newId = ids.random;

  const insertExercises = (
    routineId: RoutineId,
    exercises: RoutineDraft["exercises"],
    updatedAt: EpochMillis,
  ) =>
    Effect.gen(function* () {
      for (const [position, { sets, ...exercise }] of exercises.entries()) {
        const exerciseId = RoutineExerciseId.make(yield* newId);
        yield* insertRows(TABLES.routineExercise, [
          { ...exercise, id: exerciseId, routineId, position, updatedAt, deletedAt: null },
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
    });

  const createRoutine = ({ exercises, ...fields }: RoutineDraft) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const updatedAt = yield* currentTime;
          const id = RoutineId.make(yield* newId);
          yield* insertRows(TABLES.routine, [{ ...fields, id, updatedAt, deletedAt: null }]);
          yield* insertExercises(id, exercises, updatedAt);
          return id;
        }),
      ),
    );

  /** Replaces a routine's fields, exercises and sets with the draft's, as the editor saves it. */
  const saveRoutine = (id: RoutineId, { exercises, ...fields }: RoutineDraft) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          yield* updateRow(TABLES.routine, id, fields);
          const at = yield* currentTime;
          const scope = routinesIn("id");
          yield* softDeleteRows(TABLES.routineSet, scope.sets, [id], at);
          yield* softDeleteRows(TABLES.routineExercise, scope.exercises, [id], at);
          yield* insertExercises(id, exercises, at);
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

  /** Copies a routine with its exercises and targets to the end of the same folder. */
  const duplicateRoutine = (id: RoutineId) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const detail = yield* getRoutine(id);
          if (Option.isNone(detail)) return yield* new RowNotFoundError({ table: "routine", id });
          const { routine, exercises } = detail.value;
          const siblings = yield* routinesInFolder(routine.folderId);
          const titles = (yield* selectRows(TABLES.routine)).map((row) => row.title);
          return yield* createRoutine({
            folderId: routine.folderId,
            title: copyTitle(routine.title, titles),
            notes: routine.notes,
            position: endPosition(siblings),
            exercises: exercises.map(({ exercise, sets }) => ({
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
          });
        }),
      ),
    );

  /**
   * Puts a routine at the end of a folder, or of the routines in no folder. Choosing the folder
   * it is already in leaves it where it is.
   */
  const moveRoutine = (id: RoutineId, folderId: FolderId | null) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const routine = yield* selectById(TABLES.routine, id);
          if (Option.isNone(routine)) return yield* new RowNotFoundError({ table: "routine", id });
          if (routine.value.folderId === folderId) return;
          const siblings = (yield* routinesInFolder(folderId)).filter((row) => row.id !== id);
          yield* updateRow(TABLES.routine, id, { folderId, position: endPosition(siblings) });
        }),
      ),
    );

  /** Numbers the rows in the order given, writing only the rows whose place changed. */
  const order =
    <Row extends Folder | Routine>(
      target: Table<Row>,
      rows: Effect.Effect<ReadonlyArray<Row>, SqlError, Sql>,
    ) =>
    (ordered: ReadonlyArray<Row["id"]>) =>
      run(
        sql.transaction(
          Effect.gen(function* () {
            const position = new Map((yield* rows).map((row) => [row.id, row.position]));
            for (const [index, id] of ordered.entries()) {
              const current = position.get(id);
              if (current === undefined) {
                return yield* new RowNotFoundError({ table: target.name, id });
              }
              if (current !== index) {
                yield* updateRow(target, id, { position: index } as Patch<Row>);
              }
            }
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

  /**
   * The folder and routines given, every routine in that folder, and every exercise and set
   * below them, deleted ones too. A change to any of them, a delete, or a routine moved in or
   * out of the folder changes what this reads.
   */
  const appliedRows = (folderId: FolderId | null, routineIds: ReadonlyArray<RoutineId>) =>
    run(
      Effect.gen(function* () {
        const ids = JSON.stringify(routineIds);
        const routine = yield* folderId === null
          ? selectRowsWithDeleted(TABLES.routine, inList("id"), [ids])
          : selectRowsWithDeleted(TABLES.routine, `${inList("id")} OR folder_id = ?`, [
              ids,
              folderId,
            ]);
        const routineExercise = yield* selectRowsWithDeleted(
          TABLES.routineExercise,
          inList("routine_id"),
          [JSON.stringify(routine.map((row) => row.id))],
        );
        return {
          folder:
            folderId === null
              ? []
              : yield* selectRowsWithDeleted(TABLES.folder, "id = ?", [folderId]),
          routine,
          routineExercise,
          routineSet: yield* selectRowsWithDeleted(TABLES.routineSet, inList("routine_exercise_id"), [
            JSON.stringify(routineExercise.map((row) => row.id)),
          ]),
        } satisfies AppliedRows;
      }),
    );

  return {
    appliedRows,
    createRoutine,
    saveRoutine,
    duplicateRoutine,
    moveRoutine,
    /** Sets the order of routines, given as their IDs from first to last. */
    orderRoutines: order(TABLES.routine, selectRows(TABLES.routine)),
    /** Sets the order of folders, given as their IDs from first to last. */
    orderFolders: order(TABLES.folder, selectRows(TABLES.folder)),
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
    /** Every routine's exercises in order, for the routine list's summaries. */
    listRoutineExercises: run(
      selectRows(
        TABLES.routineExercise,
        "routine_id IN (SELECT id FROM routine WHERE deleted_at IS NULL)",
        [],
        "routine_id, position",
      ),
    ),
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
