import { Effect } from "effect";

import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { type ActivityDraft } from "./repositories/activities.ts";
import { type Origin } from "./repositories/origin.ts";
import { EpochMillis } from "./schema.ts";
import { Sql } from "./sql.ts";
import { SYNCED_TABLES } from "./sync.ts";
import { columnOf } from "./table.ts";
import { T0 } from "./test-database.ts";

/** A leg day with two exercises and four sets. */
export const legDay = (origin: Origin, title = "Legs"): ActivityDraft => ({
  kind: "strength",
  startedAt: EpochMillis.make(T0 - 3_600_000),
  durationS: DurationSeconds.make(3_300),
  title,
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: [],
  origin,
  exercises: [
    {
      exerciseId: libraryExerciseId("Barbell_Squat"),
      supersetGroup: null,
      notes: "",
      sets: [100, 100, 105].map((weightKg) => ({
        setType: "normal" as const,
        weightKg,
        reps: 5,
        durationS: null,
        distanceM: null,
        rpe: null,
      })),
    },
    {
      exerciseId: libraryExerciseId("Lying_Leg_Curls"),
      supersetGroup: null,
      notes: "",
      sets: [
        { setType: "normal", weightKg: 40, reps: 12, durationS: null, distanceM: null, rpe: null },
      ],
    },
  ],
  track: null,
});

/**
 * Every synced row a database holds, deleted ones included, in a fixed order. Two phones
 * have converged when theirs are equal.
 */
export const syncedRows = (runtime: {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, Sql>) => Promise<A>;
}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* Sql;
      const rows: Record<string, ReadonlyArray<unknown>> = {};
      for (const table of SYNCED_TABLES) {
        rows[table.name] = yield* sql.all(
          `SELECT ${table.keys.map(columnOf).join(", ")} FROM ${table.name} ORDER BY id`,
        );
      }
      return rows;
    }),
  );
