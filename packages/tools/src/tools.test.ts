import {
  ActivityRepository,
  DurationSeconds,
  EpochMillis,
  ExerciseRepository,
  libraryExerciseId,
  MADE_HERE,
} from "@svett/core";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { openEmptyDatabase, openFixtureDatabase } from "./fixture.ts";
import { MAX_SOURCE, MAX_TOOL_OUTPUT, READ_TOOLS, runToolCall, type ToolResult } from "./tools.ts";

const NOW = Date.UTC(2026, 10, 13, 17);
const context = { offsetMinutes: -420 };
const SQUAT = libraryExerciseId("Barbell_Squat");

let database: Awaited<ReturnType<typeof openFixtureDatabase>>;
beforeAll(async () => {
  database = await openFixtureDatabase(NOW);
}, 120_000);
afterAll(() => database.runtime.dispose());

type Runtime = Awaited<ReturnType<typeof openFixtureDatabase>>["runtime"];

const parsed = (result: ToolResult) => ({
  ...result,
  json: JSON.parse(result.output) as Record<string, any>,
});

const callOn = async (runtime: Runtime, name: string, input: unknown) =>
  parsed(
    await runtime.runPromise(
      runToolCall(name, typeof input === "string" ? input : JSON.stringify(input), context),
    ),
  );

const call = (name: string, input: unknown) => callOn(database.runtime, name, input);

const properties = (name: string) =>
  (READ_TOOLS.find((tool) => tool.name === name)!.definition.parameters as any).properties;

const setOf = (weightKg: number) => ({
  setType: "normal" as const,
  weightKg,
  reps: 5,
  durationS: null,
  distanceM: null,
  rpe: null,
});

/** Reads page after page, from `start` until a page names no next one. */
const allPages = async <T>(
  start: number | null,
  page: (
    start: number,
  ) => Promise<{ readonly items: ReadonlyArray<T>; readonly next: number | null }>,
): Promise<ReadonlyArray<T>> => {
  if (start === null) return [];
  const { items, next } = await page(start);
  return [...items, ...(await allPages(next, page))];
};

describe("the read tools", () => {
  it("each describes its input as a closed JSON object", () => {
    expect(READ_TOOLS.map((tool) => tool.name)).toEqual([
      "search_exercises",
      "list_workouts",
      "get_workout",
      "best_sets",
      "exercise_history",
      "body_measurements",
      "list_routines",
    ]);
    for (const tool of READ_TOOLS) {
      expect(tool.definition.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(JSON.stringify(tool.definition.parameters)).not.toContain("$ref");
    }
  });

  it("finds the exercise the user logs first, ahead of ones never logged", async () => {
    const { json, source } = await call("search_exercises", { query: "squat" });
    expect(json["exercises"][0]).toMatchObject({
      id: SQUAT,
      name: "Barbell Squat",
      timesLogged: 100,
    });
    expect(json["exercises"]).toHaveLength(5);
    expect(source).toBe('Exercise search "squat" (5 found)');
  });

  it("lists a month of workouts, newest first, with the total even past the limit", async () => {
    const { json, source } = await call("list_workouts", {
      from: "2026-10-01",
      to: "2026-10-31",
      limit: 3,
    });
    expect(json["workouts"]).toHaveLength(3);
    expect(json["total"]).toBeGreaterThan(3);
    const days = json["workouts"].map((workout: { day: string }) => workout.day);
    expect([...days].sort().toReversed()).toEqual(days);
    expect(source).toBe(`Workouts 2026-10-01 to 2026-10-31 (${json["total"]})`);
  });

  it("reads one workout with its exercises and sets", async () => {
    const listed = await call("list_workouts", { from: "2026-10-01", to: "2026-10-31", limit: 1 });
    const [first] = listed.json["workouts"];
    const { json, source } = await call("get_workout", { workoutId: first.id });
    expect(json).toMatchObject({
      day: first.day,
      title: first.title,
      totalExercises: first.exercises,
      truncated: false,
      nextExerciseStart: null,
    });
    expect(json["exercises"].length).toBe(first.exercises);
    expect(source).toBe(`Workout "${first.title.userWritten}" on ${first.day}`);
  });

  it("gives the best squat sets of a month, heaviest first, with no warm-up", async () => {
    const { json } = await call("best_sets", {
      exerciseId: SQUAT,
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(json["exercise"]).toBe("Barbell Squat");
    const best = json["best"] as Array<{ weightKg: number; reps: number; type: string }>;
    expect(best).toHaveLength(3);
    expect(best.every((set) => set.type !== "warm_up")).toBe(true);
    expect(best[0]).toMatchObject({ day: "2026-10-14", weightKg: 117.5, reps: 8 });
  });

  it("gives an exercise's history, one entry per workout", async () => {
    const { json } = await call("exercise_history", {
      exerciseId: SQUAT,
      from: "2026-10-01",
      to: "2026-10-31",
    });
    const workouts = json["workouts"] as Array<{ day: string; topSet: { weightKg: number } }>;
    expect(workouts.length).toBeGreaterThan(1);
    expect(new Set(workouts.map((workout) => workout.day)).size).toBe(workouts.length);
    expect(workouts.every((workout) => workout.topSet.weightKg > 0)).toBe(true);
  });

  it("reads one kind of body measurement in a range", async () => {
    const { json, source } = await call("body_measurements", {
      from: "2026-09-01",
      to: "2026-10-31",
      kind: "body_weight",
    });
    expect(json["measurements"].length).toBeGreaterThan(4);
    expect(
      json["measurements"].every(
        (each: { kind: string; unit: string }) => each.kind === "body_weight" && each.unit === "kg",
      ),
    ).toBe(true);
    expect(source).toBe("Measurements of body weight, 2026-09-01 to 2026-10-31");
  });

  it("lists the saved routines with their folder", async () => {
    const { json } = await call("list_routines", {});
    expect(
      json["routines"].map((routine: { title: { userWritten: string } }) => routine.title),
    ).toEqual([{ userWritten: "Push" }, { userWritten: "Pull" }, { userWritten: "Legs" }]);
    expect(json["routines"][2]).toMatchObject({ folder: { userWritten: "Push pull legs" } });
    expect(json["routines"][2].exercises[0]).toEqual({ name: "Barbell Squat", sets: 3 });
  });

  it("keeps every answer short, even over two years at each limit", async () => {
    const wide = { from: "2024-01-01", to: "2026-12-31" };
    const answers = await Promise.all([
      call("search_exercises", { query: "a", limit: 10 }),
      call("list_workouts", { ...wide, limit: 20 }),
      call("best_sets", { ...wide, exerciseId: SQUAT, limit: 5 }),
      call("exercise_history", { ...wide, exerciseId: SQUAT, limit: 20 }),
      call("body_measurements", { ...wide, limit: 30 }),
      call("list_routines", {}),
    ]);
    for (const answer of answers) {
      expect(answer.json["error"]).toBeUndefined();
      expect(answer.output.length).toBeLessThan(MAX_TOOL_OUTPUT / 2);
    }
  });

  it("tells the model what was wrong with its input instead of failing", async () => {
    expect((await call("list_workouts", { from: "2026-10-31", to: "2026-10-01" })).json).toEqual({
      error: "to comes before from",
    });
    expect((await call("list_workouts", { from: "2026-02-30", to: "2026-03-01" })).json).toEqual({
      error: "from and to must be real days as YYYY-MM-DD",
    });
    const missing = "019a0000-0000-7000-8000-000000000000";
    expect(
      (await call("best_sets", { exerciseId: missing, from: "2026-10-01", to: "2026-10-31" })).json,
    ).toEqual({ error: `no exercise has the id ${missing}` });
    const notAnId = await call("best_sets", {
      exerciseId: "squat",
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(notAnId.json["error"]).toEqual(expect.any(String));
    expect(
      (await call("list_workouts", { from: "2000-01-01", to: "2026-10-31" })).json["error"],
    ).toBe("a range covers at most ten years");
    expect((await call("get_workout", { workoutId: SQUAT })).json).toEqual({
      error: `no workout has the id ${SQUAT}`,
    });
    const limit = await call("list_workouts", { from: "2026-10-01", to: "2026-10-31", limit: 500 });
    expect(limit.json["error"]).toEqual(expect.any(String));
    const extra = await call("list_workouts", {
      from: "2026-10-01",
      to: "2026-10-31",
      everything: true,
    });
    expect(extra.json["error"]).toEqual(expect.any(String));
    const notJson = await call("list_routines", "{not json");
    expect(notJson.json["error"]).toEqual(expect.any(String));
    expect(notJson.source).toMatch(/^list_routines \(not read: /);
  });

  it("reads days in the phone's time zone", async () => {
    const utc = await database.runtime.runPromise(
      READ_TOOLS.find((tool) => tool.name === "list_workouts")!.execute(
        JSON.stringify({ from: "2026-10-01", to: "2026-10-31" }),
        { offsetMinutes: 0 },
      ),
    );
    const local = await call("list_workouts", { from: "2026-10-01", to: "2026-10-31" });
    const utcDays = JSON.parse(utc.output)["workouts"] as Array<{ id: string; day: string }>;
    const localDays = new Map(
      (local.json["workouts"] as Array<{ id: string; day: string }>).map((w) => [w.id, w.day]),
    );
    const shifted = utcDays.filter(
      (workout) => localDays.has(workout.id) && localDays.get(workout.id) !== workout.day,
    );
    for (const workout of shifted) {
      expect(localDays.get(workout.id)! < workout.day).toBe(true);
    }
  });
});

describe("input and output bounds", () => {
  const long = "x".repeat(900);
  const huge = "x".repeat(100_000);

  it("keeps every refusal and source short, however long the input", async () => {
    const results = [
      await call("get_workout", { workoutId: long }),
      await call("get_workout", { workoutId: huge }),
      await call("get_workout", `{"workoutId": "${huge}"`),
      await call("search_exercises", { query: long }),
      await call("best_sets", { exerciseId: long, from: "2026-10-01", to: "2026-10-31" }),
      await call("list_workouts", { from: long, to: "2026-10-31" }),
      await call(huge, {}),
      await call(long, {}),
    ];
    for (const result of results) {
      expect(result.json["error"]).toEqual(expect.any(String));
      expect(result.output.length).toBeLessThan(400);
      expect(result.source.length).toBeLessThanOrEqual(MAX_SOURCE);
      expect(result.output).not.toContain("x".repeat(400));
    }
    expect((await call("get_workout", { workoutId: huge })).json).toEqual({
      error: "the arguments are too long",
    });
    expect((await call(long, {})).source).toMatch(/^x+… \(not read: /);
  });

  it("describes every id argument as a UUID and every text argument with a length limit", () => {
    expect(properties("get_workout").workoutId.format).toBe("uuid");
    expect(properties("best_sets").exerciseId.format).toBe("uuid");
    expect(properties("exercise_history").exerciseId.format).toBe("uuid");
    expect(properties("search_exercises").query.maxLength).toBe(60);
    expect(properties("list_workouts").from.pattern).toEqual(expect.any(String));
  });
});

describe("a workout longer than one answer", () => {
  let small: ReturnType<typeof openEmptyDatabase>;
  let workoutId: string;
  const EXERCISES = 25;
  const FIRST_SETS = 30;

  beforeAll(async () => {
    small = openEmptyDatabase(NOW);
    workoutId = await small.runtime.runPromise(
      Effect.gen(function* () {
        const library = (yield* (yield* ExerciseRepository).list).slice(0, EXERCISES);
        return yield* (yield* ActivityRepository).create({
          kind: "strength",
          startedAt: EpochMillis.make(NOW - 7_200_000),
          durationS: DurationSeconds.make(7_000),
          title: "Everything",
          notes: "n".repeat(600),
          energyKcal: null,
          audience: "only_you",
          hiddenFields: [],
          origin: MADE_HERE,
          exercises: library.map((exercise, index) => ({
            exerciseId: exercise.id,
            supersetGroup: null,
            notes: "",
            sets: Array.from({ length: index === 0 ? FIRST_SETS : 2 }, (_, at) => setOf(at + 1)),
          })),
          track: null,
        });
      }),
    );
  });
  afterAll(() => small.runtime.dispose());

  const read = (input: Record<string, number>) =>
    callOn(small.runtime, "get_workout", { workoutId, ...input });

  it("says what it left out instead of looking complete", async () => {
    const { json, output } = await read({});
    expect(output.length).toBeLessThan(MAX_TOOL_OUTPUT / 2);
    expect(json).toMatchObject({
      totalExercises: EXERCISES,
      truncated: true,
      nextExerciseStart: 8,
      notesTruncated: true,
    });
    expect(json["exercises"]).toHaveLength(8);
    expect(json["exercises"][0]).toMatchObject({
      index: 0,
      totalSets: FIRST_SETS,
      nextSetStart: 12,
    });
    expect(json["exercises"][0].sets).toHaveLength(12);
    expect(json["exercises"][1]).toMatchObject({ index: 1, totalSets: 2, nextSetStart: null });
  });

  it("reads every exercise and every set through its paging arguments", async () => {
    const indexes = await allPages(0, async (start) => {
      const { json } = await read({ exerciseStart: start });
      return {
        items: json["exercises"].map((exercise: { index: number }) => exercise.index) as number[],
        next: json["nextExerciseStart"],
      };
    });
    expect(indexes).toEqual(Array.from({ length: EXERCISES }, (_, index) => index));

    const weights = await allPages(0, async (setStart) => {
      const { json } = await read(setStart === 0 ? {} : { exerciseStart: 0, setStart });
      if (setStart > 0) expect(json["exercises"]).toHaveLength(1);
      const [first] = json["exercises"];
      return {
        items: first.sets.map((each: { weightKg: number }) => each.weightKg) as number[],
        next: first.nextSetStart,
      };
    });
    expect(weights).toEqual(Array.from({ length: FIRST_SETS }, (_, index) => index + 1));
  });

  it("refuses a start past the end", async () => {
    expect((await read({ exerciseStart: EXERCISES })).json["error"]).toBe(
      `the workout has ${EXERCISES} exercises, so exerciseStart is at most ${EXERCISES - 1}`,
    );
    expect((await read({ exerciseStart: 0, setStart: FIRST_SETS })).json["error"]).toBe(
      `exercise 0 has ${FIRST_SETS} sets, so setStart is at most ${FIRST_SETS - 1}`,
    );
  });
});
