import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupFileName, restoreScratchName } from "@svett/core";
import { Clock, Duration, Effect, Exit, Fiber, Layer, type Redacted, Schedule } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { Backups, NightlyBackups } from "./backups.ts";
import { ServerConfig } from "./config.ts";
import { databaseLayer, migrate } from "./database.ts";
import { type PgToolCommands, PgTools } from "./pg-tools.ts";
import { checkRestore, dropStaleRestoreDatabases, restoreBackup } from "./restore.ts";
import { startTestPostgres, type TestPostgres } from "./test-postgres.ts";

let postgres: TestPostgres;
let databases = 0;

beforeAll(async () => {
  postgres = await startTestPostgres();
}, 120_000);

afterAll(async () => {
  await postgres?.stop();
});

const newDatabase = () => postgres.createDatabase(`test_${++databases}`);

const tempDir = async () => mkdtemp(join(tmpdir(), "svett-backups-"));

const run = <A, E>(url: Redacted.Redacted, effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(databaseLayer(url))));

const scratchDatabases = () =>
  run(
    postgres.url("postgres"),
    Effect.flatMap(Effect.service(SqlClient), (sql) =>
      sql<{ readonly datname: string }>`
        select datname from pg_database where datname like 'svett\_restore\_%' order by datname
      `.pipe(Effect.map((rows) => rows.map(({ datname }) => datname))),
    ),
  );

/** Waits until a restore check has created its scratch database, and gives the names. */
const untilScratch = Effect.promise(scratchDatabases).pipe(
  Effect.flatMap((found) =>
    found.length === 0 ? Effect.fail("not yet" as const) : Effect.succeed(found),
  ),
  Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 1000 }),
);

/** pg_restore that waits for the file `gate` to exist before it starts. */
const restoreAfter = (gate: string): PgToolCommands => ({
  ...postgres.tools,
  pgRestore: [
    "sh",
    "-c",
    'while [ ! -e "$0" ]; do sleep 0.05; done; exec "$@"',
    gate,
    ...postgres.tools.pgRestore,
  ],
});

const HOUR = 60 * 60 * 1000;

/** Runs `effect` with the wall clock stopped at `millis`. */
const frozenAt =
  (millis: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const frozen: Clock.Clock = Object.assign(Object.create(clock), {
        currentTimeMillis: Effect.succeed(millis),
        currentTimeMillisUnsafe: () => millis,
      });
      return yield* effect.pipe(Effect.provideService(Clock.Clock, frozen));
    });

const takeNow = Effect.flatMap(Effect.service(Backups), (backups) => backups.takeNow);

const backupsLayer = (
  url: Redacted.Redacted,
  backupDir: string,
  options: {
    readonly backupKeep?: number;
    readonly backupCron?: string;
    readonly tools?: PgToolCommands;
  } = {},
) =>
  Backups.layer.pipe(
    Layer.provideMerge(PgTools.layer(options.tools ?? postgres.tools)),
    Layer.provideMerge(
      Layer.succeed(
        ServerConfig,
        ServerConfig.of({
          port: 0,
          databaseUrl: url,
          backupDir,
          backupKeep: options.backupKeep ?? 14,
          backupCron: options.backupCron ?? "0 3 * * *",
        }),
      ),
    ),
  );

/** A database with the kinds of data the server will hold, in a shape a restore must keep. */
const seed = (url: Redacted.Redacted) =>
  run(
    url,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* migrate;
      yield* sql`
        create table activity (
          seq bigint generated always as identity primary key,
          account_id text not null,
          id uuid not null,
          title text,
          started_at timestamptz not null,
          weight_kg numeric(6, 2),
          detail jsonb,
          route bytea,
          deleted_at timestamptz,
          unique (account_id, id)
        )
      `;
      yield* sql`create index activity_started on activity (account_id, started_at)`;
      yield* sql`
        insert into activity (account_id, id, title, started_at, weight_kg, detail, route, deleted_at)
        values
          ('user_a', '0190c1e2-0000-7000-8000-000000000001', 'Push day ✓ «Bänk»', '2026-11-12T06:30:00Z', 102.5, '{"sets": [5, 5, 3]}', '\\x00ff10', null),
          ('user_b', '0190c1e2-0000-7000-8000-000000000001', 'Easy run', '2026-11-13T17:05:00+01:00', null, null, null, null),
          ('user_a', '0190c1e2-0000-7000-8000-000000000002', null, '2026-11-01T00:00:00Z', 0, '[]', '', '2026-11-02T00:00:00Z')
      `;
    }),
  );

const snapshot = (url: Redacted.Redacted) =>
  run(
    url,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql`
        select seq, account_id, id::text, title, started_at::text, weight_kg::text, detail::text,
               encode(route, 'hex') as route, deleted_at::text
        from activity order by seq
      `;
      const columns = yield* sql`
        select table_name, column_name, data_type, is_nullable, is_identity
        from information_schema.columns where table_schema = 'public'
        order by table_name, ordinal_position
      `;
      const indexes = yield* sql`
        select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname
      `;
      return { rows, columns, indexes };
    }),
  );

/** Runs the nightly loop until `until` gives a value, then stops it. */
const runNightly = <A>(
  layer: Layer.Layer<Backups | ServerConfig>,
  until: Effect.Effect<A | undefined, unknown, Backups>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Layer.launch(NightlyBackups));
      const result = yield* until.pipe(
        Effect.flatMap((value) =>
          value === undefined ? Effect.fail("not yet" as const) : Effect.succeed(value),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
      );
      yield* Fiber.interrupt(fiber);
      return result;
    }).pipe(Effect.provide(layer)),
  );

describe("server backups", { timeout: 120_000 }, () => {
  it("restores a backup into an empty database with every row, column and index", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();

    const backup = await Effect.runPromise(
      Effect.flatMap(Effect.service(Backups), (backups) => backups.takeNow).pipe(
        Effect.provide(backupsLayer(source, dir)),
      ),
    );
    expect(await readdir(dir)).toEqual([backup.file.split("/").pop()]);

    const target = await newDatabase();
    await Effect.runPromise(
      restoreBackup(backup.file, target).pipe(Effect.provide(PgTools.layer(postgres.tools))),
    );

    const restored = await snapshot(target);
    expect(restored).toEqual(await snapshot(source));
    expect(restored.rows).toHaveLength(3);

    // The identity carries on from the backup instead of handing out a used number.
    const next = await run(
      target,
      Effect.flatMap(
        Effect.service(SqlClient),
        (sql) => sql<{ readonly seq: string }>`
          insert into activity (account_id, id, started_at)
          values ('user_c', '0190c1e2-0000-7000-8000-000000000003', now()) returning seq
        `,
      ),
    );
    expect(Number(next[0]?.seq)).toBe(4);

    // The restored database knows it is migrated, so the server starts on it as is.
    expect(await run(target, migrate)).toEqual([]);
  });

  it("refuses to restore into a database that already holds tables", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    const { file } = await Effect.runPromise(
      Effect.flatMap(Effect.service(Backups), (backups) => backups.takeNow).pipe(
        Effect.provide(backupsLayer(source, dir)),
      ),
    );

    const target = await newDatabase();
    await run(
      target,
      Effect.flatMap(Effect.service(SqlClient), (sql) => sql`create table keep_me (id int)`),
    );

    const exit = await Effect.runPromiseExit(
      restoreBackup(file, target).pipe(Effect.provide(PgTools.layer(postgres.tools))),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("not empty");
    const tables = await run(
      target,
      Effect.flatMap(
        Effect.service(SqlClient),
        (sql) =>
          sql`select table_name from information_schema.tables where table_schema = 'public'`,
      ),
    );
    expect(tables).toEqual([{ table_name: "keep_me" }]);
  });

  it("checks a backup restores in a scratch database and drops it after", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();

    const [good, broken] = await Effect.runPromise(
      Effect.gen(function* () {
        const backups = yield* Effect.service(Backups);
        const backup = yield* backups.takeNow;
        const passed = yield* backups.checkRestore(backup);
        yield* Effect.promise(() => writeFile(backup.file, "not a dump"));
        const failed = yield* backups.checkRestore(backup);
        return [passed, failed] as const;
      }).pipe(Effect.provide(backupsLayer(source, dir))),
    );

    // The seeded table and the migrations table come back.
    expect(good.tables).toBe(2);
    expect(broken.tables).toBeUndefined();
    expect(await scratchDatabases()).toEqual([]);
    expect((await snapshot(source)).rows).toHaveLength(3);
  });

  it("lets one backup run at a time across servers, and the others skip", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    // Both start in the same second, so they would pick the same backup name.
    const now = Date.parse("2026-11-14T03:00:00Z");
    const onServer = () =>
      Effect.runPromiseExit(takeNow.pipe(frozenAt(now), Effect.provide(backupsLayer(source, dir))));

    const exits = await Promise.all([onServer(), onServer()]);

    const written = exits.filter(Exit.isSuccess);
    const skipped = exits.filter(Exit.isFailure).map((exit) => String(exit.cause));
    expect(written).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("Backup skipped");
    expect(await readdir(dir)).toEqual([backupFileName(now)]);
    const check = await Effect.runPromise(
      Effect.flatMap(Effect.service(Backups), (backups) =>
        backups.checkRestore(written[0]!.value),
      ).pipe(Effect.provide(backupsLayer(source, dir))),
    );
    expect(check.tables).toBe(2);
  });

  it("never replaces a backup that already has the name", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    const now = Date.parse("2026-11-14T03:00:00Z");
    const existing = join(dir, backupFileName(now));
    await writeFile(existing, "a finished backup");

    const exit = await Effect.runPromiseExit(
      takeNow.pipe(frozenAt(now), Effect.provide(backupsLayer(source, dir))),
    );

    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("could not finish");
    expect(await readdir(dir)).toEqual([backupFileName(now)]);
    expect(await readFile(existing, "utf8")).toBe("a finished backup");
  });

  it("runs overlapping restore checks from several servers without touching each other", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    const backup = await Effect.runPromise(takeNow.pipe(Effect.provide(backupsLayer(source, dir))));
    const onServer = () =>
      Effect.runPromise(
        Effect.flatMap(Effect.service(Backups), (backups) => backups.checkRestore(backup)).pipe(
          Effect.provide(backupsLayer(source, dir)),
        ),
      );

    const checks = await Promise.all([onServer(), onServer(), onServer()]);

    expect(checks.map(({ tables }) => tables)).toEqual([2, 2, 2]);
    expect(await scratchDatabases()).toEqual([]);
  });

  it("drops the scratch database when a restore check is interrupted", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const backups = yield* Effect.service(Backups);
        const backup = yield* backups.takeNow;
        const fiber = yield* Effect.forkChild(backups.checkRestore(backup));
        const names = yield* untilScratch;
        yield* Fiber.interrupt(fiber);
        return names;
      }).pipe(Effect.provide(backupsLayer(source, dir))),
    );

    expect(seen).toHaveLength(1);
    expect(await scratchDatabases()).toEqual([]);
  });

  it("drops scratch databases older than a day on start and keeps younger ones", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    const crashed = restoreScratchName(Date.now() - 25 * HOUR, "aaaaaaaaaaaa");
    const running = restoreScratchName(Date.now() - HOUR, "bbbbbbbbbbbb");
    await postgres.createDatabase(crashed);
    await postgres.createDatabase(running);
    const layer = backupsLayer(source, dir);
    await Effect.runPromise(takeNow.pipe(Effect.provide(layer)));

    const check = await runNightly(
      layer,
      Effect.flatMap(Effect.service(Backups), (backups) => backups.lastRestoreCheck),
    );

    expect(check.tables).toBe(2);
    expect(await scratchDatabases()).toEqual([running]);
    await run(
      postgres.url("postgres"),
      Effect.flatMap(Effect.service(SqlClient), (sql) => sql.unsafe(`drop database ${running}`)),
    );
  });

  it("keeps an old scratch database that a running restore check still owns", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    const backup = await Effect.runPromise(takeNow.pipe(Effect.provide(backupsLayer(source, dir))));
    const gate = join(dir, "gate");
    const startedAt = Date.now() - 25 * HOUR;

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          checkRestore(backup.file, source).pipe(
            frozenAt(startedAt),
            Effect.provide(PgTools.layer(restoreAfter(gate))),
          ),
        );
        const owned = yield* untilScratch;
        const dropped = yield* dropStaleRestoreDatabases(source);
        const left = yield* Effect.promise(scratchDatabases);
        yield* Effect.promise(() => writeFile(gate, ""));
        const tables = yield* Fiber.join(fiber);
        return { owned, dropped, left, tables };
      }),
    );

    expect(seen.owned).toHaveLength(1);
    expect(seen.owned[0]).toMatch(new RegExp(`^svett_restore_${startedAt}_[0-9a-f]{12}$`));
    expect(seen.dropped).toEqual([]);
    expect(seen.left).toEqual(seen.owned);
    expect(seen.tables).toBe(2);
    expect(await scratchDatabases()).toEqual([]);
  });

  it("drops an old scratch database that no restore check owns", async () => {
    const source = await newDatabase();
    const crashed = restoreScratchName(Date.now() - 25 * HOUR, "cccccccccccc");
    await postgres.createDatabase(crashed);

    const dropped = await Effect.runPromise(dropStaleRestoreDatabases(source));

    expect(dropped).toEqual([crashed]);
    expect(await scratchDatabases()).toEqual([]);
  });

  it("stops a restore check that runs too long and drops its scratch database", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    const backup = await Effect.runPromise(takeNow.pipe(Effect.provide(backupsLayer(source, dir))));

    const { seen, exit } = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          checkRestore(backup.file, source, Duration.seconds(2)).pipe(
            Effect.provide(PgTools.layer(restoreAfter(join(dir, "never")))),
          ),
        );
        return { seen: yield* untilScratch, exit: yield* Fiber.await(fiber) };
      }),
    );

    expect(seen).toHaveLength(1);
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("took longer than 2s");
    expect(await scratchDatabases()).toEqual([]);
  });

  it("leaves no backup file behind when the dump fails", async () => {
    const source = await newDatabase();
    const dir = await tempDir();
    await writeFile(join(dir, "README"), "not a backup\n");
    const exit = await Effect.runPromiseExit(
      takeNow.pipe(
        Effect.provide(
          backupsLayer(source, dir, {
            tools: { ...postgres.tools, pgDump: ["sh", "-c", "echo half a dump; exit 3", "sh"] },
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("exited with 3");
    expect(await readdir(dir)).toEqual(["README"]);
  });

  it("says why it could not reach the database", async () => {
    const dir = await tempDir();
    const exit = await Effect.runPromiseExit(
      takeNow.pipe(Effect.provide(backupsLayer(postgres.url("missing_database"), dir))),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("missing_database");
    expect(await readdir(dir)).toEqual([]);
  });

  it("backs up at once on start when the newest is old, then on every tick, keeping the newest", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    const old = "svett-20261101T030000Z.dump";
    await writeFile(join(dir, old), "an old backup");

    // Every two seconds instead of nightly, so the test sees several runs.
    const layer = backupsLayer(source, dir, { backupKeep: 3, backupCron: "*/2 * * * * *" });
    const check = await runNightly(
      layer,
      Effect.gen(function* () {
        const names = yield* Effect.promise(() => readdir(dir));
        const backups = yield* Effect.service(Backups);
        const last = yield* backups.lastRestoreCheck;
        return names.length === 3 && !names.includes(old) ? last : undefined;
      }),
    );

    const names = (await readdir(dir)).toSorted();
    expect(names).toHaveLength(3);
    expect(names.every((name) => /^svett-\d{8}T\d{6}Z\.dump$/.test(name))).toBe(true);
    // Each new backup is checked by a restore, which brings back both tables.
    expect(check.tables).toBe(2);
  });

  it("only checks the newest backup on start when it is less than a day old", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    const layer = backupsLayer(source, dir);
    const taken = await Effect.runPromise(
      Effect.flatMap(Effect.service(Backups), (backups) => backups.takeNow).pipe(
        Effect.provide(layer),
      ),
    );

    const check = await runNightly(
      layer,
      Effect.flatMap(Effect.service(Backups), (backups) => backups.lastRestoreCheck),
    );

    expect(check).toMatchObject({ backupTakenAt: taken.takenAt, tables: 2 });
    expect(await readdir(dir)).toEqual([taken.file.split("/").pop()]);
    await rm(dir, { recursive: true });
  });
});
