import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { manualClock } from "./manual-clock.ts";
import { currentVersion, type Migration, migrate, MIGRATIONS } from "./migrations.ts";
import { openNodeDatabase } from "./node-sqlite.ts";
import { Sql } from "./sql.ts";
import { columnOf, TABLES } from "./table.ts";

const SECOND: Migration = {
  version: 2,
  name: "test only: activity place",
  sql: "ALTER TABLE activity ADD COLUMN place TEXT; CREATE TABLE gym (id TEXT PRIMARY KEY NOT NULL) STRICT;",
};

const open = () => {
  const { database, driver } = openNodeDatabase();
  const layer = Layer.merge(Sql.layer(driver), manualClock(0).layer);
  const run = <A, E>(effect: Effect.Effect<A, E, Sql>) =>
    Effect.runPromiseExit(Effect.provide(effect, layer));
  return { database, run };
};

const tableNames = (database: ReturnType<typeof open>["database"]) =>
  database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row["name"]);

describe("migrate", () => {
  it("builds every table from an empty database", async () => {
    const { database, run } = open();
    expect(await run(migrate())).toEqual(Exit.succeed({ from: 0, to: 1 }));
    expect(tableNames(database)).toEqual(
      [...Object.values(TABLES).map((table) => table.name), "schema_version"].toSorted(),
    );
  });

  it("gives each table exactly the columns of its schema", async () => {
    const { database, run } = open();
    await run(migrate());
    for (const table of Object.values(TABLES)) {
      const columns = database
        .prepare(`SELECT name FROM pragma_table_info('${table.name}')`)
        .all()
        .map((row) => row["name"]);
      expect(columns.toSorted(), table.name).toEqual(table.keys.map(columnOf).toSorted());
    }
  });

  it("moves a database from the previous version to the next and keeps its rows", async () => {
    const { database, run } = open();
    await run(migrate(MIGRATIONS));
    database.exec(
      "INSERT INTO folder (id, updated_at, deleted_at, name, position) VALUES ('f', 1, NULL, 'Push', 0)",
    );
    expect(await run(migrate([...MIGRATIONS, SECOND]))).toEqual(Exit.succeed({ from: 1, to: 2 }));
    expect(await run(currentVersion)).toEqual(Exit.succeed(2));
    expect(tableNames(database)).toContain("gym");
    expect(database.prepare("SELECT name FROM folder").all()).toEqual([{ name: "Push" }]);
  });

  it("does nothing when the database is already current", async () => {
    const { database, run } = open();
    await run(migrate([...MIGRATIONS, SECOND]));
    const versions = database.prepare("SELECT * FROM schema_version").all();
    expect(await run(migrate([...MIGRATIONS, SECOND]))).toEqual(Exit.succeed({ from: 2, to: 2 }));
    expect(database.prepare("SELECT * FROM schema_version").all()).toEqual(versions);
  });

  it("leaves the version unchanged when a migration fails", async () => {
    const { run } = open();
    await run(migrate());
    const broken: Migration = { version: 2, name: "broken", sql: "CREATE TABLE gym (; " };
    expect(Exit.isFailure(await run(migrate([...MIGRATIONS, broken])))).toBe(true);
    expect(await run(currentVersion)).toEqual(Exit.succeed(1));
  });

  it("refuses a database from a newer app", async () => {
    const { run } = open();
    await run(migrate([...MIGRATIONS, SECOND]));
    const exit = await run(migrate(MIGRATIONS));
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "DatabaseTooNewError", databaseVersion: 2 } }] },
    });
  });
});
