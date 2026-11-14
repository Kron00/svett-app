import { Effect, Exit, ManagedRuntime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { copyDatabase, ownRowCount } from "./database-move.ts";
import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { buildFixture, summarizeDatabase } from "./fixture.ts";
import { contentFingerprint } from "./ids.ts";
import { openNodeDatabase } from "./node-sqlite.ts";
import { ActivityRepository, type ActivityDraft } from "./repositories/activities.ts";
import type { Origin } from "./repositories/origin.ts";
import { ImportRepository } from "./repositories/records.ts";
import { EpochMillis, Fingerprint, SourceIdentity } from "./schema.ts";
import { Sql } from "./sql.ts";
import { openTestDatabase, T0 } from "./test-database.ts";

const legs = (origin: Origin): ActivityDraft => ({
  kind: "strength",
  startedAt: EpochMillis.make(T0 - 3_600_000),
  durationS: DurationSeconds.make(3_300),
  title: "Legs",
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: [],
  origin,
  exercises: [
    {
      exerciseId: libraryExerciseId("Barbell_Squat"),
      supersetGroup: null,
      notes: "",
      sets: [
        { setType: "normal", weightKg: 100, reps: 5, durationS: null, distanceM: null, rpe: null },
      ],
    },
  ],
  track: null,
});

type Database = ReturnType<typeof openTestDatabase>;

const sqlOf = (database: Database) => database.runtime.runPromise(Effect.service(Sql));

/** Every row of every table, deleted ones included, as SQLite holds it. */
const everyRow = (database: Database) =>
  Object.fromEntries(
    database.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(({ name }) => [
        String(name),
        database.database.prepare(`SELECT * FROM ${String(name)} ORDER BY 1`).all(),
      ]),
  );

/** The anonymous database: imported Hevy history, one workout made here, and one deleted. */
const anonymousWithHistory = async () => {
  const database = openTestDatabase(1);
  await database.runtime.runPromise(
    Effect.gen(function* () {
      const imports = yield* ImportRepository;
      const activities = yield* ActivityRepository;
      const batch = yield* imports.create("hevy");
      yield* activities.create(
        legs({
          source: "hevy",
          sourceId: SourceIdentity.make("2025-12-31T08:00:00Z"),
          fingerprint: Fingerprint.make(contentFingerprint({ title: "Legs" })),
          importBatchId: batch,
        }),
      );
      yield* activities.create(legs({ source: "svett" }));
      const gone = yield* activities.create({ ...legs({ source: "svett" }), title: "Gone" });
      yield* activities.remove(gone);
    }),
  );
  return database;
};

describe("copyDatabase", () => {
  it("copies every row into the account's database with the same IDs", async () => {
    const anonymous = await anonymousWithHistory();
    const account = openTestDatabase(2);
    const copied = await Effect.runPromise(
      copyDatabase(await sqlOf(anonymous), await sqlOf(account)),
    );

    expect(everyRow(account)).toEqual(everyRow(anonymous));
    expect(copied).toBeGreaterThan(0);
    expect(
      account.database
        .prepare("SELECT title, deleted_at IS NOT NULL AS deleted FROM activity ORDER BY title")
        .all(),
    ).toEqual([
      { title: "Gone", deleted: 1 },
      { title: "Legs", deleted: 0 },
      { title: "Legs", deleted: 0 },
    ]);
  });

  it("moves the 300-workout fixture with every set", async () => {
    const source = openNodeDatabase();
    const summary = await buildFixture(source.driver);
    const sourceSql = ManagedRuntime.make(Sql.layer(source.driver));
    const account = openTestDatabase(2);

    const moved = await account.runtime.runPromise(
      Effect.gen(function* () {
        const from = yield* Effect.promise(() => sourceSql.runPromise(Effect.service(Sql)));
        yield* copyDatabase(from, yield* Sql);
        return yield* summarizeDatabase;
      }),
    );

    expect(moved).toEqual(summary);
  });

  it("adds nothing when it runs twice", async () => {
    const anonymous = await anonymousWithHistory();
    const account = openTestDatabase(2);
    const from = await sqlOf(anonymous);
    const to = await sqlOf(account);
    await Effect.runPromise(copyDatabase(from, to));
    const once = everyRow(account);
    await Effect.runPromise(copyDatabase(from, to));
    expect(everyRow(account)).toEqual(once);
  });

  it("keeps the account's copy of a row when it is newer", async () => {
    const anonymous = await anonymousWithHistory();
    const account = openTestDatabase(2);
    await Effect.runPromise(copyDatabase(await sqlOf(anonymous), await sqlOf(account)));
    account.database.exec(
      "UPDATE activity SET title = 'Renamed', updated_at = updated_at + 1000 WHERE title = 'Legs' AND source = 'hevy'",
    );
    anonymous.database.exec("UPDATE activity SET title = 'Older edit' WHERE source = 'hevy'");

    await Effect.runPromise(copyDatabase(await sqlOf(anonymous), await sqlOf(account)));

    expect(
      account.database.prepare("SELECT title FROM activity WHERE source = 'hevy'").all(),
    ).toEqual([{ title: "Renamed" }]);
  });

  it("copies nothing when a row breaks its schema", async () => {
    const anonymous = await anonymousWithHistory();
    anonymous.database.exec("UPDATE activity SET kind = 'swim' WHERE title = 'Gone'");
    const account = openTestDatabase(2);
    const to = await sqlOf(account);
    const before = everyRow(account);

    const exit = await Effect.runPromiseExit(copyDatabase(await sqlOf(anonymous), to));

    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("InvalidRowError");
    expect(everyRow(account)).toEqual(before);
  });
});

describe("ownRowCount", () => {
  it("counts what someone logged or imported, not the bundled library", async () => {
    const empty = openTestDatabase(1);
    expect(await empty.runtime.runPromise(Effect.flatMap(Effect.service(Sql), ownRowCount))).toBe(
      0,
    );

    const anonymous = await anonymousWithHistory();
    // An import batch, three workouts, and an exercise and a set in each.
    expect(
      await anonymous.runtime.runPromise(Effect.flatMap(Effect.service(Sql), ownRowCount)),
    ).toBe(10);
  });
});
