import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { manualClock } from "./manual-clock.ts";
import { currentVersion, type Migration, migrate, MIGRATIONS } from "./migrations.ts";
import { openNodeDatabase } from "./node-sqlite.ts";
import { Sql } from "./sql.ts";
import { columnOf, TABLES } from "./table.ts";
import { setFieldsFromSets } from "./logger.ts";

const NEXT: Migration = {
  version: MIGRATIONS.length + 1,
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
    expect(await run(migrate())).toEqual(Exit.succeed({ from: 0, to: MIGRATIONS.length }));
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
    expect(await run(migrate([...MIGRATIONS, NEXT]))).toEqual(
      Exit.succeed({ from: MIGRATIONS.length, to: NEXT.version }),
    );
    expect(await run(currentVersion)).toEqual(Exit.succeed(NEXT.version));
    expect(tableNames(database)).toContain("gym");
    expect(database.prepare("SELECT name FROM folder").all()).toEqual([{ name: "Push" }]);
  });

  it("moves a database made by the first release to the current version", async () => {
    const { database, run } = open();
    await run(migrate(MIGRATIONS.slice(0, 1)));
    database.exec(
      "INSERT INTO folder (id, updated_at, deleted_at, name, position) VALUES ('f', 1, NULL, 'Push', 0)",
    );
    expect(await run(migrate())).toEqual(Exit.succeed({ from: 1, to: MIGRATIONS.length }));
    expect(tableNames(database)).toEqual(
      [...Object.values(TABLES).map((table) => table.name), "schema_version"].toSorted(),
    );
    expect(database.prepare("SELECT name FROM folder").all()).toEqual([{ name: "Push" }]);
  });

  it("does nothing when the database is already current", async () => {
    const { database, run } = open();
    await run(migrate([...MIGRATIONS, NEXT]));
    const versions = database.prepare("SELECT * FROM schema_version").all();
    expect(await run(migrate([...MIGRATIONS, NEXT]))).toEqual(
      Exit.succeed({ from: NEXT.version, to: NEXT.version }),
    );
    expect(database.prepare("SELECT * FROM schema_version").all()).toEqual(versions);
  });

  it("leaves the version unchanged when a migration fails", async () => {
    const { run } = open();
    await run(migrate());
    const broken: Migration = {
      version: NEXT.version,
      name: "broken",
      sql: "CREATE TABLE gym (; ",
    };
    expect(Exit.isFailure(await run(migrate([...MIGRATIONS, broken])))).toBe(true);
    expect(await run(currentVersion)).toEqual(Exit.succeed(MIGRATIONS.length));
  });

  it("refuses a database from a newer app", async () => {
    const { run } = open();
    await run(migrate([...MIGRATIONS, NEXT]));
    const exit = await run(migrate(MIGRATIONS));
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: {
        reasons: [{ error: { _tag: "DatabaseTooNewError", databaseVersion: NEXT.version } }],
      },
    });
  });

  it("keeps every activity saved before workouts could be in progress finished, with its sets done", async () => {
    const { database, run } = open();
    await run(migrate(MIGRATIONS.slice(0, 3)));
    database.exec(
      `INSERT INTO activity (id, updated_at, kind, started_at, duration_s, title, notes, source)
       VALUES ('a', 1, 'strength', 1, 60, 'Push', '', 'svett');
       INSERT INTO activity_set (id, updated_at, activity_exercise_id, position, set_type, reps)
       VALUES ('s', 1, 'e', 0, 'normal', 5)`,
    );
    await run(migrate());
    expect(database.prepare("SELECT status, routine_id FROM activity").all()).toEqual([
      { status: "finished", routine_id: null },
    ]);
    expect(
      database.prepare("SELECT done, target_reps_min, target_reps_max FROM activity_set").all(),
    ).toEqual([{ done: 1, target_reps_min: null, target_reps_max: null }]);
  });
  it("logs each exercise saved before set fields by what its sets record", async () => {
    const { database, run } = open();
    await run(migrate(MIGRATIONS.slice(0, 3)));
    const sets: ReadonlyArray<
      [string, number | null, number | null, number | null, number | null]
    > = [
      ["squat", 100, 5, null, null],
      ["squat", null, 5, null, null],
      ["pullup", null, 8, null, null],
      ["plank", null, null, 60, null],
      ["carry", 40, null, null, 30],
      ["row", null, null, 120, 500],
      ["hold", 20, null, 45, null],
    ];
    const exercises = [...new Set(sets.map(([exercise]) => exercise)), "empty"];
    for (const exercise of exercises) {
      database
        .prepare(
          "INSERT INTO activity_exercise (id, updated_at, activity_id, exercise_id, position, notes) VALUES (?, 1, 'a', 'x', 0, '')",
        )
        .run(exercise);
    }
    for (const [index, [exercise, weight, reps, duration, distance]] of sets.entries()) {
      database
        .prepare(
          "INSERT INTO activity_set (id, updated_at, activity_exercise_id, position, set_type, weight_kg, reps, duration_s, distance_m) VALUES (?, 1, ?, 0, 'normal', ?, ?, ?, ?)",
        )
        .run(`s${index}`, exercise, weight, reps, duration, distance);
    }
    await run(migrate());
    const stored = Object.fromEntries(
      database
        .prepare("SELECT id, set_fields FROM activity_exercise")
        .all()
        .map((row) => [row["id"], row["set_fields"]]),
    );
    const expected = Object.fromEntries(
      exercises.map((exercise) => [
        exercise,
        setFieldsFromSets(
          sets
            .filter(([name]) => name === exercise)
            .map(([, weightKg, reps, durationS, distanceM]) => ({
              weightKg,
              reps,
              durationS,
              distanceM,
            })) as never,
        ) ?? "weight_reps",
      ]),
    );
    expect(stored).toEqual(expected);
    expect(stored).toEqual({
      squat: "weight_reps",
      pullup: "reps",
      plank: "time",
      carry: "weight_distance",
      row: "distance_time",
      hold: "weight_time",
      empty: "weight_reps",
    });
  });
});
