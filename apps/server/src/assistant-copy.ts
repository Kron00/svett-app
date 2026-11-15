import { randomFillSync } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  type AccountId,
  checkSyncRow,
  databaseLayer,
  Ids,
  SyncedTable,
  SyncRepository,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, Option, Schema } from "effect";

const isSynced = Schema.is(SyncedTable);

/** What runs against an account's copy: every repository of a svett database. */
export type CopyServices = Layer.Success<ReturnType<typeof databaseLayer>>;

/**
 * Runs `effect` against a new in-memory svett database that holds the account's own rows, as
 * a phone signed in to it holds them after a full sync, so the tools the coach uses on the
 * phone read the same data here. Nothing else enters it, no other account's rows and no
 * follows, likes or feed, so a tool can only ever read what the account owns. The copy is
 * thrown away afterwards, and a write to it changes nothing on the server.
 */
export const withAccountCopy = <A, E>(
  account: AccountId,
  effect: Effect.Effect<A, E, CopyServices>,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const stored = yield* sql<{ readonly tableName: string; readonly data: unknown }>`
      select table_name as "tableName", data from account_row
      where account_id = ${account}
      order by seq, table_name, row_id
    `;
    const rows = yield* Effect.forEach(stored, ({ tableName, data }) =>
      isSynced(tableName)
        ? Effect.map(Effect.option(checkSyncRow(tableName, data)), Option.toArray)
        : Effect.succeed([]),
    );
    const { database, driver } = openNodeDatabase();
    const copy = databaseLayer(
      driver,
      Ids.layer((bytes) => {
        randomFillSync(bytes);
      }),
    );
    // A copy that will not open or take the account's rows is a bug, never the caller's doing.
    return yield* Effect.gen(function* () {
      yield* Effect.orDie((yield* SyncRepository).apply(rows.flat(), 0));
      return yield* effect;
    }).pipe(
      Effect.provide(Layer.orDie(copy)),
      Effect.ensuring(Effect.sync(() => database.close())),
    );
  });
