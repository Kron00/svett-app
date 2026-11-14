import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The server's schema changes, keyed `<id>_<name>`. Append new ones with the next id.
 * Never edit one that has shipped.
 */
export const MIGRATIONS: Record<string, Effect.Effect<void, unknown, SqlClient>> = {
  // Rows are keyed by account and ID together, so two accounts that hold the same ID,
  // such as the same imported Hevy workout, each keep their own row.
  "1_accounts": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      create table account (
        id text primary key,
        created_at timestamptz not null default now()
      )
    `;
    yield* sql`
      create table account_row (
        account_id text not null,
        table_name text not null,
        row_id text not null,
        updated_at bigint not null,
        deleted_at bigint,
        data jsonb not null,
        primary key (account_id, table_name, row_id)
      )
    `;
  }),
};
