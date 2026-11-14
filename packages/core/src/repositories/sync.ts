import { Clock, Context, Effect, Layer } from "effect";

import { Sql, type SqlValue } from "../sql.ts";
import {
  type CheckedRow,
  checkSyncRow,
  deletedAboveOf,
  deletionMatters,
  isTooFarAhead,
  MAX_CLOCK_AHEAD_MS,
  MAX_SYNC_ROWS,
  mergeChange,
  staysOnPhone,
  SYNCED_TABLES,
  type SyncedTable,
  type SyncPull,
  type SyncPushResult,
} from "../sync.ts";
import { columnOf, selectRowsWithDeleted, TABLES } from "../table.ts";
import { journalFingerprint } from "./transfer.ts";

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

  /** The rows in their stored form, keyed by ID, without any that stay on the phone. */
  const rawRows = (table: SyncedTable, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const target = tableOf(table);
      const rows = yield* sql.all(
        `SELECT ${target.keys.map(columnOf).join(", ")} FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      return rows.map((row) =>
        Object.fromEntries(target.keys.map((key) => [key, row[columnOf(key)] ?? null])),
      );
    });

  const storedRows = (table: SyncedTable, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const raw = yield* rawRows(table, ids);
      const checked = yield* Effect.forEach(
        raw.filter((row) => !staysOnPhone(table, row)),
        (row) => checkSyncRow(table, row),
      );
      return new Map(checked.map((row) => [row.id, row]));
    });

  const lookup = (table: SyncedTable, id: string) =>
    Effect.map(rawRows(table, [id]), ([row]) => row);

  const forget = (table: SyncedTable, id: string) =>
    sql.run("DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ?", [table, id]);

  /**
   * Up to `limit` queued rows after `after`, oldest change first, as the server takes them.
   * A row that holds data that stays on the phone, such as an import journal that kept a coach
   * chat, leaves the queue unsent.
   */
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
      for (const [table, ids] of byTable) {
        const raw = yield* rawRows(table, ids);
        for (const row of raw) {
          if (staysOnPhone(table, row)) yield* forget(table, String(row["id"]));
        }
        stored.set(table, yield* storedRows(table, ids));
      }
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
    sql.all("SELECT cursor, clock, newest_seen FROM sync_state WHERE id = 1"),
    ([row]) => ({
      cursor: Number(row?.["cursor"] ?? 0),
      /** The hybrid logical clock: the last time a change here took or sync applied. */
      clock: Number(row?.["clock"] ?? 0),
      newestSeen: Number(row?.["newest_seen"] ?? 0),
    }),
  );

  const isQueued = (table: SyncedTable, id: string) =>
    Effect.map(
      sql.all("SELECT 1 FROM sync_outbox WHERE table_name = ? AND row_id = ?", [table, id]),
      (found) => found.length > 0,
    );

  /**
   * Saves a pulled page and the cursor after it in one transaction, so a pull cut short
   * resumes from the last page it saved. The server's copy is the one every phone ends with,
   * so it replaces a row this phone has no unsent change to. A row with an unsent change
   * keeps it unless the server's copy wins the merge, and then the change is dropped, since it
   * lost. Every row applied moves the clock past its time.
   */
  const apply = (rows: ReadonlyArray<CheckedRow>, next: number) =>
    sql.transaction(
      Effect.gen(function* () {
        yield* sql.run("UPDATE sync_state SET quiet = 1 WHERE id = 1");
        let newest = 0;
        let taken = 0;
        for (const row of rows) {
          newest = Math.max(newest, row.updatedAt);
          const local = (yield* storedRows(row.table, [row.id])).get(row.id);
          if (local?.changeId === row.changeId) continue;
          if (local !== undefined && (yield* isQueued(row.table, row.id))) {
            const deletedAbove = deletionMatters(local, row)
              ? yield* deletedAboveOf(row.table, row.encoded as Record<string, unknown>, lookup)
              : null;
            if (mergeChange(local, row, deletedAbove) === "keep") continue;
          }
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
          yield* forget(row.table, row.id);
          taken++;
        }
        yield* sql.run(
          `UPDATE sync_state SET quiet = 0, cursor = ?, clock = max(clock, ?),
             newest_seen = max(newest_seen, ?) WHERE id = 1`,
          [next, newest, newest],
        );
        return taken;
      }),
    );

  /**
   * Moves this phone's unsent changes timed after `limit` to times just after every other
   * change here, as recovery once a clock that ran ahead is right again. The server refuses
   * those times until real time catches up with them. The changes keep their order, rows one
   * delete removed keep one shared time, so Undo still finds them, and an import's record
   * that was unchanged since the import still reads as unchanged. The clock moves back to the
   * last new time. Returns how many rows moved.
   */
  const restamp = (limit: number) =>
    sql.transaction(
      Effect.gen(function* () {
        const wall = yield* Clock.currentTimeMillis;
        const ahead: Array<{
          readonly table: SyncedTable;
          readonly id: string;
          readonly updatedAt: number;
          readonly deletedAt: number | null;
        }> = [];
        let floor = wall;
        for (const { name } of SYNCED_TABLES) {
          const found = yield* sql.all(
            `SELECT id, updated_at, deleted_at FROM ${name} WHERE updated_at > ?
               AND id IN (SELECT row_id FROM sync_outbox WHERE table_name = ?)`,
            [limit, name],
          );
          for (const row of found) {
            ahead.push({
              table: name,
              id: String(row["id"]),
              updatedAt: Number(row["updated_at"]),
              deletedAt: row["deleted_at"] === null ? null : Number(row["deleted_at"]),
            });
          }
          const [before] = yield* sql.all(
            `SELECT max(updated_at) AS at FROM ${name} WHERE updated_at <= ?`,
            [limit],
          );
          if (typeof before?.["at"] === "number") floor = Math.max(floor, before["at"] + 1);
        }
        if (ahead.length === 0) return 0;
        floor = Math.max(floor, (yield* state).newestSeen + 1);
        const times = [
          ...new Set(
            ahead.flatMap(({ updatedAt, deletedAt }) =>
              deletedAt !== null && deletedAt > limit ? [updatedAt, deletedAt] : [updatedAt],
            ),
          ),
        ].sort((a, b) => a - b);
        const moved = new Map(times.map((time, index) => [time, floor + index]));
        const journals = ahead.filter(({ table }) => table === TABLES.importChange.name);
        const unchanged = new Set<string>();
        for (const change of yield* selectRowsWithDeleted(
          TABLES.importChange,
          "id IN (SELECT value FROM json_each(?))",
          [JSON.stringify(journals.map(({ id }) => id))],
        )) {
          if ((yield* journalFingerprint(change)) === change.written) unchanged.add(change.id);
        }
        for (const row of ahead) {
          yield* sql.run(`UPDATE ${row.table} SET updated_at = ?, deleted_at = ? WHERE id = ?`, [
            moved.get(row.updatedAt) ?? row.updatedAt,
            row.deletedAt === null ? null : (moved.get(row.deletedAt) ?? row.deletedAt),
            row.id,
          ]);
        }
        for (const change of yield* selectRowsWithDeleted(
          TABLES.importChange,
          "id IN (SELECT value FROM json_each(?))",
          [JSON.stringify([...unchanged])],
        )) {
          yield* sql.run(`UPDATE ${TABLES.importChange.name} SET written = ? WHERE id = ?`, [
            yield* journalFingerprint(change),
            change.id,
          ]);
        }
        yield* sql.run("UPDATE sync_state SET clock = ? WHERE id = 1", [floor + times.length - 1]);
        return ahead.length;
      }),
    );

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
    restamp: (limit: number) => restamp(limit).pipe(Effect.provideService(Sql, sql)),
    /** The last `seq` this phone has fully saved, its clock, and the newest change it applied. */
    state,
    /** How many changed rows wait to upload. */
    queuedCount: Effect.map(sql.all("SELECT count(*) AS n FROM sync_outbox"), ([row]) =>
      Number(row?.["n"] ?? 0),
    ),
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
 * pull. When the server held changes timed too far ahead and this phone's clock is right
 * again, it moves them to times the server takes and sends them once more. Running it again
 * after a failure part way converges to the same state.
 */
export const syncOnce = <E>(api: SyncApi<E>) =>
  Effect.gen(function* () {
    const repository = yield* SyncRepository;
    const pushAll = Effect.gen(function* () {
      let pushed = 0;
      let held = 0;
      let serverMillis: number | undefined;
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
        serverMillis = result.serverMillis;
        after = last;
      }
      return { pushed, held, serverMillis };
    });
    let { pushed, held, serverMillis } = yield* pushAll;
    if (held > 0 && serverMillis !== undefined) {
      const wall = yield* Clock.currentTimeMillis;
      if (!isTooFarAhead(wall, serverMillis)) {
        yield* repository.restamp(serverMillis + MAX_CLOCK_AHEAD_MS);
        const again = yield* pushAll;
        pushed += again.pushed;
        held = again.held;
      }
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
