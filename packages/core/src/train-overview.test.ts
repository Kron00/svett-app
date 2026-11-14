import { Effect, ManagedRuntime } from "effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { databaseLayer, type OpenStep } from "./database.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { buildFixture } from "./fixture.ts";
import { Ids } from "./ids.ts";
import { openNodeDatabase } from "./node-sqlite.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { ExerciseRepository } from "./repositories/exercises.ts";
import { MADE_HERE } from "./repositories/origin.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import type { SqlDriver } from "./sql.ts";
import { openTestDatabase } from "./test-database.ts";
import { trainOverview } from "./train-overview.ts";

const bench = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");

describe("trainOverview", () => {
  it("names each routine's exercises, marks a deleted one, and shows the workout in progress", async () => {
    const { runtime } = openTestDatabase();
    const overview = await runtime.runPromise(
      Effect.gen(function* () {
        const exercises = yield* ExerciseRepository;
        const routines = yield* RoutineRepository;
        const custom = yield* exercises.create({
          name: "Sled push",
          category: "strongman",
          equipment: "other",
          primaryMuscles: ["quadriceps"],
          secondaryMuscles: [],
          origin: MADE_HERE,
        });
        const exercise = (exerciseId: typeof bench) => ({
          exerciseId,
          supersetGroup: null,
          restS: null,
          notes: "",
          sets: [],
        });
        const folderId = yield* routines.createFolder({ name: "Program", position: 0 });
        yield* routines.createRoutine({
          folderId,
          title: "Push",
          notes: "",
          position: 0,
          exercises: [exercise(bench), exercise(custom), exercise(bench)],
        });
        yield* exercises.remove(custom);
        yield* (yield* ActivityRepository).startWorkout({
          title: "Morning",
          routineId: null,
          exercises: [],
        });
        return yield* trainOverview;
      }),
    );
    expect(overview.folders.map((folder) => folder.name)).toEqual(["Program"]);
    expect(overview.sections.map((section) => section.routines.map((r) => r.title))).toEqual([
      ["Push"],
    ]);
    const push = overview.sections[0]!.routines[0]!;
    expect(overview.summaries.get(push.id)).toBe(
      "Barbell Bench Press - Medium Grip, Deleted exercise, Barbell Bench Press - Medium Grip",
    );
    expect(overview.inProgress?.title).toBe("Morning");
  });
});

/** Counts the rows each read returns, so a test sees how much the launch reads. */
const counting = (driver: SqlDriver) => {
  let rows = 0;
  return {
    rowsRead: () => rows,
    driver: {
      ...driver,
      all: async (sql, params) => {
        const read = await driver.all(sql, params);
        rows += read.length;
        return read;
      },
    } satisfies SqlDriver,
  };
};

describe("a cold start on the 300-workout fixture", () => {
  const { driver } = openNodeDatabase();
  beforeAll(() => buildFixture(driver));

  /** Opens the fixture as the app does at launch and reads the Train tab. */
  const launch = async () => {
    const counted = counting(driver);
    const steps: Array<OpenStep> = [];
    const started = performance.now();
    const runtime = ManagedRuntime.make(
      databaseLayer(counted.driver, Ids.layerSeeded(1), (step) => steps.push(step)),
    );
    const overview = await runtime.runPromise(trainOverview);
    const ms = performance.now() - started;
    await runtime.dispose();
    return { ms, overview, steps, rowsRead: counted.rowsRead() };
  };

  it("checks the migrations and the library, and reads the Train tab, within 50 ms", async () => {
    const launches = [await launch(), await launch(), await launch()];
    expect(launches[0]!.steps).toEqual(["migrated", "seeded"]);
    expect(launches[0]!.overview.sections.flatMap((section) => section.routines)).toHaveLength(3);
    expect(Math.min(...launches.map((run) => run.ms))).toBeLessThan(50);
  });

  it("reads a few dozen rows, never the workout history or the whole library", async () => {
    const { rowsRead } = await launch();
    // The fixture holds 300 workouts, about 6,000 sets and 876 exercises.
    expect(rowsRead).toBeLessThan(60);
  });
});
