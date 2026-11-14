import { Effect, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { databaseLayer } from "../database.ts";
import { DurationSeconds } from "../duration.ts";
import { libraryExerciseId } from "../exercise-library.ts";
import { buildFixture } from "../fixture.ts";
import { routineFromWorkout, type WorkoutSummary } from "../history.ts";
import { Ids } from "../ids.ts";
import { openNodeDatabase } from "../node-sqlite.ts";
import { type ActivityId, EpochMillis } from "../schema.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { type ActivityDraft, ActivityRepository, type SetDraft } from "./activities.ts";
import { type HistoryCursor, HistoryRepository } from "./history.ts";
import { MADE_HERE } from "./origin.ts";
import { RoutineRepository } from "./routines.ts";

const DAY = 86_400_000;
const SQUAT = libraryExerciseId("Barbell_Squat");
const CURL = libraryExerciseId("Lying_Leg_Curls");
const DEADLIFT = libraryExerciseId("Barbell_Deadlift");

const set = (
  weightKg: number | null,
  reps: number,
  setType: SetDraft["setType"] = "normal",
): SetDraft => ({ setType, weightKg, reps, durationS: null, distanceM: null, rpe: null });

type Lift = { readonly exerciseId: typeof SQUAT; readonly sets: ReadonlyArray<SetDraft> };

const workout = (daysAgo: number, title: string, lifts: ReadonlyArray<Lift>): ActivityDraft => ({
  kind: "strength",
  startedAt: EpochMillis.make(T0 - daysAgo * DAY),
  durationS: DurationSeconds.make(3_600),
  title,
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: [],
  origin: MADE_HERE,
  track: null,
  exercises: lifts.map((lift) => ({ ...lift, supersetGroup: null, notes: "" })),
});

/** Every workout in history, read a page at a time the way the history screen does. */
const allPages = (history: typeof HistoryRepository.Service, limit: number) =>
  Effect.gen(function* () {
    const rows: Array<WorkoutSummary> = [];
    let after: HistoryCursor | undefined;
    for (;;) {
      const page = yield* history.page({ limit, after });
      if (page.length === 0) return rows;
      rows.push(...page);
      after = page.at(-1)?.activity;
    }
  });

const open = () => {
  const database = openTestDatabase();
  const run = <A, E>(
    body: (repositories: {
      readonly activities: typeof ActivityRepository.Service;
      readonly history: typeof HistoryRepository.Service;
      readonly routines: typeof RoutineRepository.Service;
    }) => Effect.Effect<A, E>,
  ) =>
    database.runtime.runPromise(
      Effect.gen(function* () {
        return yield* body({
          activities: yield* ActivityRepository,
          history: yield* HistoryRepository,
          routines: yield* RoutineRepository,
        });
      }),
    );
  const log = (daysAgo: number, title: string, lifts: ReadonlyArray<Lift>) =>
    run(({ activities }) => activities.create(workout(daysAgo, title, lifts)));
  const view = async (id: ActivityId) =>
    Option.getOrThrow(await run(({ history }) => history.workout(id)));
  return { database, run, log, view };
};

describe("HistoryRepository.page", () => {
  it("lists workouts newest first with what each row shows", async () => {
    const { run, log } = open();
    await log(3, "Legs", [
      { exerciseId: SQUAT, sets: [set(60, 8, "warm_up"), set(100, 5), set(100, 5)] },
      { exerciseId: CURL, sets: [set(40, 12)] },
    ]);
    await log(1, "Pull", [{ exerciseId: DEADLIFT, sets: [set(140, 3)] }]);

    const page = await run(({ history }) => history.page({ limit: 10 }));
    expect(page.map((row) => row.activity.title)).toEqual(["Pull", "Legs"]);
    expect(page[1]).toMatchObject({
      exerciseNames: ["Barbell Squat", "Lying Leg Curls"],
      setCount: 4,
      // Warm-ups are left out: 100 × 5 × 2 + 40 × 12.
      volumeKg: 1480,
    });
  });

  it("continues after a cursor without repeating or skipping a workout", async () => {
    const { run } = open();
    await run(({ activities }) =>
      Effect.forEach([0, 1, 2, 3, 4, 5, 6], (day) =>
        activities.create(workout(day, `Day ${day}`, [{ exerciseId: SQUAT, sets: [set(100, 5)] }])),
      ),
    );
    const rows = await run(({ history }) => allPages(history, 3));
    expect(rows.map((row) => row.activity.title)).toEqual([
      "Day 0",
      "Day 1",
      "Day 2",
      "Day 3",
      "Day 4",
      "Day 5",
      "Day 6",
    ]);
  });

  it("leaves out a deleted workout and shows it again after undo", async () => {
    const { run, log } = open();
    const kept = await log(2, "Kept", [{ exerciseId: SQUAT, sets: [set(100, 5)] }]);
    const removed = await log(1, "Removed", [{ exerciseId: SQUAT, sets: [set(100, 5)] }]);
    const titles = async () =>
      (await run(({ history }) => history.page({ limit: 10 }))).map((row) => row.activity.title);

    await run(({ activities }) => activities.remove(removed));
    expect(await titles()).toEqual(["Kept"]);
    expect(await run(({ history }) => history.starts)).toEqual([
      expect.objectContaining({ id: kept }),
    ]);

    await run(({ activities }) => activities.restore(removed));
    expect(await titles()).toEqual(["Removed", "Kept"]);
    expect(Option.isSome(await run(({ history }) => history.workout(removed)))).toBe(true);
  });
});

describe("HistoryRepository.workout", () => {
  it("shows each set with its badge, its text and the records it set", async () => {
    const { log, view } = open();
    await log(7, "Legs", [{ exerciseId: SQUAT, sets: [set(100, 5), set(100, 5)] }]);
    const id = await log(0, "Legs", [
      {
        exerciseId: SQUAT,
        sets: [set(60, 8, "warm_up"), set(105, 5), set(100, 6), set(80, 6, "drop")],
      },
    ]);

    const squat = (await view(id)).exercises[0]!;
    expect(squat.name).toBe("Barbell Squat");
    expect(squat.sets.map((row) => [row.badge.text, row.text, row.records])).toEqual([
      ["W", "60 kg × 8", []],
      // 105 × 5: 1RM 122.5, volume 525. 100 × 6: 1RM 120, volume 600. 80 × 6: volume 480.
      ["1", "105 kg × 5", ["weight", "one_rep_max"]],
      ["2", "100 kg × 6", ["set_volume"]],
      ["D", "80 kg × 6", []],
    ]);
  });

  it("measures records only against workouts that started earlier and still exist", async () => {
    const { run, log, view } = open();
    const middle = await log(2, "Middle", [{ exerciseId: SQUAT, sets: [set(110, 5)] }]);
    await log(4, "First", [{ exerciseId: SQUAT, sets: [set(100, 5)] }]);
    const heavy = await log(3, "Heavy", [{ exerciseId: SQUAT, sets: [set(150, 5)] }]);
    // A later, heavier workout does not take the record back from Middle.
    await log(0, "Later", [{ exerciseId: SQUAT, sets: [set(200, 5)] }]);

    expect((await view(middle)).recordCount).toBe(0);
    await run(({ activities }) => activities.remove(heavy));
    expect((await view(middle)).recordCount).toBe(3);
  });

  it("splits the working sets by main muscle", async () => {
    const { log, view } = open();
    const id = await log(0, "Legs", [
      { exerciseId: SQUAT, sets: [set(60, 8, "warm_up"), set(100, 5), set(100, 5), set(100, 5)] },
      { exerciseId: CURL, sets: [set(40, 12)] },
    ]);
    expect((await view(id)).split).toEqual([
      { muscle: "quadriceps", sets: 3, percent: 75 },
      { muscle: "hamstrings", sets: 1, percent: 25 },
    ]);
  });

  it("shows an edited past set on the workout's detail", async () => {
    const { run, log, view } = open();
    await log(7, "Legs", [{ exerciseId: SQUAT, sets: [set(100, 5)] }]);
    const id = await log(0, "Legs", [{ exerciseId: SQUAT, sets: [set(100, 5)] }]);
    const edited = (await view(id)).exercises[0]!.sets[0]!;
    expect(edited.records).toEqual([]);

    await run(({ activities }) => activities.updateSet(edited.id, { weightKg: 122.5, reps: 4 }));
    const after = (await view(id)).exercises[0]!.sets[0]!;
    expect(after.text).toBe("122.5 kg × 4");
    expect(after.records).toEqual(["weight", "one_rep_max"]);
  });

  it("is none for a workout that does not exist", async () => {
    const { run, log } = open();
    const id = await log(0, "Legs", [{ exerciseId: SQUAT, sets: [set(100, 5)] }]);
    await run(({ activities }) => activities.remove(id));
    expect(Option.isNone(await run(({ history }) => history.workout(id)))).toBe(true);
  });
});

describe("save as routine", () => {
  it("makes a routine with the workout's exercises and sets as targets", async () => {
    const { run, log } = open();
    const id = await log(0, "Legs", [
      { exerciseId: SQUAT, sets: [set(60, 8, "warm_up"), set(100, 5)] },
      { exerciseId: CURL, sets: [set(40, 12)] },
    ]);
    const routineId = await run(({ activities, routines }) =>
      Effect.gen(function* () {
        const detail = Option.getOrThrow(yield* activities.get(id));
        return yield* routines.createRoutine(routineFromWorkout(detail, 0));
      }),
    );
    const routine = Option.getOrThrow(await run(({ routines }) => routines.getRoutine(routineId)));
    expect(routine.routine.title).toBe("Legs");
    expect(
      routine.exercises.map(({ exercise, sets }) => [
        exercise.exerciseId,
        sets.map((target) => [target.setType, target.weightKg, target.repsMin, target.repsMax]),
      ]),
    ).toEqual([
      [
        SQUAT,
        [
          ["warm_up", 60, 8, 8],
          ["normal", 100, 5, 5],
        ],
      ],
      [CURL, [["normal", 40, 12, 12]]],
    ]);
  });
});

describe("the 300-workout fixture", () => {
  it("pages through every workout once and describes the newest", async () => {
    const { driver } = openNodeDatabase();
    await buildFixture(driver);
    const runtime = ManagedRuntime.make(databaseLayer(driver, Ids.layerSeeded(1)));
    const history = await runtime.runPromise(Effect.service(HistoryRepository));

    const ids = (await runtime.runPromise(allPages(history, 60))).map((row) => row.activity.id);
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);

    const newest = Option.getOrThrow(await runtime.runPromise(history.workout(ids[0]!)));
    expect(newest.exercises.length).toBeGreaterThanOrEqual(4);
    expect(newest.split.reduce((total, share) => total + share.percent, 0)).toBe(100);
    await runtime.dispose();
  });
});
