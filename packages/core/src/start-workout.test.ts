import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { libraryExerciseId } from "./exercise-library.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { EMPTY_TARGET } from "./routine-plan.ts";
import { RoutineId } from "./schema.ts";
import { startWorkoutFromRoutine } from "./start-workout.ts";
import { openTestDatabase, T0 } from "./test-database.ts";

const bench = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");
const raise = libraryExerciseId("Side_Lateral_Raise");

describe("startWorkoutFromRoutine", () => {
  it("starts a workout with the routine's exercises and targets filled in", async () => {
    const database = openTestDatabase();
    const workout = await database.runtime.runPromise(
      Effect.gen(function* () {
        const routines = yield* RoutineRepository;
        const activities = yield* ActivityRepository;
        const routineId = yield* routines.createRoutine({
          folderId: null,
          title: "Push",
          notes: "",
          position: 0,
          exercises: [
            {
              exerciseId: bench,
              supersetGroup: null,
              restS: null,
              notes: "Pause on the chest",
              sets: [
                { ...EMPTY_TARGET, setType: "warm_up", weightKg: 40, repsMin: 10, repsMax: 10 },
                { ...EMPTY_TARGET, weightKg: 80, repsMin: 5, repsMax: 8 },
                { ...EMPTY_TARGET, weightKg: 80, repsMin: 5, repsMax: 8 },
              ],
            },
            {
              exerciseId: raise,
              supersetGroup: null,
              restS: null,
              notes: "",
              sets: [{ ...EMPTY_TARGET, repsMin: 12, repsMax: 15 }],
            },
          ],
        });
        const id = yield* startWorkoutFromRoutine(routineId);
        const current = Option.getOrThrow(yield* activities.inProgress);
        return { routineId, id, current };
      }),
    );

    expect(workout.current.activity).toMatchObject({
      id: workout.id,
      status: "in_progress",
      routineId: workout.routineId,
      title: "Push",
      startedAt: T0,
    });
    expect(
      workout.current.exercises.map(({ exercise, sets }) => [
        exercise.exerciseId,
        exercise.notes,
        sets.map((set) => [
          set.setType,
          set.weightKg,
          set.reps,
          set.targetRepsMin,
          set.targetRepsMax,
          set.done,
        ]),
      ]),
    ).toEqual([
      [
        bench,
        "Pause on the chest",
        [
          ["warm_up", 40, 10, 10, 10, false],
          ["normal", 80, null, 5, 8, false],
          ["normal", 80, null, 5, 8, false],
        ],
      ],
      [raise, "", [["normal", null, null, 12, 15, false]]],
    ]);
  });

  it("fails for a routine that is not there and starts nothing", async () => {
    const database = openTestDatabase();
    const exit = await database.runtime.runPromiseExit(
      startWorkoutFromRoutine(RoutineId.make("00000000-0000-7000-8000-000000000001")),
    );
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "RowNotFoundError", table: "routine" } }] },
    });
    expect(
      await database.runtime.runPromise(
        Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.inProgress),
      ),
    ).toEqual(Option.none());
  });
});
