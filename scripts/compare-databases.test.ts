import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildFixture, openNodeDatabase } from "@svett/core/node";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { compareDatabases, databaseCounts, formatComparison } from "./compare-databases.ts";

const folder = mkdtempSync(join(tmpdir(), "svett-compare-"));
const original = join(folder, "original.db");
let copies = 0;

/** A copy of the original, changed by `change`. */
const copy = (change: (database: DatabaseSync) => void = () => {}) => {
  const path = join(folder, `copy-${copies++}.db`);
  copyFileSync(original, path);
  const database = new DatabaseSync(path);
  change(database);
  database.close();
  return path;
};

beforeAll(async () => {
  const { database, driver } = openNodeDatabase(original);
  await buildFixture(driver, 1, 5);
  database.close();
});

const anImport = (database: DatabaseSync) => {
  database.exec(
    "INSERT INTO import_batch (id, updated_at, deleted_at, source, created_at, status) VALUES ('b', 1, NULL, 'svett_file', 1, 'applied')",
  );
  database.exec(
    "INSERT INTO import_change (id, updated_at, deleted_at, import_batch_id, change, item_table, item_id, title, item_at, replaced, written) VALUES ('c', 1, NULL, 'b', 'added', 'activity', 'a', 'Legs', NULL, NULL, 'f')",
  );
};

describe("compareDatabases", () => {
  it("finds a copy equal, leaving out the import that made it", () => {
    const comparison = compareDatabases(original, copy(anImport));
    expect(comparison).toMatchObject({ equal: true, newImports: ["b"], unmatchedTables: [] });
    expect(comparison.tables.find(({ table }) => table === "activity")).toEqual({
      table: "activity",
      rows: 5,
      missing: 0,
      extra: 0,
    });
    expect(formatComparison(comparison)).toContain("Equal row for row.");
  });

  it("finds a row with one column changed", () => {
    const comparison = compareDatabases(
      original,
      copy((database) =>
        database.exec(
          "UPDATE activity SET title = 'Changed' WHERE rowid = (SELECT min(rowid) FROM activity)",
        ),
      ),
    );
    expect(comparison.equal).toBe(false);
    expect(comparison.tables.find(({ table }) => table === "activity")).toMatchObject({
      missing: 1,
      extra: 1,
    });
    expect(formatComparison(comparison)).toContain(
      "activity: 5 rows, 1 missing or different, 1 extra",
    );
  });

  it("finds a row the copy lacks, or holds only as deleted", () => {
    const comparison = compareDatabases(
      original,
      copy((database) => database.exec("UPDATE measurement SET deleted_at = 1 WHERE rowid = 1")),
    );
    expect(comparison.tables.find(({ table }) => table === "measurement")).toMatchObject({
      missing: 1,
      extra: 0,
    });
  });
});

describe("databaseCounts", () => {
  it("counts live rows and lists imports with their status", () => {
    const counts = databaseCounts(copy(anImport));
    expect(counts.live).toMatchObject({ activity: 5, import_batch: 1, import_change: 1 });
    expect(counts.imports).toEqual([{ id: "b", source: "svett_file", status: "applied" }]);
  });
});
