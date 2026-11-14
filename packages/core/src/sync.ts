import { Data, Effect, Schema } from "effect";

import { contentFingerprint } from "./ids.ts";
import { TABLES } from "./table.ts";
import { PARENT, tableKeyOf } from "./transfer.ts";

/** Coach chats and the proposals they make stay on the phone that had the chat. */
const LOCAL_ONLY: ReadonlySet<string> = new Set([TABLES.coachMessage.name, TABLES.proposal.name]);

/** The tables that sync: every table but the ones that stay on the phone. */
export const SYNCED_TABLES = Object.values(TABLES).filter((table) => !LOCAL_ONLY.has(table.name));

const SYNCED_BY_NAME = new Map(SYNCED_TABLES.map((table) => [table.name, table]));

export const SyncedTable = Schema.Literals(SYNCED_TABLES.map((table) => table.name));
export type SyncedTable = typeof SyncedTable.Type;

const parsed = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * True when a row holds data that stays on the phone. An import journal row does when its
 * record, the rows it wrote or the versions it replaced belong to a coach chat, at any depth,
 * since a journal can keep an older journal it replaced. Such a journal never syncs, and Undo
 * on the phone that made it still works from it. A journal it cannot read counts as holding
 * such data.
 */
export const staysOnPhone = (table: string, row: unknown): boolean => {
  if (LOCAL_ONLY.has(table)) return true;
  if (table !== TABLES.importChange.name) return false;
  if (!isRecord(row)) return true;
  if (LOCAL_ONLY.has(String(row["itemTable"]))) return true;
  const written = parsed(row["rowIds"]);
  const replaced = parsed(row["replaced"]) ?? {};
  if (!isRecord(written) || !isRecord(replaced)) return true;
  if (Object.keys(written).some((name) => LOCAL_ONLY.has(name))) return true;
  return Object.entries(replaced).some(
    ([name, rows]) =>
      LOCAL_ONLY.has(name) ||
      !Array.isArray(rows) ||
      (name === TABLES.importChange.name && rows.some((nested) => staysOnPhone(name, nested))),
  );
};

/** Which of two copies of one row is newer. Only these two fields decide. */
export interface RowVersion {
  readonly updatedAt: number;
  /** The change's ID: a hash of its table and its whole row, so equal changes share it. */
  readonly changeId: string;
}

/** The ID of the change that wrote `row`, the same on every phone and on the server. */
export const changeIdOf = (table: SyncedTable, encodedRow: unknown): string =>
  contentFingerprint([table, encodedRow]);

/**
 * The sync merge rule. The copy with the later `updatedAt` wins. When the times are equal,
 * the higher change ID wins, so every device picks the same copy whatever order the changes
 * arrive in. A delete is a row with `deletedAt` set and follows the same rule. A copy that
 * equals the stored one changes nothing, so a change sent twice is applied once.
 */
export const mergeRow = (stored: RowVersion | undefined, incoming: RowVersion): "take" | "keep" => {
  if (stored === undefined) return "take";
  if (incoming.updatedAt !== stored.updatedAt) {
    return incoming.updatedAt > stored.updatedAt ? "take" : "keep";
  }
  return incoming.changeId > stored.changeId ? "take" : "keep";
};

/** A copy of a row, as the merge with deletes sees it. */
export interface RowCopy extends RowVersion {
  readonly deletedAt: number | null;
}

/**
 * True when the plain merge would let a live copy beat a deleted one, which a delete of the
 * record above the row can overturn. Only then does the merge need that record.
 */
export const deletionMatters = (stored: RowCopy | undefined, incoming: RowCopy): boolean => {
  if (stored === undefined) return false;
  const [winner, loser] = mergeRow(stored, incoming) === "take" ? [incoming, stored] : [stored, incoming];
  return winner.deletedAt === null && loser.deletedAt !== null;
};

/**
 * The sync merge rule with deletes. Deleting a workout deletes its exercises, sets and route
 * with it. A live copy of one of those, changed at or after a delete of a row above it, is an
 * edit another phone made to something already deleted, so it loses to the deleted copy
 * whatever its time. Undo then brings back what the workout had. `deletedAbove` is the
 * earliest `deletedAt` of the deleted rows above this one, or null when none is deleted.
 */
export const mergeChange = (
  stored: RowCopy | undefined,
  incoming: RowCopy,
  deletedAbove: number | null,
): "take" | "keep" => {
  const plain = mergeRow(stored, incoming);
  if (!deletionMatters(stored, incoming) || deletedAbove === null) return plain;
  const live = plain === "take" ? incoming : stored;
  if (live === undefined || live.updatedAt < deletedAbove) return plain;
  return plain === "take" ? "keep" : "take";
};

/** The row directly above `row` in its record, such as a set's workout exercise. */
export const parentOf = (
  table: SyncedTable,
  row: Readonly<Record<string, unknown>>,
): { readonly table: SyncedTable; readonly id: string } | undefined => {
  const key = tableKeyOf(table);
  const parent = key === undefined ? null : PARENT[key];
  const id = parent === null ? undefined : row[parent.key];
  if (parent === null || typeof id !== "string") return undefined;
  const name = TABLES[parent.table].name;
  return SYNCED_BY_NAME.has(name as SyncedTable) ? { table: name as SyncedTable, id } : undefined;
};

/**
 * The earliest `deletedAt` of the deleted rows above `row`, read through `lookup`, which
 * gives a stored row in its encoded form. A row above that is missing ends the walk.
 */
export const deletedAboveOf = <E, R>(
  table: SyncedTable,
  row: Readonly<Record<string, unknown>>,
  lookup: (
    table: SyncedTable,
    id: string,
  ) => Effect.Effect<Readonly<Record<string, unknown>> | undefined, E, R>,
): Effect.Effect<number | null, E, R> =>
  Effect.gen(function* () {
    let earliest: number | null = null;
    let above = parentOf(table, row);
    for (let depth = 0; above !== undefined && depth < 8; depth++) {
      const found = yield* lookup(above.table, above.id);
      if (found === undefined) break;
      const deletedAt = found["deletedAt"];
      if (typeof deletedAt === "number") {
        earliest = earliest === null ? deletedAt : Math.min(earliest, deletedAt);
      }
      above = parentOf(above.table, found);
    }
    return earliest;
  });

/** How far ahead of the server's clock a change may be. */
export const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;

export const isTooFarAhead = (updatedAt: number, serverMillis: number) =>
  updatedAt > serverMillis + MAX_CLOCK_AHEAD_MS;

/** The most rows one push or one pull carries. */
export const MAX_SYNC_ROWS = 500;

const RowRef = Schema.Struct({ table: SyncedTable, id: Schema.String });
export type RowRef = typeof RowRef.Type;

/** What a phone sends. Any owner it names is ignored: the server takes it from the session. */
export const SyncPush = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ table: SyncedTable, row: Schema.Unknown })).check(
    Schema.isMaxLength(MAX_SYNC_ROWS),
  ),
});
export type SyncPush = typeof SyncPush.Type;

/**
 * The server's answer to a push. Every row it does not list in `ahead` is confirmed, whether
 * it won the merge or not. `ahead` lists the rows timed too far ahead of the server's clock,
 * which the phone keeps until its clock is right. `serverMillis` is the server's clock, so a
 * phone can tell when its own clock is right again.
 */
export const SyncPushResult = Schema.Struct({
  stored: Schema.Int,
  ahead: Schema.Array(RowRef),
  serverMillis: Schema.Int,
});
export type SyncPushResult = typeof SyncPushResult.Type;

/**
 * A page of an account's rows, in the order the server applied them. `seq` only goes up. A
 * phone asks for the rows after the last `seq` it has fully saved, so a pull can resume.
 */
export const SyncPull = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ seq: Schema.Int, table: SyncedTable, row: Schema.Unknown })),
  next: Schema.Int,
  more: Schema.Boolean,
});
export type SyncPull = typeof SyncPull.Type;

/** A row checked against its table's schema, in its stored form, with its version. */
export interface CheckedRow extends RowVersion {
  readonly table: SyncedTable;
  readonly id: string;
  readonly deletedAt: number | null;
  readonly encoded: unknown;
}

export class InvalidSyncRow extends Data.TaggedError("InvalidSyncRow")<{
  readonly table: string;
  readonly message: string;
}> {}

/**
 * Checks a row from outside against its table's schema, as the phone's own database would,
 * and refuses one that holds data that stays on the phone.
 */
export const checkSyncRow = (
  table: SyncedTable,
  row: unknown,
): Effect.Effect<CheckedRow, InvalidSyncRow> => {
  const target = SYNCED_BY_NAME.get(table);
  if (target === undefined) {
    return Effect.fail(new InvalidSyncRow({ table, message: "This table does not sync." }));
  }
  return Schema.decodeUnknownEffect(target.schema)(row).pipe(
    Effect.flatMap((decoded) =>
      Effect.map(Schema.encodeEffect(target.schema)(decoded), (encoded): CheckedRow => ({
        table,
        id: decoded.id,
        updatedAt: decoded.updatedAt,
        deletedAt: decoded.deletedAt,
        encoded,
        changeId: changeIdOf(table, encoded),
      })),
    ),
    Effect.mapError((issue) => new InvalidSyncRow({ table, message: issue.message })),
    Effect.filterOrFail(
      (checked) => !staysOnPhone(table, checked.encoded),
      () =>
        new InvalidSyncRow({
          table,
          message: "This row keeps part of a coach chat, which stays on the phone.",
        }),
    ),
  );
};
