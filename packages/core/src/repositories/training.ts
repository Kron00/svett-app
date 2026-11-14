import { Context, Effect, Layer } from "effect";

import {
  type ActivityId,
  type ActivityKind,
  EpochMillis,
  type ExerciseId,
  type SetType,
} from "../schema.ts";
import { Sql, type SqlRow } from "../sql.ts";

/** A workout as a list shows it, with how much it held. */
export interface WorkoutTally {
  readonly id: ActivityId;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly startedAt: EpochMillis;
  readonly durationS: number;
  readonly exercises: number;
  /** Sets other than warm-ups. */
  readonly workingSets: number;
}

/** One logged set of an exercise, with the workout it belongs to. */
export interface LoggedSet {
  readonly activityId: ActivityId;
  readonly title: string;
  readonly startedAt: EpochMillis;
  readonly position: number;
  readonly setType: SetType;
  readonly weightKg: number | null;
  readonly reps: number | null;
  readonly durationS: number | null;
  readonly distanceM: number | null;
  readonly rpe: number | null;
}

const number = (row: SqlRow, column: string) => Number(row[column]);
const nullableNumber = (row: SqlRow, column: string) =>
  row[column] === null || row[column] === undefined ? null : Number(row[column]);

const makeTrainingReads = Effect.gen(function* () {
  const sql = yield* Sql;

  /** Workouts that started in [from, to), newest first. */
  const workoutsBetween = (from: number, to: number, limit: number) =>
    Effect.map(
      sql.all(
        `SELECT a.id, a.kind, a.title, a.started_at, a.duration_s,
           (SELECT count(*) FROM activity_exercise e WHERE e.activity_id = a.id AND e.deleted_at IS NULL) AS exercises,
           (SELECT count(*) FROM activity_set s JOIN activity_exercise e ON s.activity_exercise_id = e.id
              WHERE e.activity_id = a.id AND e.deleted_at IS NULL AND s.deleted_at IS NULL AND s.set_type <> 'warm_up') AS working_sets
         FROM activity a
         WHERE a.deleted_at IS NULL AND a.started_at >= ? AND a.started_at < ?
         ORDER BY a.started_at DESC, a.id DESC LIMIT ?`,
        [from, to, limit],
      ),
      (rows) =>
        rows.map((row): WorkoutTally => ({
          id: String(row["id"]) as ActivityId,
          kind: String(row["kind"]) as ActivityKind,
          title: String(row["title"]),
          startedAt: EpochMillis.make(number(row, "started_at")),
          durationS: number(row, "duration_s"),
          exercises: number(row, "exercises"),
          workingSets: number(row, "working_sets"),
        })),
    );

  /** How many workouts started in [from, to). */
  const countWorkoutsBetween = (from: number, to: number) =>
    Effect.map(
      sql.all(
        "SELECT count(*) AS n FROM activity WHERE deleted_at IS NULL AND started_at >= ? AND started_at < ?",
        [from, to],
      ),
      (rows) => Number(rows[0]?.["n"] ?? 0),
    );

  /** Every live set of `exerciseId` in workouts that started in [from, to), oldest first. */
  const setsOfExercise = (exerciseId: ExerciseId, from: number, to: number) =>
    Effect.map(
      sql.all(
        `SELECT a.id AS activity_id, a.title, a.started_at, s.position, s.set_type, s.weight_kg,
           s.reps, s.duration_s, s.distance_m, s.rpe
         FROM activity_set s
         JOIN activity_exercise e ON s.activity_exercise_id = e.id
         JOIN activity a ON e.activity_id = a.id
         WHERE s.deleted_at IS NULL AND e.deleted_at IS NULL AND a.deleted_at IS NULL
           AND e.exercise_id = ? AND a.started_at >= ? AND a.started_at < ?
         ORDER BY a.started_at, a.id, e.position, s.position`,
        [exerciseId, from, to],
      ),
      (rows) =>
        rows.map((row): LoggedSet => ({
          activityId: String(row["activity_id"]) as ActivityId,
          title: String(row["title"]),
          startedAt: EpochMillis.make(number(row, "started_at")),
          position: number(row, "position"),
          setType: String(row["set_type"]) as SetType,
          weightKg: nullableNumber(row, "weight_kg"),
          reps: nullableNumber(row, "reps"),
          durationS: nullableNumber(row, "duration_s"),
          distanceM: nullableNumber(row, "distance_m"),
          rpe: nullableNumber(row, "rpe"),
        })),
    );

  /** How many workouts each exercise appears in, for the exercises that appear at all. */
  const timesLogged = Effect.map(
    sql.all(
      `SELECT e.exercise_id, count(DISTINCT e.activity_id) AS n
       FROM activity_exercise e JOIN activity a ON e.activity_id = a.id
       WHERE e.deleted_at IS NULL AND a.deleted_at IS NULL
       GROUP BY e.exercise_id`,
    ),
    (rows) =>
      new Map<ExerciseId, number>(
        rows.map((row) => [String(row["exercise_id"]) as ExerciseId, number(row, "n")]),
      ),
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
