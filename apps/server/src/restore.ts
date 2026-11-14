import { Data, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

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

/** The scratch database the restore check creates next to the live one and drops after. */
export const RESTORE_CHECK_DATABASE = "svett_restore_check";

const onDatabase = (url: Redacted.Redacted, name: string) => {
  const parsed = new URL(Redacted.value(url));
  parsed.pathname = `/${name}`;
  return Redacted.make(parsed.toString());
};

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
 * same server as `live`. Returns how many tables came back. The scratch database is
 * dropped afterwards, whether the restore worked or not.
 */
export const checkRestore = (file: string, live: Redacted.Redacted) =>
  Effect.gen(function* () {
    const onLive = (statement: string) =>
      Effect.flatMap(Effect.service(SqlClient), (sql) => sql.unsafe(statement)).pipe(
        Effect.provide(databaseLayer(live)),
      );
    const drop = onLive(`drop database if exists ${RESTORE_CHECK_DATABASE} with (force)`);
    yield* drop;
    yield* onLive(`create database ${RESTORE_CHECK_DATABASE}`);
    const target = onDatabase(live, RESTORE_CHECK_DATABASE);
    return yield* restoreBackup(file, target).pipe(
      Effect.andThen(countTables.pipe(Effect.provide(databaseLayer(target)))),
      Effect.ensuring(Effect.ignore(drop)),
    );
  });
