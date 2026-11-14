import { Context, Effect, Layer, Schema } from "effect";

import { PerformedSet } from "../performed-set.ts";
import { EpochMillis, type Exercise, type ExerciseId } from "../schema.ts";
import { Sql } from "../sql.ts";
import { selectRows, TABLES } from "../table.ts";

export interface PerformedSetFilter {
  readonly exerciseId?: ExerciseId;
  /** Workouts that started at or after this time. */
  readonly from?: number;
  /** Workouts that started before this time. */
  readonly until?: number;
}

/** An exercise with logged sets, how many workouts it was in, and when it was last done. */
export interface PerformedExercise {
  readonly exercise: Exercise;
  readonly workouts: number;
  readonly lastPerformedAt: EpochMillis;
}

const ExerciseUse = Schema.Struct({
  exerciseId: Schema.String,
  workouts: Schema.Int,
  lastPerformedAt: EpochMillis,
});

const LIVE_SETS = `
  FROM activity_set s
  JOIN activity_exercise e ON e.id = s.activity_exercise_id
  JOIN activity a ON a.id = e.activity_id
  WHERE s.deleted_at IS NULL AND e.deleted_at IS NULL AND a.deleted_at IS NULL`;

const makeProgressRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql>) => Effect.provideService(effect, Sql, sql);

  /** Logged sets in workout order: by start time, then exercise and set position. */
  const performedSets = (filter: PerformedSetFilter = {}) =>
    Effect.map(
      sql.all(
        `SELECT s.id AS setId, a.id AS activityId, e.exercise_id AS exerciseId,
           a.started_at AS startedAt, s.set_type AS setType, s.weight_kg AS weightKg,
           s.reps AS reps, s.duration_s AS durationS, s.distance_m AS distanceM
         ${LIVE_SETS}
           AND (? IS NULL OR e.exercise_id = ?)
           AND a.started_at >= ? AND a.started_at < ?
         ORDER BY a.started_at, a.id, e.position, s.position`,
        [
          filter.exerciseId ?? null,
          filter.exerciseId ?? null,
          filter.from ?? 0,
          filter.until ?? Number.MAX_SAFE_INTEGER,
        ],
      ),
      Schema.decodeUnknownSync(Schema.Array(PerformedSet)),
    );

  /** Every exercise with at least one logged set, most recently done first. */
  const performedExercises = Effect.gen(function* () {
    const uses = Schema.decodeUnknownSync(Schema.Array(ExerciseUse))(
      yield* sql.all(
        `SELECT e.exercise_id AS exerciseId, count(DISTINCT a.id) AS workouts,
           max(a.started_at) AS lastPerformedAt
         ${LIVE_SETS}
         GROUP BY e.exercise_id
         ORDER BY lastPerformedAt DESC, e.exercise_id`,
      ),
    );
    const exercises = yield* run(
      selectRows(TABLES.exercise, "id IN (SELECT value FROM json_each(?))", [
        JSON.stringify(uses.map((use) => use.exerciseId)),
      ]),
    );
    const byId = new Map(exercises.map((exercise) => [exercise.id as string, exercise]));
    return uses.flatMap((use): ReadonlyArray<PerformedExercise> => {
      const exercise = byId.get(use.exerciseId);
      return exercise === undefined
        ? []
        : [{ exercise, workouts: use.workouts, lastPerformedAt: use.lastPerformedAt }];
    });
  });

  return { performedSets, performedExercises };
});

/** Reads logged sets for records, charts and muscle volume. It writes nothing. */
export class ProgressRepository extends Context.Service<
  ProgressRepository,
  Effect.Success<typeof makeProgressRepository>
>()("svett/ProgressRepository") {
  static readonly layer = Layer.effect(ProgressRepository, makeProgressRepository);
}
