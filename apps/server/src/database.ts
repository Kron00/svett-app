import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, type Redacted } from "effect";
import * as Migrator from "effect/sql/Migrator";
import { SqlClient } from "effect/sql/SqlClient";

import { ServerConfig } from "./config.ts";
import { MIGRATIONS } from "./migrations.ts";

export const databaseLayer = (url: Redacted.Redacted) =>
  PgClient.layer({ url, applicationName: "svett-server" });

/** The server's database, from DATABASE_URL, migrated to the newest schema. */
export const Database = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ databaseUrl }) => databaseLayer(databaseUrl)),
);

export const migrate = Migrator.make({})({ loader: Migrator.fromRecord(MIGRATIONS) });

/** True when the database holds no tables, views or sequences of its own. */
export const isEmptyDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ readonly relations: number }>`
    select count(*)::int as relations
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg\\_toast%'
      and n.nspname not like 'pg\\_temp%'
  `;
  return rows[0]?.relations === 0;
});
