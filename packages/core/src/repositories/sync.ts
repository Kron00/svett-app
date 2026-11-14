import { Context, Effect, Layer } from "effect";

import { Sql, type SqlValue } from "../sql.ts";
import {
  type CheckedRow,
  checkSyncRow,
  MAX_SYNC_ROWS,
  mergeRow,
  SYNCED_TABLES,
  type SyncedTable,
  type SyncPull,
  type SyncPushResult,
} from "../sync.ts";
import { columnOf, NewestSeen } from "../table.ts";

const TABLE_BY_NAME = new Map(SYNCED_TABLES.map((table) => [table.name, table]));

/** A row this phone changed and the server has not confirmed yet. */
export interface QueuedRow {
  /** Goes up each time the row is queued again, so a stale confirmation leaves it queued. */
  readonly mark: number;
  readonly table: SyncedTable;
  readonly id: string;
  readonly row: unknown;
}

const tableOf = (name: string) => {
  const table = TABLE_BY_NAME.get(name as SyncedTable);
  if (table === undefined)
    throw new Error(`The sync queue names a table that does not sync: ${name}`);
  return table;
};

const makeSyncRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const newestSeen = yield* NewestSeen;

  const storedRows = (table: SyncedTable, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const target = tableOf(table);
      const rows = yield* sql.all(
        `SELECT ${target.keys.map(columnOf).join(", ")} FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      const checked = yield* Effect.forEach(rows, (row) =>
        checkSyncRow(
          table,
          Object.fromEntries(target.keys.map((key) => [key, row[columnOf(key)] ?? null])),
        ),
      );
      return new Map(checked.map((row) => [row.id, row]));
    });

  /** Up to `limit` queued rows after `after`, oldest change first, as the server takes them. */
  const queued = (after: QueuedRow | undefined, limit = MAX_SYNC_ROWS) =>
    Effect.gen(function* () {
      const entries = yield* sql.all(
        `SELECT table_name, row_id, mark FROM sync_outbox
         WHERE (mark, table_name, row_id) > (?, ?, ?)
         ORDER BY mark, table_name, row_id LIMIT ?`,
        [after?.mark ?? -1, after?.table ?? "", after?.id ?? "", limit],
      );
      const byTable = new Map<SyncedTable, Array<string>>();
      for (const entry of entries) {
        const table = entry["table_name"] as SyncedTable;
        byTable.set(table, [...(byTable.get(table) ?? []), String(entry["row_id"])]);
      }
      const stored = new Map<SyncedTable, Map<string, CheckedRow>>();
      for (const [table, ids] of byTable) stored.set(table, yield* storedRows(table, ids));
      return entries.flatMap((entry): Array<QueuedRow> => {
        const table = entry["table_name"] as SyncedTable;
        const row = stored.get(table)?.get(String(entry["row_id"]));
        return row === undefined
          ? []
          : [{ mark: Number(entry["mark"]), table, id: row.id, row: row.encoded }];
      });
    });

  /** Drops the rows the server confirmed, unless they changed again since they were read. */
  const confirm = (rows: ReadonlyArray<QueuedRow>) =>
    sql.transaction(
      Effect.forEach(
        rows,
        ({ table, id, mark }) =>
          sql.run("DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ? AND mark = ?", [
            table,
            id,
            mark,
          ]),
        { discard: true },
      ),
    );

  const state = Effect.map(
    sql.all("SELECT cursor, newest_seen FROM sync_state WHERE id = 1"),
    ([row]) => ({
      cursor: Number(row?.["cursor"] ?? 0),
      newestSeen: Number(row?.["newest_seen"] ?? 0),
    }),
  );

  /**
   * Saves a pulled page and the cursor after it in one transaction, so a pull cut short
   * resumes from the last page it saved. A row replaces the phone's copy only when it wins
   * the merge, and then the phone's own unsent change to it is dropped, since it lost.
   */
  const apply = (rows: ReadonlyArray<CheckedRow>, next: number) =>
    Effect.gen(function* () {
      const applied = yield* sql.transaction(
        Effect.gen(function* () {
          yield* sql.run("UPDATE sync_state SET quiet = 1 WHERE id = 1");
          let newest = 0;
          let taken = 0;
          for (const row of rows) {
            newest = Math.max(newest, row.updatedAt);
            const local = (yield* storedRows(row.table, [row.id])).get(row.id);
            if (mergeRow(local, row) === "keep") continue;
            const target = tableOf(row.table);
            const columns = target.keys.map(columnOf);
            const encoded = row.encoded as Record<string, SqlValue | undefined>;
            yield* sql.run(
              `INSERT INTO ${row.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
               ON CONFLICT (id) DO UPDATE SET ${columns
                 .filter((column) => column !== "id")
                 .map((column) => `${column} = excluded.${column}`)
                 .join(", ")}`,
              target.keys.map((key) => encoded[key] ?? null),
            );
            yield* sql.run("DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ?", [
              row.table,
              row.id,
            ]);
            taken++;
          }
          yield* sql.run(
            "UPDATE sync_state SET quiet = 0, cursor = ?, newest_seen = max(newest_seen, ?) WHERE id = 1",
            [next, newest],
          );
          return { newest, taken };
        }),
      );
      newestSeen.millis = Math.max(newestSeen.millis, applied.newest);
      return applied.taken;
    });

  return {
    /** Runs `effect` without queueing what it writes, as seeding the bundled library needs. */
    quietly: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.transaction(
        Effect.gen(function* () {
          yield* sql.run("UPDATE sync_state SET quiet = 1 WHERE id = 1");
          const result = yield* effect;
          yield* sql.run("UPDATE sync_state SET quiet = 0 WHERE id = 1");
          return result;
        }),
      ),
    queued,
    confirm,
    apply,
    /** The last `seq` this phone has fully saved, and the newest change it has applied. */
    state,
    /** How many changed rows wait to upload. */
    queuedCount: Effect.map(sql.all("SELECT count(*) AS n FROM sync_outbox"), ([row]) =>
      Number(row?.["n"] ?? 0),
    ),
    /** Reads the newest change applied before, so rows written now come after it. */
    loadNewestSeen: Effect.map(state, ({ newestSeen: millis }) => {
      newestSeen.millis = Math.max(newestSeen.millis, millis);
    }),
  };
});

export class SyncRepository extends Context.Service<
  SyncRepository,
  Effect.Success<typeof makeSyncRepository>
>()("svett/SyncRepository") {
  static readonly layer = Layer.effect(SyncRepository, makeSyncRepository);
}

/** Pushes and pulls a sync. Both sides are the server's HTTP API, or a stand-in in tests. */
export interface SyncApi<E> {
  readonly push: (
    rows: ReadonlyArray<{ readonly table: SyncedTable; readonly row: unknown }>,
  ) => Effect.Effect<SyncPushResult, E>;
  readonly pull: (after: number) => Effect.Effect<SyncPull, E>;
}

export interface SyncOutcome {
  readonly pushed: number;
  /** Rows the server refused because their time is too far ahead of its clock. */
  readonly held: number;
  readonly pulled: number;
}

/**
 * One sync: sends every queued row, then saves every row the server applied since the last
 * pull. Running it again after a failure part way converges to the same state.
 */
export const syncOnce = <E>(api: SyncApi<E>) =>
  Effect.gen(function* () {
    const repository = yield* SyncRepository;
    let pushed = 0;
    let held = 0;
    let after: QueuedRow | undefined;
    for (;;) {
      const page = yield* repository.queued(after);
      const last = page.at(-1);
      if (last === undefined) break;
      const result = yield* api.push(page.map(({ table, row }) => ({ table, row })));
      const ahead = new Set(result.ahead.map(({ table, id }) => `${table}/${id}`));
      const confirmed = page.filter(({ table, id }) => !ahead.has(`${table}/${id}`));
      yield* repository.confirm(confirmed);
      pushed += confirmed.length;
      held += page.length - confirmed.length;
      after = last;
    }
    let pulled = 0;
    for (;;) {
      const { cursor } = yield* repository.state;
      const page = yield* api.pull(cursor);
      const rows = yield* Effect.forEach(page.rows, ({ table, row }) => checkSyncRow(table, row));
      pulled += yield* repository.apply(rows, page.next);
      if (!page.more) break;
    }
    return { pushed, held, pulled } satisfies SyncOutcome;
  });
