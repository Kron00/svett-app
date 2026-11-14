import { randomBytes } from "node:crypto";

import { restoreScratchName, staleRestoreScratches } from "@svett/core";
import { Clock, Data, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { databaseLayer, isEmptyDatabase } from "./database.ts";
import { PgTools } from "./pg-tools.ts";

export class RestoreError extends Data.TaggedError("RestoreError")<{
  readonly message: string;
}> {}

/**
 * Loads a backup into the database at `target`. It refuses a database that already
 * holds tables, so a restore can never merge into or overwrite live data.
 */
export const restoreBackup = (file: string, target: Redacted.Redacted) =>
  Effect.gen(function* () {
    const empty = yield* isEmptyDatabase.pipe(Effect.provide(databaseLayer(target)));
    if (!empty) {
      return yield* new RestoreError({
        message: "The target database is not empty. Restore into a new, empty database.",
      });
    }
    const tools = yield* PgTools;
    yield* tools.restore(target, file);
  });

const onDatabase = (url: Redacted.Redacted, name: string) => {
  const parsed = new URL(Redacted.value(url));
  parsed.pathname = `/${name}`;
  return Redacted.make(parsed.toString());
};

const onLive = <A>(
  live: Redacted.Redacted,
  query: (sql: SqlClient) => Effect.Effect<A, SqlError>,
) => Effect.flatMap(Effect.service(SqlClient), query).pipe(Effect.provide(databaseLayer(live)));

const dropDatabase = (live: Redacted.Redacted, name: string) =>
  onLive(live, (sql) => sql.unsafe(`drop database if exists ${name} with (force)`));

const countTables = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ readonly tables: number }>`
    select count(*)::int as tables from information_schema.tables
    where table_schema not in ('pg_catalog', 'information_schema')
  `;
  return rows[0]?.tables ?? 0;
});

/**
 * Proves a backup restores by loading it into a new, empty scratch database on the
 * same server as `live`. Returns how many tables came back. Each check gets its own
 * scratch database, dropped on every way out, so checks on several servers never
 * touch each other's.
 */
export const checkRestore = (file: string, live: Redacted.Redacted) =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = yield* Effect.sync(() => randomBytes(6).toString("hex"));
      const name = restoreScratchName(yield* Clock.currentTimeMillis, suffix);
      yield* Effect.acquireRelease(
        onLive(live, (sql) => sql.unsafe(`create database ${name}`)),
        () => Effect.ignore(dropDatabase(live, name)),
      );
      const target = onDatabase(live, name);
      yield* restoreBackup(file, target);
      return yield* countTables.pipe(Effect.provide(databaseLayer(target)));
    }),
  );

/** Drops the scratch databases that checks which crashed more than a day ago left behind. */
export const dropStaleRestoreDatabases = (live: Redacted.Redacted) =>
  Effect.gen(function* () {
    const rows = yield* onLive(
      live,
      (sql) => sql<{ readonly datname: string }>`select datname from pg_database`,
    );
    const stale = staleRestoreScratches(
      rows.map(({ datname }) => datname),
      yield* Clock.currentTimeMillis,
    );
    yield* Effect.forEach(stale, (name) => dropDatabase(live, name), { discard: true });
    return stale;
  });
