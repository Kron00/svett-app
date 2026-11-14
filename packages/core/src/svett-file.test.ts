import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { EpochMillis } from "./schema.ts";
import { decodeSvettFile, encodeSvettFile, exportFileName } from "./svett-file.ts";
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
        version: 1,
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

  it("reads a table the file leaves out as empty, and leaves out rows marked deleted", () => {
    const decoded = decodeSvettFile(
      file({
        folder: [folder, { ...folder, id: "01900000-0000-7000-8000-000000000002", deletedAt: 9 }],
      }),
    );
    expect(Result.isSuccess(decoded) && decoded.success.tables.folder).toEqual([folder]);
    expect(Result.isSuccess(decoded) && decoded.success.tables.activity).toEqual([]);
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
    expect(failure(file({}, 2))).toMatchObject({
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
});
