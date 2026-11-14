import { Context, Effect, Layer, Schema } from "effect";

import { DurationSeconds } from "../duration.ts";
import { ActivityId, ActivityKind, EpochMillis, ExerciseId, SetType } from "../schema.ts";
import { Sql } from "../sql.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A workout as a list shows it, with how much it held. */
export const WorkoutTally = Schema.Struct({
  id: ActivityId,
  kind: ActivityKind,
  title: Schema.String,
  startedAt: EpochMillis,
  durationS: DurationSeconds,
  exercises: Count,
  /** Sets other than warm-ups. */
  workingSets: Count,
});
export type WorkoutTally = typeof WorkoutTally.Type;

/** One logged set of an exercise, with the workout it belongs to. */
export const LoggedSet = Schema.Struct({
  activityId: ActivityId,
  title: Schema.String,
  startedAt: EpochMillis,
  position: Count,
  setType: SetType,
  weightKg: Schema.NullOr(Schema.Finite),
  reps: Schema.NullOr(Schema.Int),
  durationS: Schema.NullOr(Schema.Finite),
  distanceM: Schema.NullOr(Schema.Finite),
  rpe: Schema.NullOr(Schema.Finite),
});
export type LoggedSet = typeof LoggedSet.Type;

const ExerciseLogged = Schema.Struct({ exerciseId: ExerciseId, workouts: Count });

const decodeTallies = Schema.decodeUnknownSync(Schema.Array(WorkoutTally));
const decodeSets = Schema.decodeUnknownSync(Schema.Array(LoggedSet));
const decodeLogged = Schema.decodeUnknownSync(Schema.Array(ExerciseLogged));
const decodeCount = Schema.decodeUnknownSync(Schema.Tuple([Schema.Struct({ n: Count })]));

const makeTrainingReads = Effect.gen(function* () {
  const sql = yield* Sql;

  /** Workouts that started in [from, to), newest first. */
  const workoutsBetween = (from: number, to: number, limit: number) =>
    Effect.map(
      sql.all(
        `SELECT a.id, a.kind, a.title, a.started_at AS startedAt, a.duration_s AS durationS,
           (SELECT count(*) FROM activity_exercise e WHERE e.activity_id = a.id AND e.deleted_at IS NULL) AS exercises,
           (SELECT count(*) FROM activity_set s JOIN activity_exercise e ON s.activity_exercise_id = e.id
              WHERE e.activity_id = a.id AND e.deleted_at IS NULL AND s.deleted_at IS NULL AND s.set_type <> 'warm_up') AS workingSets
         FROM activity a
         WHERE a.deleted_at IS NULL AND a.started_at >= ? AND a.started_at < ?
         ORDER BY a.started_at DESC, a.id DESC LIMIT ?`,
        [from, to, limit],
      ),
      decodeTallies,
    );

  /** How many workouts started in [from, to). */
  const countWorkoutsBetween = (from: number, to: number) =>
    Effect.map(
      sql.all(
        "SELECT count(*) AS n FROM activity WHERE deleted_at IS NULL AND started_at >= ? AND started_at < ?",
        [from, to],
      ),
      (rows) => decodeCount(rows)[0].n,
    );

  /** Every live set of `exerciseId` in workouts that started in [from, to), oldest first. */
  const setsOfExercise = (exerciseId: ExerciseId, from: number, to: number) =>
    Effect.map(
      sql.all(
        `SELECT a.id AS activityId, a.title, a.started_at AS startedAt, s.position,
           s.set_type AS setType, s.weight_kg AS weightKg, s.reps, s.duration_s AS durationS,
           s.distance_m AS distanceM, s.rpe
         FROM activity_set s
         JOIN activity_exercise e ON s.activity_exercise_id = e.id
         JOIN activity a ON e.activity_id = a.id
         WHERE s.deleted_at IS NULL AND e.deleted_at IS NULL AND a.deleted_at IS NULL
           AND e.exercise_id = ? AND a.started_at >= ? AND a.started_at < ?
         ORDER BY a.started_at, a.id, e.position, s.position`,
        [exerciseId, from, to],
      ),
      decodeSets,
    );

  /** How many workouts each exercise appears in, for the exercises that appear at all. */
  const timesLogged = Effect.map(
    sql.all(
      `SELECT e.exercise_id AS exerciseId, count(DISTINCT e.activity_id) AS workouts
       FROM activity_exercise e JOIN activity a ON e.activity_id = a.id
       WHERE e.deleted_at IS NULL AND a.deleted_at IS NULL
       GROUP BY e.exercise_id`,
    ),
    (rows) =>
      new Map<ExerciseId, number>(decodeLogged(rows).map((row) => [row.exerciseId, row.workouts])),
  );

  return { workoutsBetween, countWorkoutsBetween, setsOfExercise, timesLogged };
});

/**
 * Reads across the training tables that no single table's repository answers, such as a
 * workout list with its set counts or every set of one exercise. It writes nothing.
 */
export class TrainingReads extends Context.Service<
  TrainingReads,
  Effect.Success<typeof makeTrainingReads>
>()("svett/TrainingReads") {
  static readonly layer = Layer.effect(TrainingReads, makeTrainingReads);
}
