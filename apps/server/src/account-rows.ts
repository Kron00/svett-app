import { PgClient } from "@effect/sql-pg";
import { type AccountId, TABLES } from "@svett/core";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

const TABLE_BY_NAME = new Map(Object.values(TABLES).map((table) => [table.name, table]));

export const TableName = Schema.Literals(Object.values(TABLES).map((table) => table.name));
export type TableName = typeof TableName.Type;

/** The most rows one request may write. */
export const MAX_ROWS_PER_WRITE = 500;

/**
 * A request that writes rows. Any owner it names is ignored: the server takes the owner from
 * the session.
 */
export const RowsWrite = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ table: TableName, row: Schema.Unknown })).check(
    Schema.isMaxLength(MAX_ROWS_PER_WRITE),
  ),
});
export type RowsWrite = typeof RowsWrite.Type;

export interface StoredRow {
  readonly table: TableName;
  readonly row: unknown;
}

/** One stored row, checked against its table's schema and in its stored form. */
interface CheckedRow {
  readonly table: TableName;
  readonly id: string;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
  readonly encoded: unknown;
}

export class InvalidRow extends Data.TaggedError("InvalidRow")<{
  readonly table: string;
  readonly index: number;
  readonly message: string;
}> {}

/** Checks each row against its table's schema, as the phone's own database would. */
export const checkRows = (write: RowsWrite) =>
  Effect.forEach(write.rows, ({ table, row }, index) => {
    const target = TABLE_BY_NAME.get(table);
    if (target === undefined) {
      return Effect.fail(new InvalidRow({ table, index, message: "Unknown table." }));
    }
    return Schema.decodeUnknownEffect(target.schema)(row).pipe(
      Effect.flatMap((decoded) =>
        Effect.map(Schema.encodeEffect(target.schema)(decoded), (encoded): CheckedRow => ({
          table,
          id: decoded.id,
          updatedAt: decoded.updatedAt,
          deletedAt: decoded.deletedAt,
          encoded,
        })),
      ),
      Effect.mapError((issue) => new InvalidRow({ table, index, message: issue.message })),
    );
  });

export interface AccountRowsShape {
  /** Records that the account exists. Safe to call on every request. */
  readonly ensureAccount: (account: AccountId) => Effect.Effect<void, SqlError>;
  /**
   * Stores `rows` under `account`. A row another account holds under the same ID is a
   * different row and stays as it was. An older copy never replaces a newer one.
   */
  readonly write: (
    account: AccountId,
    rows: ReadonlyArray<CheckedRow>,
  ) => Effect.Effect<void, SqlError>;
  /** Every row `account` holds, deleted ones included, and nobody else's. */
  readonly list: (account: AccountId) => Effect.Effect<ReadonlyArray<StoredRow>, SqlError>;
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
        write: (account, rows) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* ensureAccount(account);
              for (const row of rows) {
                yield* sql`
                  insert into account_row
                    (account_id, table_name, row_id, updated_at, deleted_at, data)
                  values
                    (${account}, ${row.table}, ${row.id}, ${row.updatedAt}, ${row.deletedAt},
                     ${sql.json(row.encoded)})
                  on conflict (account_id, table_name, row_id) do update set
                    updated_at = excluded.updated_at,
                    deleted_at = excluded.deleted_at,
                    data = excluded.data
                  where account_row.updated_at <= excluded.updated_at
                `;
              }
            }),
          ),
        list: (account) =>
          sql<{ readonly tableName: TableName; readonly data: unknown }>`
            select table_name as "tableName", data from account_row
            where account_id = ${account}
            order by table_name, row_id
          `.pipe(
            Effect.map((rows) =>
              rows.map(({ tableName, data }) => ({ table: tableName, row: data })),
            ),
          ),
      });
    }),
  );
}
