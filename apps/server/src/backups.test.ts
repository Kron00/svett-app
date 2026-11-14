import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manualClock } from "@svett/core/node";
import { Effect, Exit, Fiber, Layer, type Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { Backups, NightlyBackups } from "./backups.ts";
import { ServerConfig } from "./config.ts";
import { databaseLayer, migrate } from "./database.ts";
import { PgTools } from "./pg-tools.ts";
import { restoreBackup } from "./restore.ts";
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

const backupsLayer = (
  url: Redacted.Redacted,
  backupDir: string,
  options: { readonly backupKeep?: number } = {},
) =>
  Backups.layer.pipe(
    Layer.provideMerge(PgTools.layer(postgres.tools)),
    Layer.provideMerge(
      Layer.succeed(
        ServerConfig,
        ServerConfig.of({
          port: 0,
          databaseUrl: url,
          backupDir,
          backupKeep: options.backupKeep ?? 14,
          backupCron: "0 3 * * *",
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

  it("leaves no backup file behind when the dump fails", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "README"), "not a backup\n");
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Effect.service(Backups), (backups) => backups.takeNow).pipe(
        Effect.provide(backupsLayer(postgres.url("missing_database"), dir)),
      ),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("missing_database");
    expect(await readdir(dir)).toEqual(["README"]);
  });

  it("backs up at once on start, then every night at 03:00 UTC, keeping the newest", async () => {
    const source = await newDatabase();
    await seed(source);
    const dir = await tempDir();
    await writeFile(join(dir, "svett-20261101T030000Z.dump"), "an old backup");
    const clock = manualClock(Date.parse("2026-11-13T21:15:42Z"));

    const expected = [
      "svett-20261113T211542Z.dump",
      "svett-20261114T030000Z.dump",
      "svett-20261115T030000Z.dump",
      "svett-20261116T030000Z.dump",
      "svett-20261117T030000Z.dump",
    ];
    const finished = async () => {
      const names = await readdir(dir);
      return names.includes(expected[2]!) && !names.includes("svett-20261101T030000Z.dump");
    };

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Layer.launch(NightlyBackups));
      const deadline = Date.now() + 60_000;
      // Each turn of the nightly loop moves the manual clock on to the next 03:00 at once.
      while (!(yield* Effect.promise(finished)) && Date.now() < deadline) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      }
      yield* Fiber.interrupt(fiber);
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(backupsLayer(source, dir, { backupKeep: 3 })),
        Effect.provide(clock.layer),
      ),
    );

    // The loop may finish one more night before it stops, but the files left are
    // always the newest three nights in a row, with no partial dump among them.
    const names = (await readdir(dir)).toSorted();
    const first = expected.indexOf(names[0]!);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(names).toEqual(expected.slice(first, first + 3));
    await rm(dir, { recursive: true });
  });
});
