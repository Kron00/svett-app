import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { databaseLayer } from "./database.ts";
import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { Ids } from "./ids.ts";
import { nextSet, REPLACED_SET } from "./logger.ts";
import { manualClock } from "./manual-clock.ts";
import { openNodeDatabase } from "./node-sqlite.ts";
import { ActivityRepository, type SetDraft } from "./repositories/activities.ts";
import { HistoryRepository } from "./repositories/history.ts";
import type { SqlDriver } from "./sql.ts";
import { MADE_HERE } from "./repositories/origin.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { EMPTY_TARGET } from "./routine-plan.ts";
import {
  type ActivityExerciseId,
  type ActivityId,
  type ActivitySetId,
  EpochMillis,
  type ExerciseId,
} from "./schema.ts";
import {
  addExercisesToWorkout,
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

/** Every activity row as stored, deleted or not, to show a refused change wrote nothing. */
const storedRows = (database: ReturnType<typeof openTestDatabase>) =>
  ["activity", "activity_exercise", "activity_set"].map((table) =>
    database.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  );

const refusals = (target: {
  readonly activityId: ActivityId;
  readonly exerciseId: ActivityExerciseId;
  readonly setId: ActivitySetId;
}) =>
  Effect.flatMap(Effect.service(ActivityRepository), (activities) => {
    const { activityId, exerciseId, setId } = target;
    const changes: Record<string, Effect.Effect<unknown, unknown>> = {
      addExercises: activities.addExercises(activityId, [
        { exerciseId: plank, supersetGroup: null, notes: "", sets: [nextSet([])] },
      ]),
      removeExercise: activities.removeExercise(exerciseId),
      orderExercises: activities.orderExercises(activityId, [exerciseId]),
      replaceExercise: activities.replaceExercise(exerciseId, row, "weight_reps", REPLACED_SET),
      updateExercise: activities.updateExercise(exerciseId, { notes: "Too late" }),
      changeSetFields: activities.changeSetFields(exerciseId, "time"),
      addSet: activities.addSet(exerciseId, nextSet([])),
      removeSet: activities.removeSet(setId),
      updateWorkoutSet: activities.updateWorkoutSet(setId, { reps: 9 }),
      changeSetValue: activities.changeSetValue(setId, "reps", 9),
      updateWorkout: activities.updateWorkout(activityId, { title: "Too late", notes: "No" }),
      finishWorkout: activities.finishWorkout(activityId),
    };
    return Effect.forEach(Object.entries(changes), ([name, change]) =>
      Effect.map(Effect.exit(change), (exit) => [name, exit] as const),
    );
  });

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
        yield* activities.changeSetFields(plankId!, "time");
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

  it("shows a workout finished in the logger in history and the Progress counts, and not before", async () => {
    const database = openTestDatabase();
    // What the history list and the Progress tab's summary read.
    const progress = Effect.gen(function* () {
      const history = yield* HistoryRepository;
      const activities = yield* ActivityRepository;
      return {
        list: (yield* history.page({ limit: 10 })).map((summary) => [
          summary.activity.title,
          summary.exerciseNames,
          summary.setCount,
        ]),
        starts: (yield* history.starts).map((start) => start.title),
        counts: yield* activities.counts,
      };
    });
    const { during, openedDuring, after, opened } = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const history = yield* HistoryRepository;
        yield* lastWeek;
        const id = yield* startEmptyWorkout(7);
        yield* addExercisesToWorkout(id, [squat, curl]);
        const [, first, second] = (yield* log).exercises[0]!.sets;
        yield* activities.updateSet(first!.id, { weightKg: 100, reps: 6, done: true });
        yield* activities.updateSet(second!.id, { weightKg: 100, reps: 5, done: true });
        const before = yield* progress;
        const openedBefore = yield* history.workout(id);
        yield* database.clock.set(T0 + 3_600_000);
        yield* activities.finishWorkout(id);
        return {
          during: before,
          openedDuring: openedBefore,
          after: yield* progress,
          opened: yield* history.workout(id),
        };
      }),
    );

    expect(during).toEqual({
      list: [["Legs", ["Barbell Squat"], 3]],
      starts: ["Legs"],
      counts: { activities: 1, sets: 3 },
    });
    expect(Option.isNone(openedDuring)).toBe(true);
    // The warm-up and the leg curl were never marked done, so finishing left them out.
    expect(after).toEqual({
      list: [
        ["Morning workout", ["Barbell Squat"], 2],
        ["Legs", ["Barbell Squat"], 3],
      ],
      starts: ["Morning workout", "Legs"],
      counts: { activities: 2, sets: 5 },
    });
    expect(Option.getOrThrow(opened).activity).toMatchObject({
      title: "Morning workout",
      status: "finished",
      durationS: 3_600,
    });
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
        yield* activities.changeSetFields(plankId!, "time");
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

  it("starts a routine with each exercise logged as last time, when that shows its targets", async () => {
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
    // The squat's reps target keeps last week's weight. The plank's time target needs time.
    expect(workout.exercises.map(({ row: exercise }) => exercise.setFields)).toEqual([
      "weight_reps",
      "time",
    ]);
    expect(workout.exercises[0]!.previous).toHaveLength(1);
    expect(workout.exercises[0]!.previous[0]).toMatchObject({ weightKg: 100, reps: 5 });
  });

  it("refuses every logger change to a finished or discarded workout and writes nothing", async () => {
    const database = openTestDatabase();
    const targets = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const finishedId = yield* lastWeek;
        const finished = Option.getOrThrow(yield* activities.get(finishedId)).exercises[0]!;
        const discardedId = yield* startEmptyWorkout(9);
        yield* addExercisesToWorkout(discardedId, [squat]);
        const discarded = (yield* log).exercises[0]!;
        yield* activities.remove(discardedId);
        return [
          { activityId: finishedId, exerciseId: finished.exercise.id, setId: finished.sets[0]!.id },
          { activityId: discardedId, exerciseId: discarded.row.id, setId: discarded.sets[0]!.id },
        ];
      }),
    );
    await database.runtime.runPromise(database.clock.advance(60_000));
    const before = storedRows(database);
    const results = (await database.runtime.runPromise(Effect.forEach(targets, refusals))).flat();
    expect(results).toHaveLength(24);
    for (const [name, exit] of results) {
      expect({ name, exit }).toMatchObject({
        name,
        exit: { _tag: "Failure", cause: { reasons: [{ error: { _tag: "RowNotFoundError" } }] } },
      });
    }
    expect(storedRows(database)).toEqual(before);
  });

  it("refuses an order that does not name each exercise exactly once, and changes nothing", async () => {
    const database = openTestDatabase();
    const { id, squatId, curlId } = await database.runtime.runPromise(
      Effect.gen(function* () {
        const workout = yield* startEmptyWorkout(9);
        const [first, second] = yield* addExercisesToWorkout(workout, [squat, curl]);
        return { id: workout, squatId: first!, curlId: second! };
      }),
    );
    const before = storedRows(database);
    const orders = [
      [squatId, squatId],
      [curlId, curlId],
      [squatId],
      [curlId, squatId, squatId],
      [],
    ];
    const exits = await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        Effect.forEach(orders, (order) => Effect.exit(activities.orderExercises(id, order))),
      ),
    );
    expect(exits).toHaveLength(orders.length);
    for (const exit of exits) {
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { _tag: "ExerciseOrderError" } }] },
      });
    }
    expect(storedRows(database)).toEqual(before);
    const order = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        yield* activities.orderExercises(id, [curlId, squatId]);
        return (yield* log).exercises.map((exercise) => exercise.row.id);
      }),
    );
    expect(order).toEqual([curlId, squatId]);
  });

  it("changes an exercise's fields and clears its set values together, or not at all", async () => {
    const { driver } = openNodeDatabase();
    let failSetWrites = false;
    const flaky: SqlDriver = {
      ...driver,
      run: (sql, params) =>
        failSetWrites && sql.startsWith("UPDATE activity_set")
          ? Promise.reject(new Error("disk full"))
          : driver.run(sql, params),
    };
    const runtime = ManagedRuntime.make(
      Layer.provideMerge(databaseLayer(flaky, Ids.layerSeeded(1)), manualClock(T0).layer),
    );
    const squatRow = await runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* startEmptyWorkout(9);
        const [squatId] = yield* addExercisesToWorkout(id, [squat]);
        const [set] = (yield* log).exercises[0]!.sets;
        yield* activities.updateWorkoutSet(set!.id, { weightKg: 60, reps: 8, done: true });
        return squatId!;
      }),
    );
    const changeToTime = Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.changeSetFields(squatRow, "time"),
    );
    const fieldsAndSets = Effect.map(log, ({ exercises: [exercise] }) => [
      exercise!.row.setFields,
      exercise!.sets.map((set) => [set.weightKg, set.reps, set.durationS, set.done]),
    ]);

    failSetWrites = true;
    expect(Exit.isFailure(await runtime.runPromiseExit(changeToTime))).toBe(true);
    failSetWrites = false;
    expect(await runtime.runPromise(fieldsAndSets)).toEqual(["weight_reps", [[60, 8, null, true]]]);

    await runtime.runPromise(changeToTime);
    expect(await runtime.runPromise(fieldsAndSets)).toEqual(["time", [[null, null, null, false]]]);
    await runtime.dispose();
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

  it("marks a set to do again when its last value is cleared, judged by the stored set", async () => {
    const database = openTestDatabase();
    const steps = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* startEmptyWorkout(9);
        yield* addExercisesToWorkout(id, [squat]);
        const setId = (yield* log).exercises[0]!.sets[0]!.id;
        const shown = Effect.map(log, ({ exercises }) => {
          const set = exercises[0]!.sets[0]!;
          return [set.weightKg, set.reps, set.done];
        });
        yield* activities.updateWorkoutSet(setId, { weightKg: 60, reps: 5, done: true });
        yield* activities.changeSetValue(setId, "weight", null);
        const weightCleared = yield* shown;
        yield* activities.changeSetValue(setId, "reps", null);
        return [weightCleared, yield* shown];
      }),
    );
    expect(steps).toEqual([
      [null, 5, true],
      [null, null, false],
    ]);
  });
});
