import { Context, Effect, Layer } from "effect";

import { exerciseLibrary, libraryIds } from "../exercise-library.ts";
import { Ids } from "../ids.ts";
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

const makeExerciseRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const ids = yield* Ids;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql | Ids>) =>
    effect.pipe(Effect.provideService(Sql, sql), Effect.provideService(Ids, ids));

  /** Adds the library exercises this database does not have yet. Safe to run on every open. */
  const seedLibrary = () =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const bundled = libraryIds();
          const [stored] = yield* sql.all(
            "SELECT count(*) AS present FROM exercise WHERE source = 'library' AND source_id IN (SELECT value FROM json_each(?))",
            [JSON.stringify(bundled)],
          );
          if (Number(stored?.["present"]) === bundled.length) return 0;
          const library = exerciseLibrary();
          const present = new Set(
            (yield* sql.all("SELECT id FROM exercise WHERE source = 'library'")).map((row) =>
              String(row["id"]),
            ),
          );
          const missing = library.filter((exercise) => !present.has(exercise.id));
          const updatedAt = yield* currentTime;
          yield* insertRows(
            TABLES.exercise,
            missing.map(({ sourceId, ...exercise }) => ({
              ...exercise,
              source: "library" as const,
              sourceId,
              fingerprint: null,
              importBatchId: null,
              updatedAt,
              deletedAt: null,
            })),
          );
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
