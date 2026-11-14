import { Context, Effect, Layer } from "effect";

import {
  exerciseLibrary,
  LIBRARY_UPDATED_AT,
  type LibraryExercise,
  libraryIds,
} from "../exercise-library.ts";
import { canonicalJson, Ids } from "../ids.ts";
import { type Exercise, ExerciseId } from "../schema.ts";
import { Sql } from "../sql.ts";
import {
  countRows,
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
import { type Origin, provenance, rowId } from "./origin.ts";

export type ExerciseDraft = Pick<
  Exercise,
  "name" | "category" | "equipment" | "primaryMuscles" | "secondaryMuscles"
> & { readonly origin: Origin };

/** A library exercise as every install stores it until someone edits it. */
const seedRow = ({ sourceId, ...exercise }: LibraryExercise): Exercise => ({
  ...exercise,
  source: "library",
  sourceId,
  fingerprint: null,
  importBatchId: null,
  updatedAt: LIBRARY_UPDATED_AT,
  deletedAt: null,
});

const makeExerciseRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const ids = yield* Ids;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql | Ids>) =>
    effect.pipe(Effect.provideService(Sql, sql), Effect.provideService(Ids, ids));

  /**
   * Adds the library exercises this database does not have yet, and gives library rows that
   * still match the bundle the shared library time. Databases from before that time stamped
   * each install's rows with its own time. Safe to run on every open.
   */
  const seedLibrary = () =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const bundled = libraryIds();
          const [stored] = yield* sql.all(
            "SELECT count(*) AS present FROM exercise WHERE source = 'library' AND source_id IN (SELECT value FROM json_each(?))",
            [JSON.stringify(bundled)],
          );
          const stamped = yield* selectRows(
            TABLES.exercise,
            "source = 'library' AND updated_at != ?",
            [LIBRARY_UPDATED_AT],
          );
          if (Number(stored?.["present"]) === bundled.length && stamped.length === 0) return 0;
          const library = new Map(
            exerciseLibrary().map((exercise) => [exercise.id, seedRow(exercise)]),
          );
          const unchanged = stamped
            .filter((row) => {
              const seeded = library.get(row.id);
              return (
                seeded !== undefined &&
                canonicalJson({ ...row, updatedAt: LIBRARY_UPDATED_AT }) === canonicalJson(seeded)
              );
            })
            .map((row) => row.id);
          if (unchanged.length > 0) {
            yield* sql.run(
              "UPDATE exercise SET updated_at = ? WHERE id IN (SELECT value FROM json_each(?))",
              [LIBRARY_UPDATED_AT, JSON.stringify(unchanged)],
            );
          }
          const present = new Set(
            (yield* sql.all("SELECT id FROM exercise WHERE source = 'library'")).map((row) =>
              String(row["id"]),
            ),
          );
          const missing = [...library.values()].filter((exercise) => !present.has(exercise.id));
          yield* insertRows(TABLES.exercise, missing);
          return missing.length;
        }),
      ),
    );

  const create = ({ origin, ...draft }: ExerciseDraft) =>
    run(
      Effect.gen(function* () {
        const id = ExerciseId.make(yield* rowId(TABLES.exercise, origin));
        yield* insertRows(TABLES.exercise, [
          { ...draft, ...provenance(origin), id, updatedAt: yield* currentTime, deletedAt: null },
        ]);
        return id;
      }),
    );

  const remove = (id: ExerciseId) =>
    run(
      Effect.gen(function* () {
        const removed = yield* softDeleteRows(TABLES.exercise, "id = ?", [id], yield* currentTime);
        if (removed === 0) return yield* new RowNotFoundError({ table: "exercise", id });
      }),
    );

  return {
    seedLibrary,
    create,
    remove,
    get: (id: ExerciseId) => run(selectById(TABLES.exercise, id)),
    list: run(selectRows(TABLES.exercise, "1 = 1", [], "name COLLATE NOCASE, id")),
    update: (
      id: ExerciseId,
      patch: Omit<Patch<Exercise>, "source" | "sourceId" | "fingerprint" | "importBatchId">,
    ) => run(updateRow(TABLES.exercise, id, patch)),
    count: run(countRows(TABLES.exercise)),
  };
});

/** The only writer of the exercise table: the bundled library and custom exercises. */
export class ExerciseRepository extends Context.Service<
  ExerciseRepository,
  Effect.Success<typeof makeExerciseRepository>
>()("svett/ExerciseRepository") {
  static readonly layer = Layer.effect(ExerciseRepository, makeExerciseRepository);
}
