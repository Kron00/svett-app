import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "../duration.ts";
import { personalRecords } from "../records.ts";
import { EpochMillis, type ExerciseId } from "../schema.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { BENCH, PULLUPS, SQUAT } from "../test-sets.ts";
import { ActivityRepository, type SetDraft } from "./activities.ts";
import { MADE_HERE } from "./origin.ts";
import { ProgressRepository } from "./progress.ts";

const DAY = 86_400_000;

const set = (
  weightKg: number,
  reps: number,
  setType: SetDraft["setType"] = "normal",
): SetDraft => ({
  setType,
  weightKg,
  reps,
  durationS: null,
  distanceM: null,
  rpe: null,
});

const logWorkout = (day: number, exercises: ReadonlyArray<[ExerciseId, ReadonlyArray<SetDraft>]>) =>
  Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
    activities.create({
      kind: "strength",
      startedAt: EpochMillis.make(T0 + day * DAY),
      durationS: DurationSeconds.make(3600),
      title: "Workout",
      notes: "",
      energyKcal: null,
      audience: "only_you",
      hiddenFields: [],
      origin: MADE_HERE,
      track: null,
      exercises: exercises.map(([exerciseId, sets]) => ({
        exerciseId,
        supersetGroup: null,
        notes: "",
        sets,
      })),
    }),
  );

describe("ProgressRepository", () => {
  it("reads live sets in workout order, by exercise and by time", async () => {
    const { runtime } = openTestDatabase();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const progress = yield* ProgressRepository;
        // Logged out of order, so the read has to sort by start time.
        yield* logWorkout(7, [[BENCH, [set(85, 3)]]]);
        yield* logWorkout(0, [
          [SQUAT, [set(100, 5)]],
          [BENCH, [set(40, 10, "warm_up"), set(80, 5)]],
        ]);
        const deleted = yield* logWorkout(3, [[BENCH, [set(200, 1)]]]);
        yield* activities.remove(deleted);
        return {
          all: yield* progress.performedSets(),
          bench: yield* progress.performedSets({ exerciseId: BENCH }),
          firstWeek: yield* progress.performedSets({ from: T0, until: T0 + 7 * DAY }),
          exercises: yield* progress.performedExercises,
        };
      }),
    );
    const brief = (sets: typeof result.all) =>
      sets.map((s) => [s.exerciseId === BENCH ? "bench" : "squat", s.setType, s.weightKg, s.reps]);
    expect(brief(result.all)).toEqual([
      ["squat", "normal", 100, 5],
      ["bench", "warm_up", 40, 10],
      ["bench", "normal", 80, 5],
      ["bench", "normal", 85, 3],
    ]);
    expect(brief(result.bench)).toEqual(brief(result.all).slice(1));
    expect(brief(result.firstWeek)).toEqual(brief(result.all).slice(0, 3));
    expect(result.all[0]?.startedAt).toBe(T0);
    expect(
      result.exercises.map(({ exercise, workouts, lastPerformedAt }) => [
        exercise.name,
        workouts,
        lastPerformedAt,
      ]),
    ).toEqual([
      ["Barbell Bench Press - Medium Grip", 2, T0 + 7 * DAY],
      ["Barbell Squat", 1, T0],
    ]);
    // 80 × 5 sets the start at 1RM 93.33, heaviest 80 and volume 400. 85 × 3 beats the 1RM
    // with 93.5 and the heaviest with 85, not the volume. The deleted 200 kg single never counts.
    expect(
      personalRecords(result.bench).records.map((record) => [record.kind, record.value]),
    ).toEqual([
      ["best_one_rep_max", 93.5],
      ["heaviest_weight", 85],
    ]);
  });

  it("reads pull-ups as a bodyweight exercise, so their added weight gives no 1RM", async () => {
    const { runtime } = openTestDatabase();
    const sets = await runtime.runPromise(
      Effect.gen(function* () {
        yield* logWorkout(0, [[PULLUPS, [set(10, 12)]]]);
        yield* logWorkout(3, [[PULLUPS, [set(12, 6)]]]);
        return yield* (yield* ProgressRepository).performedSets();
      }),
    );
    expect(sets.map((s) => s.equipment)).toEqual(["none", "none"]);
    expect(personalRecords(sets).records.map((record) => [record.kind, record.value])).toEqual([
      ["heaviest_weight", 12],
    ]);
  });
});
