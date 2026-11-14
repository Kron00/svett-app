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
  // Each applied change gets the account's next number, so a phone pulls from where it left
  // off. A row's change ID breaks a tie between two changes with the same time.
  "2_sync": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`alter table account add column next_seq bigint not null default 0`;
    yield* sql`alter table account_row add column seq bigint`;
    yield* sql`alter table account_row add column change_id text not null default ''`;
    yield* sql`
      update account_row set seq = numbered.seq
      from (
        select account_id, table_name, row_id,
          row_number() over (partition by account_id order by updated_at, table_name, row_id) as seq
        from account_row
      ) as numbered
      where account_row.account_id = numbered.account_id
        and account_row.table_name = numbered.table_name
        and account_row.row_id = numbered.row_id
    `;
    yield* sql`
      update account set next_seq = coalesce(
        (select max(seq) from account_row where account_id = account.id), 0)
    `;
    yield* sql`alter table account_row alter column seq set not null`;
    yield* sql`create unique index account_row_seq on account_row (account_id, seq)`;
  }),
};
