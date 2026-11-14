import { libraryExerciseId } from "@svett/core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { openFixtureDatabase } from "./fixture.ts";
import { MAX_TOOL_OUTPUT, READ_TOOLS } from "./tools.ts";

const NOW = Date.UTC(2026, 10, 13, 17);
const context = { offsetMinutes: -420 };
const SQUAT = libraryExerciseId("Barbell_Squat");

let database: Awaited<ReturnType<typeof openFixtureDatabase>>;
beforeAll(async () => {
  database = await openFixtureDatabase(NOW);
}, 120_000);
afterAll(() => database.runtime.dispose());

const call = async (name: string, input: unknown) => {
  const tool = READ_TOOLS.find((each) => each.name === name)!;
  const result = await database.runtime.runPromise(
    tool.execute(typeof input === "string" ? input : JSON.stringify(input), context),
  );
  return { ...result, json: JSON.parse(result.output) as Record<string, any> };
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
    expect(json).toMatchObject({ day: first.day, title: first.title });
    expect(json["exercises"].length).toBe(first.exercises);
    expect(source).toBe(`Workout "${first.title}" on ${first.day}`);
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
    expect(json["routines"].map((routine: { title: string }) => routine.title)).toEqual([
      "Push",
      "Pull",
      "Legs",
    ]);
    expect(json["routines"][2]).toMatchObject({ folder: "Push pull legs" });
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
    expect(
      (await call("best_sets", { exerciseId: "squat", from: "2026-10-01", to: "2026-10-31" })).json,
    ).toEqual({
      error: "no exercise has the id squat",
    });
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
