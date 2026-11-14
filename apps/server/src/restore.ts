import { randomBytes } from "node:crypto";

import { restoreScratchName, staleRestoreScratches } from "@svett/core";
import { Clock, Data, Duration, Effect, Option, Redacted } from "effect";
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

/** The advisory lock class of restore scratch databases. Each one's key is its name's hash. */
const SCRATCH_LOCK_CLASS = 0x7376;

/** How long a restore check may run before it gives up and drops its scratch database. */
export const RESTORE_CHECK_TIMEOUT = Duration.hours(6);

/**
 * Runs `effect` while this session holds the ownership lock of scratch database `name`
 * on a connection of its own, so the lock ends with that connection even if the
 * unlock never runs. Gives None without running it when another session holds it.
 */
const owningScratch = <A, E, R>(
  live: Redacted.Redacted,
  name: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const connection = yield* sql.reserve;
      const held = yield* Effect.acquireRelease(
        Effect.map(
          connection.executeUnprepared(
            "select pg_try_advisory_lock($1::int, hashtext($2)) as locked",
            [SCRATCH_LOCK_CLASS, name],
            undefined,
          ),
          (rows) => rows[0]?.locked === true,
        ),
        (locked) =>
          locked
            ? Effect.ignore(
                connection.executeUnprepared(
                  "select pg_advisory_unlock($1::int, hashtext($2))",
                  [SCRATCH_LOCK_CLASS, name],
                  undefined,
                ),
              )
            : Effect.void,
      );
      return held ? Option.some(yield* effect) : Option.none<A>();
    }),
  ).pipe(Effect.provide(databaseLayer(live)));

/**
 * Proves a backup restores by loading it into a new, empty scratch database on the
 * same server as `live`. Returns how many tables came back. Each check gets its own
 * scratch database and holds its ownership lock until the database is dropped, on
 * every way out. A check that runs past `timeout` stops and drops its database.
 */
export const checkRestore = (
  file: string,
  live: Redacted.Redacted,
  timeout: Duration.Duration = RESTORE_CHECK_TIMEOUT,
) =>
  Effect.gen(function* () {
    const suffix = yield* Effect.sync(() => randomBytes(6).toString("hex"));
    const name = restoreScratchName(yield* Clock.currentTimeMillis, suffix);
    const restored = yield* owningScratch(
      live,
      name,
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            onLive(live, (sql) => sql.unsafe(`create database ${name}`)),
            () => Effect.ignore(dropDatabase(live, name)),
          );
          const target = onDatabase(live, name);
          yield* restoreBackup(file, target);
          return yield* countTables.pipe(Effect.provide(databaseLayer(target)));
        }),
      ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new RestoreError({
              message: `The restore check took longer than ${Duration.format(timeout)}.`,
            }),
          ),
      }),
    );
    if (Option.isNone(restored)) {
      return yield* new RestoreError({ message: `Another session owns ${name}.` });
    }
    return restored.value;
  });

/**
 * Drops the scratch databases more than a day old that no running check owns, which
 * checks that crashed left behind. It holds each one's ownership lock while it drops
 * it, and skips any whose lock another session holds.
 */
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
    const dropped = yield* Effect.forEach(stale, (name) =>
      owningScratch(live, name, dropDatabase(live, name)).pipe(Effect.map(Option.map(() => name))),
    );
    return dropped.flatMap(Option.toArray);
  });
