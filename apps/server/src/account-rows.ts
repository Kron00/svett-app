import { PgClient } from "@effect/sql-pg";
import {
  type AccountId,
  type CheckedRow,
  changeIdOf,
  checkSyncRow,
  childTablesOf,
  type DeletionSpan,
  deletionSpansAboveOf,
  deletionToJoin,
  DRAFT_MESSAGE,
  inDraftWorkout,
  isPublished,
  isShared,
  isTooFarAhead,
  MAX_SYNC_ROWS,
  mergePushed,
  needsDeletionsAbove,
  type Restoration,
  restoredAfter,
  type ServerCopy,
  type SyncedTable,
  type SyncPull,
  type SyncPush,
  type SyncPushResult,
  WORKOUT_TABLES,
} from "@svett/core";
import { Context, Data, Effect, Layer } from "effect";
import type { SqlError } from "effect/sql/SqlError";

export class InvalidRow extends Data.TaggedError("InvalidRow")<{
  readonly table: string;
  readonly index: number;
  readonly message: string;
}> {}

const key = (table: string, id: string) => `${table}/${id}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks each row against its table's schema, as the phone's own database would. A workout in
 * progress stays on its phone, so this refuses one, and every row the push puts under one,
 * whatever their order. The server never stores a workout in progress, so a row whose
 * workout it already holds is never under one.
 */
export const checkRows = (push: SyncPush) =>
  Effect.gen(function* () {
    const pushed = new Map(
      push.rows.flatMap(({ table, row }) =>
        isRecord(row) && typeof row["id"] === "string" ? [[key(table, row["id"]), row]] : [],
      ),
    );
    const lookup = (table: SyncedTable, id: string) => Effect.succeed(pushed.get(key(table, id)));
    for (const [index, { table, row }] of push.rows.entries()) {
      if (isRecord(row) && (yield* inDraftWorkout(table, row, lookup))) {
        return yield* new InvalidRow({ table, index, message: DRAFT_MESSAGE });
      }
    }
    return yield* Effect.forEach(push.rows, ({ table, row, restores }, index) =>
      checkSyncRow(table, row).pipe(
        Effect.map((checked): CheckedPush => ({ ...checked, restores: restores ?? [] })),
        Effect.mapError((invalid) => new InvalidRow({ table, index, message: invalid.message })),
      ),
    );
  });

/** A pushed row checked against its table, with the deletions it reverses when it is an Undo. */
export interface CheckedPush extends CheckedRow {
  readonly restores: ReadonlyArray<number>;
}

/** `row` deleted at `at`, as a delete that took it with it would leave it. */
const deletedCopy = (row: CheckedRow, at: number): CheckedRow => {
  const encoded = {
    ...(row.encoded as Readonly<Record<string, unknown>>),
    updatedAt: at,
    deletedAt: at,
  };
  return {
    ...row,
    updatedAt: at,
    deletedAt: at,
    encoded,
    changeId: changeIdOf(row.table, encoded),
  };
};

/**
 * The deleted copy the server keeps of a change it drops, such as a row added under a deleted
 * row, so the phone that made it removes it too. It takes the row's own time, never the time
 * of a deletion above it, so an Undo of that deletion leaves it deleted.
 */
const droppedCopy = (row: CheckedRow, deletions: ReadonlySet<number>): CheckedRow => {
  let at = row.updatedAt;
  while (deletions.has(at)) at++;
  return deletedCopy(row, at);
};

const deletionTimes = (spans: ReadonlyArray<DeletionSpan>) =>
  new Set(spans.map(({ deletedAt }) => deletedAt));

export interface AccountRowsShape {
  /** Records that the account exists. Safe to call on every request. */
  readonly ensureAccount: (account: AccountId) => Effect.Effect<void, SqlError>;
  /**
   * Stores `rows` under `account` by `mergePushed`, and gives each row it applies the
   * account's next change number. When it refuses a change, such as an edit to a deleted
   * workout from a phone that had not seen the delete, the copy it keeps gets the next number
   * too, so that phone pulls it again. A row it refuses to add under a deleted row is kept as
   * a deleted copy, for the same reason. Either way the change counts as stored, so the phone
   * stops sending it. A workout row timed before a deletion above it is kept deleted with
   * that deletion, and a delete of a workout row also deletes each live row it holds that the
   * push did not, as the phone's delete would have. One changed after the delete is a dropped
   * change and stays deleted after Undo. A row another account holds under the same ID is a
   * different row and stays as it was. Rows timed too far past `nowMillis` are refused.
   */
  readonly write: (
    account: AccountId,
    rows: ReadonlyArray<CheckedPush>,
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
              const stored = new Map<string, ServerCopy>();
              if (timely.length > 0) {
                const existing = yield* sql<{
                  readonly tableName: string;
                  readonly rowId: string;
                  readonly updatedAt: string;
                  readonly deletedAt: string | null;
                  readonly changeId: string;
                  readonly restored: ReadonlyArray<Restoration>;
                }>`
                  select table_name as "tableName", row_id as "rowId",
                    updated_at as "updatedAt", deleted_at as "deletedAt",
                    change_id as "changeId", restored
                  from account_row
                  where account_id = ${account}
                    and row_id in ${sql.in([...new Set(timely.map((row) => row.id))])}
                `;
                for (const row of existing) {
                  stored.set(key(row.tableName, row.rowId), {
                    updatedAt: Number(row.updatedAt),
                    deletedAt: row.deletedAt === null ? null : Number(row.deletedAt),
                    changeId: row.changeId,
                    restored: row.restored,
                  });
                }
              }
              const lookup = (table: SyncedTable, id: string) =>
                Effect.map(
                  sql<{
                    readonly data: Readonly<Record<string, unknown>>;
                    readonly restored: ReadonlyArray<Restoration>;
                  }>`
                    select data, restored from account_row
                    where account_id = ${account} and table_name = ${table} and row_id = ${id}
                  `,
                  ([row]) => row && { row: row.data, restored: row.restored },
                );
              const save = (row: CheckedRow, restored: ReadonlyArray<Restoration>) => {
                seq++;
                stored.set(key(row.table, row.id), { ...row, restored });
                const saved = sql`
                  insert into account_row
                    (account_id, table_name, row_id, updated_at, deleted_at, data, seq, change_id,
                     restored)
                  values
                    (${account}, ${row.table}, ${row.id}, ${row.updatedAt}, ${row.deletedAt},
                     ${sql.json(row.encoded)}, ${seq}, ${row.changeId}, ${sql.json(restored)})
                  on conflict (account_id, table_name, row_id) do update set
                    updated_at = excluded.updated_at,
                    deleted_at = excluded.deleted_at,
                    data = excluded.data,
                    seq = excluded.seq,
                    change_id = excluded.change_id,
                    restored = excluded.restored
                `;
                // Each published activity gets its social ID here. The feed orders posts by
                // when each was first shared with anyone, never by when it started, as a start
                // time may be hidden. An activity for only its owner, such as each one moved in
                // from the phone, is not shared until its audience changes. A delete leaves the
                // social row alone, so an Undo brings the post back with the same ID and place.
                if (
                  row.table !== "activity" ||
                  row.deletedAt !== null ||
                  !isPublished(row.encoded)
                ) {
                  return Effect.asVoid(saved);
                }
                const sharedMs = isShared(row.encoded) ? nowMillis : null;
                return Effect.andThen(
                  saved,
                  sql`
                    insert into activity_social (account_id, activity_id, shared_ms)
                    values (${account}, ${row.id}, ${sharedMs})
                    on conflict (account_id, activity_id) do update
                      set shared_ms = excluded.shared_ms
                      where activity_social.shared_ms is null and excluded.shared_ms is not null
                  `,
                ).pipe(Effect.asVoid);
              };
              /**
               * Deletes each live row under `table`/`id` as the phone's delete at `deletedAt`
               * would have: one changed before it with it, and one changed at or after it as a
               * dropped change. `deletions` holds the deletion times above.
               */
              const deleteUnder = (
                table: SyncedTable,
                id: string,
                deletedAt: number,
                deletions: ReadonlySet<number>,
              ): Effect.Effect<void, SqlError> =>
                Effect.forEach(
                  childTablesOf(table),
                  (child) =>
                    Effect.flatMap(
                      sql<{
                        readonly rowId: string;
                        readonly data: Readonly<Record<string, unknown>>;
                        readonly updatedAt: string;
                        readonly deletedAt: string | null;
                        readonly changeId: string;
                        readonly restored: ReadonlyArray<Restoration>;
                      }>`
                        select row_id as "rowId", data, updated_at as "updatedAt",
                          deleted_at as "deletedAt", change_id as "changeId", restored
                        from account_row
                        where account_id = ${account} and table_name = ${child.table}
                          and data ->> ${sql.literal(`'${child.key}'`)} = ${id}
                        order by row_id
                      `,
                      (found) =>
                        Effect.forEach(
                          found,
                          (row) =>
                            Effect.gen(function* () {
                              const updatedAt = Number(row.updatedAt);
                              if (row.deletedAt === null) {
                                const checked: CheckedRow = {
                                  table: child.table,
                                  id: row.rowId,
                                  updatedAt,
                                  deletedAt: null,
                                  encoded: row.data,
                                  changeId: row.changeId,
                                };
                                yield* save(
                                  updatedAt < deletedAt
                                    ? deletedCopy(checked, deletedAt)
                                    : droppedCopy(checked, deletions),
                                  row.restored,
                                );
                              }
                              const below =
                                row.deletedAt === null
                                  ? deletions
                                  : new Set([...deletions, Number(row.deletedAt)]);
                              yield* deleteUnder(child.table, row.rowId, deletedAt, below);
                            }),
                          { discard: true },
                        ),
                    ),
                  { discard: true },
                );
              const deleted: Array<{
                readonly table: SyncedTable;
                readonly id: string;
                readonly deletedAt: number;
                readonly above: ReadonlyArray<DeletionSpan>;
              }> = [];
              for (const pushed of timely) {
                const current = stored.get(key(pushed.table, pushed.id));
                const above = needsDeletionsAbove(pushed.table, current, pushed)
                  ? yield* deletionSpansAboveOf(
                      pushed.table,
                      pushed.encoded as Readonly<Record<string, unknown>>,
                      lookup,
                    )
                  : [];
                const merged = mergePushed(pushed.table, current, pushed, pushed.restores, above);
                if (merged === "keep") continue;
                if (merged === "refuse" && current !== undefined) {
                  seq++;
                  yield* sql`
                    update account_row set seq = ${seq}
                    where account_id = ${account} and table_name = ${pushed.table}
                      and row_id = ${pushed.id}
                  `;
                  continue;
                }
                if (merged === "refuse") {
                  yield* save(droppedCopy(pushed, deletionTimes(above)), []);
                  continue;
                }
                const workout = WORKOUT_TABLES.has(pushed.table);
                const joined = workout ? deletionToJoin(pushed, above) : null;
                const row = joined === null ? pushed : deletedCopy(pushed, joined);
                yield* save(
                  row,
                  workout
                    ? restoredAfter(current, row, pushed.restores)
                    : (current?.restored ?? []),
                );
                if (workout && row.deletedAt !== null) {
                  deleted.push({
                    table: row.table,
                    id: row.id,
                    deletedAt: row.deletedAt,
                    above,
                  });
                }
              }
              for (const { table, id, deletedAt, above } of deleted) {
                if (stored.get(key(table, id))?.deletedAt !== deletedAt) continue;
                const deletions = deletionTimes([...above, { deletedAt, restoredAt: null }]);
                yield* deleteUnder(table, id, deletedAt, deletions);
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
