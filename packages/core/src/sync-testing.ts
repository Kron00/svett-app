import { Effect, Option } from "effect";

import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import {
  type ActivityDraft,
  ActivityRepository,
  type NewWorkout,
  type PlannedSet,
} from "./repositories/activities.ts";
import { type Origin } from "./repositories/origin.ts";
import { type ActivityId, EpochMillis } from "./schema.ts";
import { Sql } from "./sql.ts";
import { SYNCED_TABLES, type SyncedTable } from "./sync.ts";
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

const planned = (weightKg: number): PlannedSet => ({
  setType: "normal",
  weightKg,
  reps: 8,
  durationS: null,
  distanceM: null,
  targetRepsMin: null,
  targetRepsMax: null,
});

/**
 * Starts a push day with two exercises and four sets, renames it, and marks every set done
 * but the last, so finishing it leaves that set out. Gives the workout's ID.
 */
export const startPushDay = (title = "Push") =>
  Effect.gen(function* () {
    const activities = yield* ActivityRepository;
    const workout: NewWorkout = {
      title,
      routineId: null,
      exercises: ["Barbell_Bench_Press_-_Medium_Grip", "Side_Lateral_Raise"].map((name) => ({
        exerciseId: libraryExerciseId(name),
        supersetGroup: null,
        notes: "",
        sets: [planned(60), planned(62.5)],
      })),
    };
    const id = yield* activities.startWorkout(workout);
    yield* activities.updateWorkout(id, { title: `${title} day` });
    const detail = Option.getOrThrow(yield* activities.get(id));
    const sets = detail.exercises.flatMap((exercise) => exercise.sets);
    for (const set of sets.slice(0, -1)) {
      yield* activities.updateWorkoutSet(set.id, { done: true });
    }
    return id;
  });

/**
 * Every row of the workout `id`, deleted ones too, each as sync sends it: its table and the
 * row in its stored form.
 */
export const workoutRows = (
  runtime: { readonly runPromise: <A, E>(effect: Effect.Effect<A, E, Sql>) => Promise<A> },
  id: ActivityId,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* Sql;
      const where: ReadonlyArray<readonly [SyncedTable, string]> = [
        ["activity", "id = ?"],
        ["activity_exercise", "activity_id = ?"],
        [
          "activity_set",
          "activity_exercise_id IN (SELECT id FROM activity_exercise WHERE activity_id = ?)",
        ],
        ["activity_track", "activity_id = ?"],
        [
          "activity_sample",
          "activity_track_id IN (SELECT id FROM activity_track WHERE activity_id = ?)",
        ],
      ];
      const rows: Array<{ readonly table: SyncedTable; readonly row: Record<string, unknown> }> =
        [];
      for (const [name, condition] of where) {
        const table = SYNCED_TABLES.find((candidate) => candidate.name === name);
        if (table === undefined) throw new Error(`${name} does not sync`);
        for (const found of yield* sql.all(
          `SELECT ${table.keys.map(columnOf).join(", ")} FROM ${name} WHERE ${condition} ORDER BY id`,
          [id],
        )) {
          rows.push({
            table: name,
            row: Object.fromEntries(table.keys.map((key) => [key, found[columnOf(key)] ?? null])),
          });
        }
      }
      return rows;
    }),
  );
