import { Effect } from "effect";

import { Sql, type SqlValue } from "../sql.ts";
import {
  changeIdOf,
  type CheckedRow,
  checkSyncRow,
  deletedAboveOf,
  deletionMatters,
  draftWorkoutOf,
  mergeChange,
  mergeRow,
  type RowVersion,
  staysOnPhone,
  SYNCED_TABLES,
  type SyncedTable,
} from "../sync.ts";
import { columnOf, TABLES } from "../table.ts";

const TABLE_BY_NAME = new Map(SYNCED_TABLES.map((table) => [table.name, table]));

export const tableOf = (name: string) => {
  const table = TABLE_BY_NAME.get(name as SyncedTable);
  if (table === undefined)
    throw new Error(`The sync queue names a table that does not sync: ${name}`);
  return table;
};

/** The rows in their stored form, keyed by field. */
export const rawRows = (table: SyncedTable, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const target = tableOf(table);
    const rows = yield* sql.all(
      `SELECT ${target.keys.map(columnOf).join(", ")} FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );
    return rows.map((row) =>
      Object.fromEntries(target.keys.map((key) => [key, row[columnOf(key)] ?? null])),
    );
  });

/** The rows as sync sends them, keyed by ID, without any that stay on the phone. */
export const storedRows = (table: SyncedTable, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const raw = yield* rawRows(table, ids);
    const checked = yield* Effect.forEach(
      raw.filter((row) => !staysOnPhone(table, row)),
      (row) => checkSyncRow(table, row),
    );
    return new Map(checked.map((row) => [row.id, row]));
  });

export const lookup = (table: SyncedTable, id: string) =>
  Effect.map(rawRows(table, [id]), ([row]) => row);

/** Drops the row from the queue, with the deletion it was to reverse. */
export const forget = (table: SyncedTable, id: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    yield* sql.run("DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ?", [table, id]);
    yield* sql.run("DELETE FROM sync_restore WHERE table_name = ? AND row_id = ?", [table, id]);
  });

/** Queues the row again, after every change queued so far. */
const requeue = (table: SyncedTable, id: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    yield* sql.run("UPDATE sync_state SET mark = mark + 1 WHERE id = 1");
    yield* forget(table, id);
    yield* sql.run(
      `INSERT INTO sync_outbox (table_name, row_id, mark)
       VALUES (?, ?, (SELECT mark FROM sync_state WHERE id = 1))`,
      [table, id],
    );
  });

/** Writes `row` as given, over any copy here, and drops it from the queue. */
export const save = (row: CheckedRow, encoded: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const target = tableOf(row.table);
    const columns = target.keys.map(columnOf);
    const values = encoded as Readonly<Record<string, SqlValue | undefined>>;
    yield* sql.run(
      `INSERT INTO ${row.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT (id) DO UPDATE SET ${columns
         .filter((column) => column !== "id")
         .map((column) => `${column} = excluded.${column}`)
         .join(", ")}`,
      target.keys.map((key) => values[key] ?? null),
    );
    yield* forget(row.table, row.id);
  });

/** The copy of a row kept aside for a workout in progress here, as it was stored. */
const asideRow = (table: SyncedTable, id: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const [found] = yield* sql.all(
      "SELECT row FROM sync_aside WHERE table_name = ? AND row_id = ?",
      [table, id],
    );
    return found === undefined
      ? undefined
      : (JSON.parse(String(found["row"])) as Readonly<Record<string, unknown>>);
  });

/** A row here, or else its copy kept aside, as the walk up to a row's workout needs. */
const lookupWithAside = (table: SyncedTable, id: string) =>
  Effect.flatMap(lookup(table, id), (row) =>
    row === undefined ? asideRow(table, id) : Effect.succeed(row),
  );

/**
 * The workout in progress here that a pulled row belongs to, by its copy here or by the
 * pulled copy, such as a set another phone added to one of its exercises.
 */
export const draftWorkoutHere = (
  row: CheckedRow,
  here: Readonly<Record<string, unknown>> | undefined,
) =>
  Effect.gen(function* () {
    const byHere =
      here === undefined ? undefined : yield* draftWorkoutOf(row.table, here, lookupWithAside);
    return (
      byHere ??
      (yield* draftWorkoutOf(
        row.table,
        row.encoded as Readonly<Record<string, unknown>>,
        lookupWithAside,
      ))
    );
  });

/** A copy kept aside, checked again as sync checks a pulled row. */
const checkAside = (table: SyncedTable, row: unknown) =>
  // Every copy was checked when it arrived, or written here, so one that fails is a defect.
  Effect.orDie(checkSyncRow(table, row));

/**
 * Keeps a pulled `row` of the workout in progress `workoutId` aside until that workout is
 * finished or discarded, unless the copy already kept aside wins the merge over it.
 */
export const keepAside = (row: CheckedRow, workoutId: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const kept = yield* asideRow(row.table, row.id);
    if (kept !== undefined && mergeRow(yield* checkAside(row.table, kept), row) === "keep") return;
    yield* sql.run(
      `INSERT INTO sync_aside (table_name, row_id, workout_id, row) VALUES (?, ?, ?, ?)
       ON CONFLICT (table_name, row_id) DO UPDATE SET workout_id = excluded.workout_id,
         row = excluded.row`,
      [row.table, row.id, workoutId, JSON.stringify(row.encoded)],
    );
  });

/** The version of the workout `id` as it is here, to merge with once it is finished. */
export const draftVersion = (id: string) =>
  Effect.map(lookup(TABLES.activity.name, id), (row): RowVersion => {
    if (row === undefined) throw new Error(`The workout ${id} is not here`);
    return {
      updatedAt: Number(row["updatedAt"]),
      changeId: changeIdOf(TABLES.activity.name, row),
    };
  });

/** Parents before children, so the merge of a row sees the merged rows above it. */
const DEPTH: Readonly<Record<string, number>> = {
  [TABLES.activity.name]: 0,
  [TABLES.activityExercise.name]: 1,
  [TABLES.activityTrack.name]: 1,
  [TABLES.activitySet.name]: 2,
  [TABLES.activitySample.name]: 2,
};

/** The rows under a workout, parents before children, each with the rows of the workout `?`. */
const UNDER_WORKOUT: ReadonlyArray<readonly [SyncedTable, string]> = [
  [TABLES.activityExercise.name, "activity_id = ?"],
  [TABLES.activityTrack.name, "activity_id = ?"],
  [
    TABLES.activitySet.name,
    "activity_exercise_id IN (SELECT id FROM activity_exercise WHERE activity_id = ?)",
  ],
  [
    TABLES.activitySample.name,
    "activity_track_id IN (SELECT id FROM activity_track WHERE activity_id = ?)",
  ],
];

/**
 * Drops what this phone wrote under the finished workout `workoutId` at or after a delete of
 * a row above it, as the merge drops such an edit from another phone, so Undo brings back
 * only what the workout had. A row another phone has goes back to its copy kept aside and is
 * queued again. A row only this phone has, such as a set it added, is removed, since no other
 * phone has it to delete.
 */
const dropWrittenAfterDelete = (workoutId: string, kept: ReadonlyArray<CheckedRow>) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const aside = new Map(kept.map((row) => [`${row.table}/${row.id}`, row]));
    const dropped: Array<{ readonly table: SyncedTable; readonly id: string }> = [];
    for (const [table, where] of UNDER_WORKOUT) {
      const live = yield* sql.all(`SELECT id FROM ${table} WHERE deleted_at IS NULL AND ${where}`, [
        workoutId,
      ]);
      if (live.length === 0) continue;
      const rows = yield* storedRows(
        table,
        live.map((row) => String(row["id"])),
      );
      for (const row of rows.values()) {
        const deletedAbove = yield* deletedAboveOf(
          table,
          row.encoded as Readonly<Record<string, unknown>>,
          lookup,
        );
        if (deletedAbove === null || row.updatedAt < deletedAbove) continue;
        if (aside.get(`${table}/${row.id}`)?.changeId === row.changeId) continue;
        dropped.push({ table, id: row.id });
      }
    }
    for (const { table, id } of dropped) {
      const other = aside.get(`${table}/${id}`);
      if (other === undefined) {
        yield* sql.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
        yield* forget(table, id);
      } else {
        yield* save(other, other.encoded as Readonly<Record<string, unknown>>);
        yield* requeue(table, id);
      }
    }
  });

/**
 * How a workout in progress ended. A finished one merges with its version from before the
 * finish, since finishing ends the draft and is not an edit that beats another phone's.
 */
export type DraftEnd = { readonly finished: RowVersion } | "discarded";

/**
 * Applies what was kept aside for the workout `workoutId` once it is no longer in progress.
 * Finished, each copy merges with this phone's row by the sync merge rule with deletes: a row
 * this phone lacks is added, the later change to a row wins, and a delete of the workout or
 * an exercise drops every later edit under it, this phone's own too. Discarded, the workout
 * goes back to the copies kept aside, which hold it as it was before it was put back in
 * progress here and every change other phones made since, and they are queued again. Rows written only here while it was in
 * progress stay deleted and unsent.
 */
export const settleKeptAside = (workoutId: string, end: DraftEnd) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const entries = yield* sql.all(
      "SELECT table_name, row_id, row FROM sync_aside WHERE workout_id = ?",
      [workoutId],
    );
    if (entries.length === 0) return;
    yield* sql.run("DELETE FROM sync_aside WHERE workout_id = ?", [workoutId]);
    const kept = yield* Effect.forEach(entries, (entry) =>
      checkAside(entry["table_name"] as SyncedTable, JSON.parse(String(entry["row"]))),
    );
    const [state] = yield* sql.all("SELECT quiet FROM sync_state WHERE id = 1");
    yield* sql.run("UPDATE sync_state SET quiet = 1 WHERE id = 1");
    for (const row of [...kept].sort((a, b) => (DEPTH[a.table] ?? 3) - (DEPTH[b.table] ?? 3))) {
      const encoded = row.encoded as Readonly<Record<string, unknown>>;
      if (end === "discarded") {
        yield* save(row, encoded);
        yield* requeue(row.table, row.id);
        continue;
      }
      if (row.table === TABLES.activity.name && row.id === workoutId) {
        if (mergeRow(end.finished, row) === "take") yield* save(row, encoded);
        continue;
      }
      const local = (yield* storedRows(row.table, [row.id])).get(row.id);
      if (local?.changeId === row.changeId) continue;
      const deletedAbove = deletionMatters(local, row)
        ? yield* deletedAboveOf(row.table, encoded, lookup)
        : null;
      if (mergeChange(local, row, deletedAbove) === "take") yield* save(row, encoded);
    }
    if (end !== "discarded") yield* dropWrittenAfterDelete(workoutId, kept);
    yield* sql.run("UPDATE sync_state SET quiet = ? WHERE id = 1", [Number(state?.["quiet"] ?? 0)]);
  });
