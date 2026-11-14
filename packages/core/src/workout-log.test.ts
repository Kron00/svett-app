import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { databaseLayer } from "./database.ts";
import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { Ids } from "./ids.ts";
import { nextSet, REPLACED_SET } from "./logger.ts";
import { manualClock } from "./manual-clock.ts";
import { ActivityRepository, type SetDraft } from "./repositories/activities.ts";
import { MADE_HERE } from "./repositories/origin.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { EMPTY_TARGET } from "./routine-plan.ts";
import { EpochMillis, type ExerciseId } from "./schema.ts";
import {
  addExercisesToWorkout,
  changeSetFields,
  loadWorkoutLog,
  replaceWorkoutExercise,
  startEmptyWorkout,
  startWorkoutFromRoutine,
  toggleDone,
  type WorkoutLog,
} from "./start-workout.ts";
import { openTestDatabase, T0 } from "./test-database.ts";

const squat = libraryExerciseId("Barbell_Squat");
const curl = libraryExerciseId("Lying_Leg_Curls");
const plank = libraryExerciseId("Plank");
const row = libraryExerciseId("Bent_Over_Barbell_Row");

const done = (
  setType: SetDraft["setType"],
  weightKg: number | null,
  reps: number | null,
): SetDraft => ({ setType, weightKg, reps, durationS: null, distanceM: null, rpe: null });

/** A finished squat workout a day before T0, for the logger's previous values. */
const lastWeek = Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
  activities.create({
    kind: "strength",
    startedAt: EpochMillis.make(T0 - 86_400_000),
    durationS: DurationSeconds.make(3_000),
    title: "Legs",
    notes: "",
    energyKcal: null,
    audience: "only_you",
    hiddenFields: [],
    origin: MADE_HERE,
    track: null,
    exercises: [
      {
        exerciseId: squat,
        supersetGroup: null,
        notes: "",
        sets: [done("warm_up", 60, 10), done("normal", 100, 5), done("normal", 100, 4)],
      },
    ],
  }),
);

const log = Effect.map(loadWorkoutLog, Option.getOrThrow);

const shape = (workout: WorkoutLog) =>
  workout.exercises.map(({ row: exercise, sets, previous }) => ({
    exerciseId: exercise.exerciseId,
    setFields: exercise.setFields,
    sets: sets.map((set, index) => [
      set.setType,
      set.weightKg,
      set.reps,
      set.done,
      previous[index] === null ? null : [previous[index]!.weightKg, previous[index]!.reps],
    ]),
  }));

describe("logging a workout", () => {
  it("starts empty, adds exercises as they were last time, and lines up last time's sets", async () => {
    const database = openTestDatabase();
    const workout = await database.runtime.runPromise(
      Effect.gen(function* () {
        yield* lastWeek;
        const id = yield* startEmptyWorkout(18);
        yield* addExercisesToWorkout(id, [squat, curl]);
        return yield* log;
      }),
    );
    expect(workout.activity).toMatchObject({
      title: "Evening workout",
      status: "in_progress",
      routineId: null,
    });
    expect(shape(workout)).toEqual([
      {
        exerciseId: squat,
        setFields: "weight_reps",
        sets: [
          ["warm_up", null, null, false, [60, 10]],
          ["normal", null, null, false, [100, 5]],
          ["normal", null, null, false, [100, 4]],
        ],
      },
      { exerciseId: curl, setFields: "weight_reps", sets: [["normal", null, null, false, null]] },
    ]);
  });

  it("logs sets, reorders, replaces and removes exercises, and finishes with only the done sets", async () => {
    const database = openTestDatabase();
    const finished = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        yield* lastWeek;
        const id = yield* startEmptyWorkout(7);
        const [squatId, curlId, plankId] = yield* addExercisesToWorkout(id, [squat, curl, plank]);

        // Done with the empty fields filled from last time, then one typed by hand.
        let workout = yield* log;
        const [warmUp, first, second] = workout.exercises[0]!.sets;
        const [, lastFirst] = workout.exercises[0]!.previous;
        const toggle = toggleDone(first!, "weight_reps", lastFirst!);
        if (!toggle.ok) throw new Error(toggle.problem);
        yield* activities.updateSet(toggle.id, toggle.patch);
        yield* activities.updateSet(second!.id, { weightKg: 105, reps: 3, done: true });
        yield* activities.removeSet(warmUp!.id);
        const added = yield* activities.addSet(squatId!, nextSet((yield* log).exercises[0]!.sets));
        yield* activities.updateSet(added, { setType: "failure", reps: 2, done: true });

        yield* activities.updateExercise(squatId!, { notes: "Belt on the top sets" });
        yield* activities.updateExercise(curlId!, { notes: "Gone after the replace" });
        yield* replaceWorkoutExercise(id, curlId!, row);
        yield* activities.orderExercises(id, [plankId!, squatId!, curlId!]);
        workout = yield* log;
        expect(workout.exercises.map(({ row: exercise }) => exercise.exerciseId)).toEqual([
          plank,
          squat,
          row,
        ]);
        expect(workout.exercises[2]!.row.notes).toBe("");
        const plankSet = workout.exercises[0]!.sets[0]!;
        yield* changeSetFields(plankId!, workout.exercises[0]!.sets, "time");
        yield* activities.updateSet(plankSet.id, {
          durationS: DurationSeconds.make(75),
          done: true,
        });

        yield* activities.updateSet(workout.exercises[2]!.sets[0]!.id, { weightKg: 70 });
        yield* database.clock.set(T0 + 3_600_000);
        yield* activities.finishWorkout(id);
        return Option.getOrThrow(yield* activities.get(id));
      }),
    );

    expect(finished.activity).toMatchObject({ status: "finished", durationS: 3_600 });
    expect(
      finished.exercises.map(({ exercise, sets }) => [
        exercise.exerciseId,
        exercise.position,
        exercise.setFields,
        exercise.notes,
        sets.map((set) => [set.setType, set.weightKg, set.reps, set.durationS, set.done]),
      ]),
    ).toEqual([
      [plank, 0, "time", "", [["normal", null, null, 75, true]]],
      [
        squat,
        1,
        "weight_reps",
        "Belt on the top sets",
        [
          ["normal", 100, 5, null, true],
          ["normal", 105, 3, null, true],
          ["failure", 105, 2, null, true],
        ],
      ],
    ]);
    expect(await database.runtime.runPromise(loadWorkoutLog)).toEqual(Option.none());
    expect(
      await database.runtime.runPromise(
        Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.counts),
      ),
    ).toEqual({ activities: 2, sets: 7 });
  });

  it("restores the workout in progress, every value as it was, after the app is killed", async () => {
    const database = openTestDatabase();
    const before = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* startEmptyWorkout(9);
        yield* activities.update(id, { notes: "Felt strong" });
        const [squatId] = yield* addExercisesToWorkout(id, [squat]);
        const [set] = (yield* log).exercises[0]!.sets;
        yield* activities.updateSet(set!.id, { weightKg: 100, reps: 5, done: true });
        yield* activities.addSet(squatId!, nextSet([{ ...set!, weightKg: 100, reps: 5 }]));
        return yield* log;
      }),
    );
    await database.runtime.dispose();

    // A new runtime on the same file is the app opening again.
    const reopened = ManagedRuntime.make(
      Layer.provideMerge(databaseLayer(database.driver, Ids.layerSeeded(2)), manualClock(T0).layer),
    );
    const after = await reopened.runPromise(log);
    expect(after).toEqual(before);
    expect(after.activity.notes).toBe("Felt strong");
    expect(shape(after)[0]!.sets).toEqual([
      ["normal", 100, 5, true, null],
      ["normal", 100, 5, false, null],
    ]);
  });

  it("refuses to finish a workout with no set done and keeps it in progress", async () => {
    const database = openTestDatabase();
    const exit = await database.runtime.runPromiseExit(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* startEmptyWorkout(9);
        yield* addExercisesToWorkout(id, [squat]);
        yield* activities.finishWorkout(id);
      }),
    );
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "NothingDoneError" } }] },
    });
    expect(Option.isSome(await database.runtime.runPromise(loadWorkoutLog))).toBe(true);
  });

  it("changes nothing in a workout that is finished", async () => {
    const database = openTestDatabase();
    const exit = await database.runtime.runPromiseExit(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* lastWeek;
        const detail = Option.getOrThrow(yield* activities.get(id));
        const exercise = detail.exercises[0]!;
        return yield* Effect.all(
          [
            Effect.exit(activities.addSet(exercise.exercise.id, nextSet([]))),
            Effect.exit(activities.removeSet(exercise.sets[0]!.id)),
            Effect.exit(activities.removeExercise(exercise.exercise.id)),
          ],
          { concurrency: 1 },
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    for (const refused of Exit.isSuccess(exit) ? exit.value : []) {
      expect(refused).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { _tag: "RowNotFoundError", table: "activity" } }] },
      });
    }
    expect(
      await database.runtime.runPromise(
        Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.counts),
      ),
    ).toEqual({ activities: 1, sets: 3 });
  });

  it("logs an exercise the next time by the fields it was changed to", async () => {
    const database = openTestDatabase();
    const fields = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const first = yield* startEmptyWorkout(9);
        const [plankId] = yield* addExercisesToWorkout(first, [plank]);
        const before = (yield* log).exercises[0]!;
        yield* changeSetFields(plankId!, before.sets, "time");
        yield* activities.updateSet(before.sets[0]!.id, {
          durationS: DurationSeconds.make(60),
          done: true,
        });
        yield* activities.finishWorkout(first);
        const second = yield* startEmptyWorkout(9);
        yield* addExercisesToWorkout(second, [plank]);
        return [before.row.setFields, (yield* log).exercises[0]!.row.setFields];
      }),
    );
    expect(fields).toEqual(["reps", "time"]);
  });

  it("starts a routine with each exercise logged by what its targets hold", async () => {
    const database = openTestDatabase();
    const workout = await database.runtime.runPromise(
      Effect.gen(function* () {
        const routines = yield* RoutineRepository;
        yield* lastWeek;
        const routineId = yield* routines.createRoutine({
          folderId: null,
          title: "Legs",
          notes: "",
          position: 0,
          exercises: [squat, plank].map((exerciseId: ExerciseId) => ({
            exerciseId,
            supersetGroup: null,
            restS: null,
            notes: "",
            sets: [
              exerciseId === plank
                ? { ...EMPTY_TARGET, durationS: DurationSeconds.make(60) }
                : { ...EMPTY_TARGET, repsMin: 5, repsMax: 5 },
            ],
          })),
        });
        yield* startWorkoutFromRoutine(routineId);
        return yield* log;
      }),
    );
    expect(workout.exercises.map(({ row: exercise }) => exercise.setFields)).toEqual([
      "reps",
      "time",
    ]);
    expect(workout.exercises[0]!.previous).toHaveLength(1);
    expect(workout.exercises[0]!.previous[0]).toMatchObject({ weightKg: 100, reps: 5 });
  });

  it("empties a replaced exercise's sets but keeps their types", async () => {
    const database = openTestDatabase();
    const sets = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* startEmptyWorkout(9);
        const [squatId] = yield* addExercisesToWorkout(id, [squat]);
        const [set] = (yield* log).exercises[0]!.sets;
        yield* activities.updateSet(set!.id, {
          setType: "warm_up",
          weightKg: 60,
          reps: 10,
          done: true,
        });
        yield* replaceWorkoutExercise(id, squatId!, row);
        return (yield* log).exercises[0]!.sets;
      }),
    );
    expect(sets).toMatchObject([{ setType: "warm_up", ...REPLACED_SET }]);
  });
});
