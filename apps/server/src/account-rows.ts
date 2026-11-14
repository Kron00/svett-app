import { PgClient } from "@effect/sql-pg";
import {
  type AccountId,
  type CheckedRow,
  checkSyncRow,
  deletedAboveOf,
  deletionMatters,
  isPublished,
  isTooFarAhead,
  MAX_SYNC_ROWS,
  mergeChange,
  mergeRow,
  type RowCopy,
  type SyncedTable,
  type SyncPull,
  type SyncPush,
  type SyncPushResult,
} from "@svett/core";
import { Context, Data, Effect, Layer } from "effect";
import type { SqlError } from "effect/sql/SqlError";

export class InvalidRow extends Data.TaggedError("InvalidRow")<{
  readonly table: string;
  readonly index: number;
  readonly message: string;
}> {}

/** Checks each row against its table's schema, as the phone's own database would. */
export const checkRows = (push: SyncPush) =>
  Effect.forEach(push.rows, ({ table, row }, index) =>
    checkSyncRow(table, row).pipe(
      Effect.mapError((invalid) => new InvalidRow({ table, index, message: invalid.message })),
    ),
  );

const key = (table: string, id: string) => `${table}/${id}`;

export interface AccountRowsShape {
  /** Records that the account exists. Safe to call on every request. */
  readonly ensureAccount: (account: AccountId) => Effect.Effect<void, SqlError>;
  /**
   * Stores `rows` under `account` by the sync merge rule with deletes, and gives each row it
   * applies the account's next change number. When it drops an edit to a row under a deleted
   * workout, the deleted copy it keeps gets the next number too, so the phone that made the
   * edit pulls that copy again. A row another account holds under the same ID is a different
   * row and stays as it was. Rows timed too far past `nowMillis` are refused.
   */
  readonly write: (
    account: AccountId,
    rows: ReadonlyArray<CheckedRow>,
    nowMillis: number,
  ) => Effect.Effect<SyncPushResult, SqlError>;
  /** Up to `limit` of the account's rows with a change number after `after`, in order. */
  readonly changes: (
    account: AccountId,
    after: number,
    limit?: number,
  ) => Effect.Effect<SyncPull, SqlError>;
}

export class AccountRows extends Context.Service<AccountRows, AccountRowsShape>()(
  "svett/server/AccountRows",
) {
  static readonly layer: Layer.Layer<AccountRows, never, PgClient.PgClient> = Layer.effect(
    AccountRows,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const ensureAccount = (account: AccountId) =>
        Effect.asVoid(sql`insert into account (id) values (${account}) on conflict do nothing`);
      return AccountRows.of({
        ensureAccount,
        write: (account, rows, nowMillis) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* ensureAccount(account);
              // Holding the account's row until commit applies its writes one at a time, so
              // change numbers commit in order and a pull never skips one.
              const [locked] = yield* sql<{ readonly nextSeq: string }>`
                select next_seq as "nextSeq" from account where id = ${account} for update
              `;
              let seq = Number(locked?.nextSeq ?? 0);
              const ahead = rows.filter((row) => isTooFarAhead(row.updatedAt, nowMillis));
              const timely = rows.filter((row) => !isTooFarAhead(row.updatedAt, nowMillis));
              const stored = new Map<string, RowCopy>();
              if (timely.length > 0) {
                const existing = yield* sql<{
                  readonly tableName: string;
                  readonly rowId: string;
                  readonly updatedAt: string;
                  readonly deletedAt: string | null;
                  readonly changeId: string;
                }>`
                  select table_name as "tableName", row_id as "rowId",
                    updated_at as "updatedAt", deleted_at as "deletedAt", change_id as "changeId"
                  from account_row
                  where account_id = ${account}
                    and row_id in ${sql.in([...new Set(timely.map((row) => row.id))])}
                `;
                for (const row of existing) {
                  stored.set(key(row.tableName, row.rowId), {
                    updatedAt: Number(row.updatedAt),
                    deletedAt: row.deletedAt === null ? null : Number(row.deletedAt),
                    changeId: row.changeId,
                  });
                }
              }
              const lookup = (table: SyncedTable, id: string) =>
                Effect.map(
                  sql<{ readonly data: Readonly<Record<string, unknown>> }>`
                    select data from account_row
                    where account_id = ${account} and table_name = ${table} and row_id = ${id}
                  `,
                  ([row]) => row?.data,
                );
              for (const row of timely) {
                const current = stored.get(key(row.table, row.id));
                const deletedAbove = deletionMatters(current, row)
                  ? yield* deletedAboveOf(
                      row.table,
                      row.encoded as Readonly<Record<string, unknown>>,
                      lookup,
                    )
                  : null;
                if (mergeChange(current, row, deletedAbove) === "keep") {
                  if (mergeRow(current, row) === "take") {
                    seq++;
                    yield* sql`
                      update account_row set seq = ${seq}
                      where account_id = ${account} and table_name = ${row.table}
                        and row_id = ${row.id}
                    `;
                  }
                  continue;
                }
                seq++;
                yield* sql`
                  insert into account_row
                    (account_id, table_name, row_id, updated_at, deleted_at, data, seq, change_id)
                  values
                    (${account}, ${row.table}, ${row.id}, ${row.updatedAt}, ${row.deletedAt},
                     ${sql.json(row.encoded)}, ${seq}, ${row.changeId})
                  on conflict (account_id, table_name, row_id) do update set
                    updated_at = excluded.updated_at,
                    deleted_at = excluded.deleted_at,
                    data = excluded.data,
                    seq = excluded.seq,
                    change_id = excluded.change_id
                `;
                // The feed orders posts by when each first reached it, never by when it started,
                // as a start time may be hidden. A workout in progress has not reached it yet.
                if (
                  row.table === "activity" &&
                  row.deletedAt === null &&
                  isPublished(row.encoded)
                ) {
                  yield* sql`
                    insert into activity_social (account_id, activity_id, shared_ms)
                    values (${account}, ${row.id}, ${nowMillis})
                    on conflict (account_id, activity_id) do update
                      set shared_ms = excluded.shared_ms
                      where activity_social.shared_ms is null
                  `;
                }
                stored.set(key(row.table, row.id), row);
              }
              yield* sql`update account set next_seq = ${seq} where id = ${account}`;
              return {
                stored: timely.length,
                ahead: ahead.map(({ table, id }) => ({ table, id })),
                serverMillis: nowMillis,
              };
            }),
          ),
        changes: (account, after, limit = MAX_SYNC_ROWS) =>
          sql<{ readonly seq: string; readonly tableName: SyncedTable; readonly data: unknown }>`
            select seq, table_name as "tableName", data from account_row
            where account_id = ${account} and seq > ${after}
            order by seq
            limit ${limit + 1}
          `.pipe(
            Effect.map((found): SyncPull => {
              const page = found.slice(0, limit);
              return {
                rows: page.map(({ seq, tableName, data }) => ({
                  seq: Number(seq),
                  table: tableName,
                  row: data,
                })),
                next: page.length === 0 ? after : Number(page[page.length - 1]?.seq),
                more: found.length > limit,
              };
            }),
          ),
      });
    }),
  );
}
