import { describe, expect, it } from "vite-plus/test";

import { EpochMillis } from "./schema.ts";
import { type AnyRow, countLabel, groupItems, isNothingToImport, planImport } from "./transfer.ts";

const row = (id: string, fields: Record<string, unknown> = {}, updatedAt = 1): AnyRow => ({
  id,
  updatedAt: EpochMillis.make(updatedAt),
  deletedAt: null,
  ...fields,
});

const workout = (title: string, updatedAt = 1) => ({
  activity: [row("a", { title, kind: "strength", startedAt: 1_000 }, updatedAt)],
  activityExercise: [row("e", { activityId: "a" }, updatedAt)],
  activitySet: [row("s", { activityExerciseId: "e", reps: 5 }, updatedAt)],
});

const at = (id: string, title: string, startedAt: number) =>
  row(id, { title, kind: "strength", startedAt });

describe("planImport", () => {
  it("counts records that are not here as new, by kind", () => {
    const plan = planImport(
      {},
      { ...workout("Legs"), measurement: [row("m", { kind: "body_weight", measuredAt: 5 })] },
    );
    expect(plan.added).toEqual([
      { table: "activity", count: 1 },
      { table: "measurement", count: 1 },
    ]);
    expect(isNothingToImport(plan)).toBe(false);
  });

  it("leaves a record alone when only the time it last changed differs", () => {
    const plan = planImport(workout("Legs", 1), workout("Legs", 99));
    expect(plan).toMatchObject({ added: [], changed: [], unchanged: 1 });
    expect(isNothingToImport(plan)).toBe(true);
  });

  it("lists a renamed workout as changed, not new", () => {
    const plan = planImport(workout("Legs"), workout("Leg day"));
    expect(plan.added).toEqual([]);
    expect(plan.changed).toEqual([
      { key: "activity/a", table: "activity", id: "a", title: "Leg day", at: 1_000 },
    ]);
  });

  it("lists a workout with a changed set as changed", () => {
    const local = workout("Legs");
    const plan = planImport(local, {
      ...local,
      activitySet: [row("s", { activityExerciseId: "e", reps: 6 })],
    });
    expect(plan.changed.map((item) => item.key)).toEqual(["activity/a"]);
  });

  it("lists a workout here with a set the file lacks as changed", () => {
    const local = workout("Legs");
    const plan = planImport(
      { ...local, activitySet: [...local.activitySet, row("s2", { activityExerciseId: "e" })] },
      local,
    );
    expect(plan.changed.map((item) => item.key)).toEqual(["activity/a"]);
  });

  it("lists changed records newest first", () => {
    const plan = planImport(
      { activity: [at("a", "Old", 1), at("b", "New", 9)] },
      { activity: [at("a", "Old!", 1), at("b", "New!", 9)] },
    );
    expect(plan.changed.map((item) => item.title)).toEqual(["New!", "Old!"]);
  });
});

describe("groupItems", () => {
  it("puts a set under the workout here when the file holds only the set", () => {
    const local = workout("Legs");
    const items = groupItems({ activitySet: local.activitySet }, local);
    expect([...items.keys()]).toEqual(["activity/a"]);
  });

  it("gives a set whose parent is nowhere a record of its own under that parent", () => {
    const items = groupItems({ activitySet: [row("s", { activityExerciseId: "gone" })] });
    expect([...items.keys()]).toEqual(["activity_exercise/gone"]);
  });
});

describe("countLabel", () => {
  it("counts in words", () => {
    expect(countLabel("activity", 1)).toBe("1 workout");
    expect(countLabel("activity", 1_200)).toBe("1,200 workouts");
    expect(countLabel("coachMessage", 2)).toBe("2 coach messages");
  });
});
