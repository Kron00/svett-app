import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { EpochMillis } from "./schema.ts";
import {
  decodeSvettFile,
  encodeSvettFile,
  exportFileName,
  SVETT_FILE_VERSION,
} from "./svett-file.ts";
import { TABLE_KEYS, type Snapshot } from "./transfer.ts";

const folder = {
  id: "01900000-0000-7000-8000-000000000001",
  updatedAt: 5,
  deletedAt: null,
  name: "Push pull legs",
  position: 0,
};

const snapshot = (rows: Partial<Snapshot>): Snapshot =>
  ({ ...Object.fromEntries(TABLE_KEYS.map((key) => [key, []])), ...rows }) as Snapshot;

const file = (tables: Record<string, ReadonlyArray<unknown>>, version = 1) =>
  JSON.stringify({ format: "svett", version, exportedAt: 1_000, tables });

const failure = (text: string) => {
  const result = decodeSvettFile(text);
  if (Result.isSuccess(result)) throw new Error("decoded");
  return result.failure;
};

describe("svett file", () => {
  it("reads back what it wrote", () => {
    const text = encodeSvettFile(snapshot({ folder: [folder] as never }), EpochMillis.make(1_000));
    const decoded = decodeSvettFile(text);
    expect(decoded).toEqual(
      Result.succeed({
        version: SVETT_FILE_VERSION,
        exportedAt: 1_000,
        rows: 1,
        tables: { ...Object.fromEntries(TABLE_KEYS.map((key) => [key, []])), folder: [folder] },
      }),
    );
  });

  it("names every table in the file, so the file shows what svett holds", () => {
    const text = encodeSvettFile(snapshot({}), EpochMillis.make(0));
    expect(Object.keys(JSON.parse(text).tables)).toHaveLength(TABLE_KEYS.length);
  });

  it("names the export after the day it was made", () => {
    expect(exportFileName(EpochMillis.make(Date.UTC(2026, 10, 13, 9)))).toBe(
      "svett-export-2026-11-13.json",
    );
  });

  it("reads a table the file leaves out as empty, and keeps rows marked deleted", () => {
    const deleted = { ...folder, id: "01900000-0000-7000-8000-000000000002", deletedAt: 9 };
    const decoded = decodeSvettFile(file({ folder: [folder, deleted] }));
    expect(Result.isSuccess(decoded) && decoded.success.tables.folder).toEqual([folder, deleted]);
    expect(Result.isSuccess(decoded) && decoded.success.rows).toBe(2);
    expect(Result.isSuccess(decoded) && decoded.success.tables.activity).toEqual([]);
  });

  it("writes rows marked deleted, so a deletion survives the round trip", () => {
    const deleted = { ...folder, id: "01900000-0000-7000-8000-000000000002", deletedAt: 9 };
    const text = encodeSvettFile(
      snapshot({ folder: [folder, deleted] as never }),
      EpochMillis.make(1_000),
    );
    expect(JSON.parse(text).tables.folder).toEqual([folder, deleted]);
  });

  it("reads a version 1 file's workouts as finished, with every set done", () => {
    const activity = {
      id: "01900000-0000-7000-8000-0000000000a1",
      updatedAt: 5,
      deletedAt: null,
      kind: "strength",
      startedAt: 1_000,
      durationS: 3_600,
      title: "Legs",
      notes: "",
      energyKcal: null,
      audience: "only_you",
      hiddenFields: [],
      source: "svett",
      sourceId: null,
      fingerprint: null,
      importBatchId: null,
    };
    const set = {
      id: "01900000-0000-7000-8000-0000000000a3",
      updatedAt: 5,
      deletedAt: null,
      activityExerciseId: "01900000-0000-7000-8000-0000000000a2",
      position: 0,
      setType: "normal",
      weightKg: 100,
      reps: 5,
      durationS: null,
      distanceM: null,
      rpe: null,
    };
    const decoded = decodeSvettFile(file({ activity: [activity], activity_set: [set] }, 1));
    if (Result.isFailure(decoded)) throw new Error(decoded.failure.message);
    expect(decoded.success.tables.activity).toEqual([
      { ...activity, status: "finished", routineId: null },
    ]);
    expect(decoded.success.tables.activitySet).toEqual([
      { ...set, done: true, targetRepsMin: null, targetRepsMax: null },
    ]);
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["JSON that is not a svett file", JSON.stringify({ workouts: [] })],
  ])("refuses %s", (_, text) => {
    expect(failure(text)).toMatchObject({
      reason: "not_svett",
      message: "This is not a svett export file.",
    });
  });

  it("asks for an update when a newer svett made the file", () => {
    expect(failure(file({}, SVETT_FILE_VERSION + 1))).toMatchObject({
      reason: "too_new",
      message: "A newer svett made this file. Update svett, then import it again.",
    });
  });

  it("refuses the whole file when one row breaks its table's rules", () => {
    const empty = { ...folder, id: "01900000-0000-7000-8000-000000000003", name: "" };
    expect(failure(file({ folder: [folder, empty] }))).toMatchObject({
      reason: "invalid",
      message: "Row 2 of folder is not valid.",
    });
  });

  it("refuses a file that holds one row twice", () => {
    expect(failure(file({ folder: [folder, folder] }))).toMatchObject({
      reason: "invalid",
      message: "The file holds folder row 01900000-0000-7000-8000-000000000001 twice.",
    });
  });

  it("refuses a table svett does not know", () => {
    expect(failure(file({ gym: [] }))).toMatchObject({
      reason: "invalid",
      message: "The file has a table svett does not know, gym.",
    });
  });

  describe("import changes", () => {
    const change = (fields: Record<string, unknown>) => ({
      id: "01900000-0000-7000-8000-0000000000c1",
      updatedAt: 5,
      deletedAt: null,
      importBatchId: "01900000-0000-7000-8000-0000000000b1",
      change: "replaced",
      itemTable: "folder",
      itemId: folder.id,
      title: "Push pull legs",
      itemAt: null,
      rowIds: { folder: [folder.id] },
      replaced: { folder: [folder] },
      written: "0".repeat(64),
      ...fields,
    });

    it("reads an import change whose kept rows pass their tables' rules", () => {
      expect(Result.isSuccess(decodeSvettFile(file({ import_change: [change({})] })))).toBe(true);
    });

    it.each([
      [
        "a table svett does not know",
        { replaced: { not_a_table: [{ junk: true }] } },
        "it names a table svett does not know, not_a_table",
      ],
      [
        "a row that breaks its table's rules",
        { replaced: { folder: [{ ...folder, name: "" }] } },
        "it keeps a folder row that is not valid",
      ],
      [
        "a row the import did not write",
        { rowIds: { folder: [] } },
        "it keeps a folder row the import did not write",
      ],
      [
        "an unknown table among the rows it wrote",
        { rowIds: { gym: [folder.id] } },
        "it names a table svett does not know, gym",
      ],
      [
        "an import change inside it that is not valid",
        {
          itemTable: "import_change",
          itemId: "01900000-0000-7000-8000-0000000000c2",
          rowIds: { import_change: ["01900000-0000-7000-8000-0000000000c2"] },
          replaced: {
            import_change: [
              change({
                id: "01900000-0000-7000-8000-0000000000c2",
                replaced: { not_a_table: [{ junk: true }] },
              }),
            ],
          },
        },
        "it names a table svett does not know, not_a_table",
      ],
    ])("refuses an import change that keeps %s, before anything is written", (_, fields, why) => {
      expect(failure(file({ import_change: [change(fields)] }))).toMatchObject({
        reason: "invalid",
        message: `Row 1 of import_change is not valid, because ${why}.`,
      });
    });
  });
});
