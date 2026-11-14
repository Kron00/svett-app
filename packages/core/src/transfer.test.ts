import { describe, expect, it } from "vite-plus/test";

import { EpochMillis, type ImportChange, ImportChangeId } from "./schema.ts";
import {
  type AnyRow,
  countLabel,
  groupItems,
  importOutcome,
  isNothingToImport,
  planImport,
  type UndoEntry,
  undoOutcome,
  undoPlanLabel,
  undoSelection,
} from "./transfer.ts";

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

  it("leaves a set here that the file lacks as it is, since import never removes rows", () => {
    const local = workout("Legs");
    const plan = planImport(
      { ...local, activitySet: [...local.activitySet, row("s2", { activityExerciseId: "e" })] },
      local,
    );
    expect(plan).toMatchObject({ added: [], changed: [], unchanged: 1 });
  });

  it("plans to write only the rows the file holds, not the workout above them", () => {
    const local = workout("Legs");
    const changedSet = row("s", { activityExerciseId: "e", reps: 6 });
    expect(planImport(local, { activitySet: local.activitySet })).toMatchObject({
      changed: [],
      unchanged: 1,
    });
    const plan = planImport(local, { activitySet: [changedSet] });
    expect(plan.changed.map((item) => item.key)).toEqual(["activity/a"]);
    expect(plan.items).toEqual([
      expect.objectContaining({
        status: "changed",
        writes: { activitySet: [changedSet] },
        replaced: { activitySet: local.activitySet },
      }),
    ]);
  });

  it("lists a workout deleted here as changed, and a deletion in the file the same way", () => {
    const deleted = (rows: ReturnType<typeof workout>) => ({
      activity: rows.activity.map((top) => ({ ...top, deletedAt: EpochMillis.make(7) })),
    });
    expect(planImport(deleted(workout("Legs")), workout("Legs")).changed).toHaveLength(1);
    expect(planImport(workout("Legs"), deleted(workout("Legs"))).changed).toHaveLength(1);
  });

  it("keeps a record the file holds only as deleted, without counting it as new", () => {
    const measurement = row("m", { kind: "body_weight", measuredAt: 5 });
    const plan = planImport(
      {},
      { measurement: [{ ...measurement, deletedAt: EpochMillis.make(9) }] },
    );
    expect(plan).toMatchObject({ added: [], deleted: 1, changed: [] });
    expect(isNothingToImport(plan)).toBe(false);
  });

  it("lets the file's version of a library exercise replace the one svett seeded", () => {
    const seeded = row("x", { name: "Squat", source: "library" }, 0);
    const deleted = { ...seeded, updatedAt: EpochMillis.make(9), deletedAt: EpochMillis.make(9) };
    const plan = planImport({ exercise: [seeded] }, { exercise: [deleted] });
    expect(plan).toMatchObject({ deleted: 1, changed: [] });
    expect(plan.items).toMatchObject([
      { status: "new", writes: { exercise: [deleted] }, replaced: { exercise: [seeded] } },
    ]);

    const edited = { ...seeded, updatedAt: EpochMillis.make(3), name: "Back squat" };
    expect(planImport({ exercise: [edited] }, { exercise: [deleted] }).changed).toHaveLength(1);
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

describe("outcome text", () => {
  it("says what an import did", () => {
    expect(importOutcome({ added: 1, replaced: 0 })).toBe("Added 1 record.");
    expect(importOutcome({ added: 3, replaced: 1 })).toBe(
      "Added 3 records and took the file's version of 1 record.",
    );
    expect(importOutcome({ added: 0, replaced: 2 })).toBe("Took the file's version of 2 records.");
  });

  it("says what Undo will do", () => {
    expect(undoPlanLabel({ removing: 300, restoring: 0 })).toBe(
      "Undo removes the 300 records this import added.",
    );
    expect(undoPlanLabel({ removing: 0, restoring: 1 })).toBe(
      "Undo puts back the 1 record this import replaced.",
    );
    expect(undoPlanLabel({ removing: 2, restoring: 1 })).toBe(
      "Undo removes the 2 records this import added and puts back the 1 record it replaced.",
    );
    expect(undoPlanLabel({ removing: 0, restoring: 0 })).toBe(
      "Undo leaves every record as it is, because you changed each one after the import.",
    );
    expect(undoPlanLabel({ removing: 1, restoring: 0, keeping: 1 })).toBe(
      "Undo removes the 1 record this import added. It keeps 1 record that records you keep still use.",
    );
    expect(undoPlanLabel({ removing: 0, restoring: 0, keeping: 2 })).toBe(
      "Undo changes nothing. It keeps 2 records that records you keep still use.",
    );
  });

  it("says what Undo did, and what it left", () => {
    expect(undoOutcome({ removed: 2, restored: 1, left: 0 })).toBe(
      "Removed 2 records and put back 1 record.",
    );
    expect(undoOutcome({ removed: 1, restored: 0, left: 1 })).toBe(
      "Removed 1 record. Left 1 record you changed after the import.",
    );
    expect(undoOutcome({ removed: 0, restored: 0, left: 1, kept: 1 })).toBe(
      "Nothing was taken back. Kept 1 record that records you keep still use. Left 1 record you changed after the import.",
    );
  });
});

const changeId = (n: number) => ImportChangeId.make(`01900000-0000-7000-8000-00000000000${n}`);

const entry = (
  n: number,
  change: ImportChange["change"],
  edited: boolean,
  usedBy: ReadonlyArray<ReadonlyArray<number>> = [],
): UndoEntry => ({
  change: { id: changeId(n), change } as ImportChange,
  edited,
  usedBy: usedBy.map((removers) => removers.map(changeId)),
});
const selected = (entries: ReadonlyArray<UndoEntry>, alsoEdited: ReadonlyArray<number> = []) => {
  const { undone, ...counts } = undoSelection(entries, alsoEdited.map(changeId));
  return { undone: undone.map(({ change }) => change.id), ...counts };
};

describe("undoSelection", () => {
  it("keeps a record a row outside the import uses", () => {
    expect(selected([entry(1, "added", false, [[]]), entry(2, "added", false)])).toEqual({
      undone: [changeId(2)],
      removing: 1,
      restoring: 0,
      keeping: 1,
      leaving: 0,
    });
  });

  it("keeps a record a left workout uses, and removes it when that workout goes too", () => {
    const entries = [entry(1, "replaced", false, [[2]]), entry(2, "added", true)];
    expect(selected(entries)).toMatchObject({ undone: [], keeping: 1, leaving: 1 });
    expect(selected(entries, [2])).toMatchObject({
      undone: [changeId(1), changeId(2)],
      removing: 1,
      restoring: 1,
      keeping: 0,
    });
  });

  it("keeps what a kept record uses in turn", () => {
    // 3 is an import batch an exercise (2) points at, and a left workout (1) uses the exercise.
    const entries = [
      entry(1, "added", true),
      entry(2, "added", false, [[1]]),
      entry(3, "added", false, [[2]]),
    ];
    expect(selected(entries)).toMatchObject({ undone: [], keeping: 2, leaving: 1 });
  });

  it("removes a record once every change that removes a row using it is taken back", () => {
    const entries = [
      entry(1, "added", false, [[2, 3]]),
      entry(2, "added", true),
      entry(3, "added", false),
    ];
    expect(selected(entries)).toMatchObject({
      undone: [changeId(1), changeId(3)],
      keeping: 0,
      leaving: 1,
    });
  });
});
