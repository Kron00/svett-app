import {
  addWeeks,
  type ExerciseId,
  ExerciseRepository,
  type MeasurementKind,
  MeasurementRepository,
  MADE_HERE,
  type ExerciseMuscles,
  EpochMillis,
  personalRecords,
  ProgressRepository,
  startOfWeek,
} from "@svett/core";
import { Clock, Effect } from "effect";

export const CHART_WEEKS = 12;

/** The Progress tab: the newest records across every exercise, with each exercise's name. */
export const recentRecords = (count: number) =>
  Effect.gen(function* () {
    const progress = yield* ProgressRepository;
    const [sets, exercises] = yield* Effect.all([
      progress.performedSets(),
      progress.performedExercises,
    ]);
    const names = new Map(exercises.map(({ exercise }) => [exercise.id, exercise.name]));
    return personalRecords(sets)
      .records.toReversed()
      .slice(0, count)
      .map((record) => ({ record, exerciseName: names.get(record.exerciseId) ?? "Exercise" }));
  });

export const performedExercises = Effect.flatMap(
  Effect.service(ProgressRepository),
  (progress) => progress.performedExercises,
);

/** One exercise's row and every set logged for it, with the time now for the chart range. */
export const exerciseHistory = (exerciseId: ExerciseId) =>
  Effect.gen(function* () {
    const exercises = yield* ExerciseRepository;
    const progress = yield* ProgressRepository;
    return {
      exercise: yield* exercises.get(exerciseId),
      sets: yield* progress.performedSets({ exerciseId }),
      now: yield* Clock.currentTimeMillis,
    };
  });

/**
 * The sets for a week and the weeks before it that the chart shows, and the
 * muscles of every exercise in them. Without a week it is the current one.
 */
export const muscleWeeks = (week: EpochMillis | null) =>
  Effect.gen(function* () {
    const progress = yield* ProgressRepository;
    const now = yield* Clock.currentTimeMillis;
    const thisWeek = startOfWeek(now);
    const weekStart = week ?? thisWeek;
    const [sets, exercises] = yield* Effect.all([
      progress.performedSets({
        from: addWeeks(weekStart, 1 - CHART_WEEKS),
        until: addWeeks(weekStart, 1),
      }),
      progress.performedExercises,
    ]);
    const muscles = new Map<string, ExerciseMuscles>(
      exercises.map(({ exercise }) => [exercise.id, exercise]),
    );
    return { thisWeek, weekStart, sets, muscles };
  });

export const measurements = Effect.gen(function* () {
  const repository = yield* MeasurementRepository;
  return { rows: yield* repository.list(), now: yield* Clock.currentTimeMillis };
});

export const addMeasurement = (kind: MeasurementKind, value: number) =>
  Effect.gen(function* () {
    const repository = yield* MeasurementRepository;
    const measuredAt = EpochMillis.make(yield* Clock.currentTimeMillis);
    return yield* repository.create({ kind, measuredAt, value, origin: MADE_HERE });
  });
