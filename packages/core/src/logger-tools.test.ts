import { Effect, Exit, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { describeSet } from "./history.ts";
import { nextSet } from "./logger.ts";
import { DEFAULT_BARS_AND_PLATES } from "./plates.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { HistoryRepository } from "./repositories/history.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { TransferRepository } from "./repositories/transfer.ts";
import { DEFAULT_REST_S, restAfterSet } from "./rest-timer.ts";
import { EMPTY_TARGET } from "./routine-plan.ts";
import type { ActivityId } from "./schema.ts";
import {
  addExercisesToWorkout,
  loadWorkoutLog,
  startEmptyWorkout,
  startWorkoutFromRoutine,
} from "./start-workout.ts";
import { leaveSuperset, supersetWithNext } from "./superset.ts";
import { decodeSvettFile } from "./svett-file.ts";
import { openTestDatabase } from "./test-database.ts";
import { warmUpSets } from "./warm-up.ts";
import { kgFrom } from "./weight-unit.ts";

const squat = libraryExerciseId("Barbell_Squat");
const curl = libraryExerciseId("Lying_Leg_Curls");
const press = libraryExerciseId("Barbell_Shoulder_Press");

const log = Effect.map(loadWorkoutLog, Option.getOrThrow);
const activities = Effect.service(ActivityRepository);

/** Marks every set of the workout in progress done with 100 kg for 5, then finishes it. */
const finishAll = (id: ActivityId) =>
  Effect.gen(function* () {
    const repository = yield* activities;
    for (const exercise of (yield* log).exercises) {
      for (const set of exercise.sets) {
        yield* repository.updateWorkoutSet(set.id, { weightKg: 100, reps: 5, done: true });
      }
    }
    return yield* repository.finishWorkout(id);
  });

/** Applies superset changes, which name exercises by their place, to the workout in progress. */
const group = (changes: ReadonlyArray<{ index: number; supersetGroup: number | null }>) =>
  Effect.gen(function* () {
    const { exercises } = yield* log;
    yield* (yield* activities).groupExercises(
      changes.map(({ index, supersetGroup }) => ({ id: exercises[index]!.row.id, supersetGroup })),
    );
  });

/** The superset groups, rest times and RPEs stored, straight from SQLite. */
const read = (database: ReturnType<typeof openTestDatabase>) => ({
  exercises: database.database
    .prepare("SELECT superset_group, rest_s FROM activity_exercise ORDER BY position")
    .all(),
  rpe: database.database.prepare("SELECT rpe FROM activity_set WHERE rpe IS NOT NULL").all(),
});

const rows = (workout: {
  readonly exercises: ReadonlyArray<{
    readonly row: { readonly supersetGroup: number | null; readonly restS: number | null };
  }>;
}) => workout.exercises.map(({ row }) => row);

describe("logger tools", () => {
  it("rests as the routine says, else as last time, else 1:30", async () => {
    const database = openTestDatabase();
    const rests = await database.runtime.runPromise(
      Effect.gen(function* () {
        const routines = yield* RoutineRepository;
        const routine = yield* routines.createRoutine({
          folderId: null,
          title: "Legs",
          notes: "",
          position: 0,
          exercises: [
            {
              exerciseId: squat,
              supersetGroup: null,
              restS: DurationSeconds.make(180),
              notes: "",
              sets: [EMPTY_TARGET],
            },
            { exerciseId: curl, supersetGroup: null, restS: null, notes: "", sets: [EMPTY_TARGET] },
          ],
        });
        const first = yield* startEmptyWorkout(9);
        yield* addExercisesToWorkout(first, [curl]);
        const empty = rows(yield* log).map((row) => row.restS);
        yield* (yield* activities).updateExercise((yield* log).exercises[0]!.row.id, {
          restS: DurationSeconds.make(45),
        });
        yield* finishAll(first);
        yield* startWorkoutFromRoutine(routine);
        return { empty, routine: rows(yield* log).map((row) => row.restS) };
      }),
    );
    expect(rests).toEqual({ empty: [DEFAULT_REST_S], routine: [180, 45] });
  });

  it("puts warm-up sets before the working sets, in order, still to do", async () => {
    const database = openTestDatabase();
    const sets = await database.runtime.runPromise(
      Effect.gen(function* () {
        const id = yield* startEmptyWorkout(9);
        yield* addExercisesToWorkout(id, [squat]);
        const exercise = (yield* log).exercises[0]!;
        yield* (yield* activities).updateWorkoutSet(exercise.sets[0]!.id, {
          weightKg: 100,
          reps: 5,
        });
        const warmUps = warmUpSets(100, 20, DEFAULT_BARS_AND_PLATES.kg.plates);
        yield* (yield* activities).addSetsFirst(
          exercise.row.id,
          warmUps.map((set) =>
            Object.assign(nextSet([]), {
              setType: "warm_up" as const,
              weightKg: kgFrom(set.weight, "kg"),
              reps: set.reps,
            }),
          ),
        );
        return (yield* log).exercises[0]!.sets.map((set) => [
          set.position,
          set.setType,
          set.weightKg,
          set.reps,
          set.done,
        ]);
      }),
    );
    expect(sets).toEqual([
      [0, "warm_up", 20, 10, false],
      [1, "warm_up", 40, 5, false],
      [2, "warm_up", 60, 3, false],
      [3, "warm_up", 80, 2, false],
      [4, "normal", 100, 5, false],
    ]);
  });

  it("keeps supersets, rest times and RPE through finish, history, export and import", async () => {
    const phone = openTestDatabase(1);
    const finished = await phone.runtime.runPromise(
      Effect.gen(function* () {
        const id = yield* startEmptyWorkout(9);
        yield* addExercisesToWorkout(id, [squat, curl, press]);
        yield* group(supersetWithNext(rows(yield* log), 1));
        const workout = yield* log;
        expect(restAfterSet(rows(workout), 1)).toBeNull();
        expect(restAfterSet(rows(workout), 2)).toEqual({ seconds: DEFAULT_REST_S, next: 1 });
        const repository = yield* activities;
        yield* finishAll(id);
        const sets = (yield* repository.get(id)).pipe(Option.getOrThrow).exercises;
        yield* repository.updateSet(sets[0]!.sets[0]!.id, { rpe: 8.5 });
        return id;
      }),
    );

    const history = await phone.runtime.runPromise(
      Effect.flatMap(HistoryRepository, (repository) => repository.workout(finished)),
    );
    const view = Option.getOrThrow(history);
    expect(view.exercises.map((entry) => entry.superset?.letter ?? null)).toEqual([null, "A", "A"]);
    expect(describeSet(view.exercises[0]!.sets[0]!)).toBe("100 kg × 5 · RPE 8.5");
    expect(describeSet(view.exercises[0]!.sets[0]!, "lb")).toBe("220.46 lb × 5 · RPE 8.5");

    const { text } = await phone.runtime.runPromise(
      Effect.flatMap(TransferRepository, (repository) => repository.exportFile),
    );
    const file = Result.getOrThrow(decodeSvettFile(text));
    const wiped = openTestDatabase(2);
    await wiped.runtime.runPromise(
      Effect.flatMap(TransferRepository, (repository) => repository.applyImport(file, [])),
    );
    expect(read(phone)).toEqual({
      exercises: [
        { superset_group: null, rest_s: DEFAULT_REST_S },
        { superset_group: 0, rest_s: DEFAULT_REST_S },
        { superset_group: 0, rest_s: DEFAULT_REST_S },
      ],
      rpe: [{ rpe: 8.5 }],
    });
    expect(read(wiped)).toEqual(read(phone));
  });

  it("takes an exercise out of a superset, and refuses superset changes once finished", async () => {
    const database = openTestDatabase();
    const exit = await database.runtime.runPromise(
      Effect.gen(function* () {
        const id = yield* startEmptyWorkout(9);
        yield* addExercisesToWorkout(id, [squat, curl]);
        yield* group(supersetWithNext(rows(yield* log), 0));
        expect(rows(yield* log).map((row) => row.supersetGroup)).toEqual([0, 0]);
        yield* group(leaveSuperset(rows(yield* log), 1));
        expect(rows(yield* log).map((row) => row.supersetGroup)).toEqual([null, null]);
        const exerciseId = (yield* log).exercises[0]!.row.id;
        yield* finishAll(id);
        return yield* Effect.exit(
          (yield* activities).groupExercises([{ id: exerciseId, supersetGroup: 1 }]),
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
