import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "../duration.ts";
import { libraryExerciseId } from "../exercise-library.ts";
import { EpochMillis, type SetType } from "../schema.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { ActivityRepository } from "./activities.ts";
import { MADE_HERE } from "./origin.ts";
import { TrainingReads } from "./training.ts";

const SQUAT = libraryExerciseId("Barbell_Squat");
const BENCH = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");
const DAY = 86_400_000;

const workout = (day: number, title: string, sets: ReadonlyArray<[SetType, number, number]>) =>
  Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
    activities.create({
      kind: "strength",
      startedAt: EpochMillis.make(T0 + day * DAY),
      durationS: DurationSeconds.make(3600),
      title,
      notes: "",
      energyKcal: null,
      audience: "only_you",
      hiddenFields: [],
      origin: MADE_HERE,
      track: null,
      exercises: [
        {
          exerciseId: SQUAT,
          supersetGroup: null,
          notes: "",
          sets: sets.map(([setType, weightKg, reps]) => ({
            setType,
            weightKg,
            reps,
            durationS: null,
            distanceM: null,
            rpe: null,
          })),
        },
        {
          exerciseId: BENCH,
          supersetGroup: null,
          notes: "",
          sets: [
            {
              setType: "normal",
              weightKg: 80,
              reps: 5,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
          ],
        },
      ],
    }),
  );

describe("TrainingReads", () => {
  it("lists the workouts in a range with their counts, and leaves deleted ones out", async () => {
    const { runtime } = openTestDatabase();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        yield* workout(0, "Legs A", [
          ["warm_up", 60, 5],
          ["normal", 100, 5],
          ["normal", 100, 5],
        ]);
        const deleted = yield* workout(1, "Legs B", [["normal", 140, 5]]);
        yield* workout(2, "Legs C", [["normal", 105, 3]]);
        yield* workout(10, "Later", [["normal", 110, 3]]);
        yield* (yield* ActivityRepository).remove(deleted);
        const reads = yield* TrainingReads;
        return {
          workouts: yield* reads.workoutsBetween(T0, T0 + 3 * DAY, 10),
          count: yield* reads.countWorkoutsBetween(T0, T0 + 3 * DAY),
          sets: yield* reads.setsOfExercise(SQUAT, T0, T0 + 3 * DAY),
          logged: yield* reads.timesLogged,
        };
      }),
    );
    expect(
      result.workouts.map(({ title, exercises, workingSets }) => [title, exercises, workingSets]),
    ).toEqual([
      ["Legs C", 2, 2],
      ["Legs A", 2, 3],
    ]);
    expect(result.count).toBe(2);
    expect(result.sets.map((set) => [set.title, set.setType, set.weightKg])).toEqual([
      ["Legs A", "warm_up", 60],
      ["Legs A", "normal", 100],
      ["Legs A", "normal", 100],
      ["Legs C", "normal", 105],
    ]);
    expect(result.logged.get(SQUAT)).toBe(3);
    expect(result.logged.get(BENCH)).toBe(3);
  });

  it("refuses a set whose type the schema does not know when it reads it", async () => {
    const { database, runtime } = openTestDatabase();
    await runtime.runPromise(workout(0, "Legs A", [["normal", 100, 5]]));
    database.prepare("UPDATE activity_set SET set_type = 'heavy'").run();
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(Effect.service(TrainingReads), (reads) =>
        reads.setsOfExercise(SQUAT, T0, T0 + DAY),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain(`at [0]["setType"]`);
  });
});
