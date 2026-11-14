import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ActivityRepository,
  addExercisesToWorkout,
  databaseLayer,
  DurationSeconds,
  EMPTY_TARGET,
  Ids,
  libraryExerciseId,
  loadWorkoutLog,
  RoutineRepository,
  startEmptyWorkout,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { routineId, workoutRows } from "./workout-rows.ts";

const squat = libraryExerciseId("Barbell_Squat");
const plank = libraryExerciseId("Plank");

let folder: string | undefined;
afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

/** A database file holding a routine and a workout logged through the repositories. */
const loggedDatabase = async (finishIt: boolean, superset = false) => {
  folder = mkdtempSync(join(tmpdir(), "svett-workout-rows-"));
  const path = join(folder, "svett.db");
  const { database, driver } = openNodeDatabase(path);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      databaseLayer(driver, Ids.layerSeeded(1)),
      manualClock(Date.UTC(2026, 10, 13, 18)).layer,
    ),
  );
  const routine = await runtime.runPromise(
    Effect.gen(function* () {
      const routines = yield* RoutineRepository;
      const activities = yield* ActivityRepository;
      const created = yield* routines.createRoutine({
        folderId: null,
        title: "Legs",
        notes: "",
        position: 0,
        exercises: [
          {
            exerciseId: squat,
            supersetGroup: null,
            restS: null,
            notes: "",
            sets: [{ ...EMPTY_TARGET, repsMin: 5, repsMax: 5 }],
          },
        ],
      });
      const id = yield* startEmptyWorkout(18);
      yield* activities.update(id, { notes: "Felt strong" });
      yield* addExercisesToWorkout(id, [squat, plank]);
      const log = Option.getOrThrow(yield* loadWorkoutLog);
      const [first] = log.exercises[0]!.sets;
      yield* activities.updateSet(first!.id, { weightKg: 100, reps: 5, done: true });
      yield* activities.addSet(log.exercises[0]!.row.id, {
        ...EMPTY_TARGET,
        reps: null,
        weightKg: 100,
        durationS: null,
        targetRepsMin: null,
        targetRepsMax: null,
      });
      yield* activities.changeSetFields(log.exercises[1]!.row.id, "time");
      yield* activities.updateExercise(log.exercises[1]!.row.id, { notes: "Hold" });
      yield* activities.updateSet(log.exercises[1]!.sets[0]!.id, {
        durationS: DurationSeconds.make(60),
        done: true,
      });
      if (superset) {
        yield* activities.groupExercises(
          log.exercises.map((exercise) => ({ id: exercise.row.id, supersetGroup: 0 })),
        );
        yield* activities.updateSet(first!.id, { rpe: 8.5 });
      }
      if (finishIt) yield* activities.finishWorkout(id);
      return created;
    }),
  );
  await runtime.dispose();
  database.close();
  return { path, routine };
};

describe("workout-rows", () => {
  it("finds a routine by its title", async () => {
    const { path, routine } = await loggedDatabase(false);
    expect(routineId(path, "Legs")).toBe(routine);
    expect(routineId(path, "Arms")).toBeNull();
  });

  it("reads a workout in progress with every set, done or not", async () => {
    const { path } = await loggedDatabase(false);
    expect(workoutRows(path, "Evening workout")).toEqual([
      "Evening workout: in_progress",
      "Notes: Felt strong",
      "Workouts in progress: 1",
      "Exercise 1: Barbell Squat, by weight_reps",
      "Set 1.1: normal, 100 kg, 5 reps, done",
      "Set 1.2: normal, 100 kg, to do",
      "Exercise 2: Plank, by time, notes: Hold",
      "Set 2.1: normal, 60 s, done",
    ]);
  });

  it("reads a finished workout with only the sets it kept", async () => {
    const { path } = await loggedDatabase(true);
    expect(workoutRows(path, "Evening workout")).toEqual([
      "Evening workout: finished",
      "Notes: Felt strong",
      "Workouts in progress: 0",
      "Exercise 1: Barbell Squat, by weight_reps",
      "Set 1.1: normal, 100 kg, 5 reps, done",
      "Exercise 2: Plank, by time, notes: Hold",
      "Set 2.1: normal, 60 s, done",
    ]);
    expect(workoutRows(path, "Morning workout")).toBeNull();
  });

  it("reads each exercise's superset and each set's RPE", async () => {
    const { path } = await loggedDatabase(true, true);
    expect(workoutRows(path, "Evening workout")).toEqual([
      "Evening workout: finished",
      "Notes: Felt strong",
      "Workouts in progress: 0",
      "Exercise 1: Barbell Squat, by weight_reps, superset 0",
      "Set 1.1: normal, 100 kg, 5 reps, RPE 8.5, done",
      "Exercise 2: Plank, by time, superset 0, notes: Hold",
      "Set 2.1: normal, 60 s, done",
    ]);
  });
});
