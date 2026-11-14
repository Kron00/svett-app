import { Data, Effect, Schema } from "effect";

import { contentFingerprint } from "./ids.ts";
import { TABLES } from "./table.ts";

/**
 * The tables that sync. Coach chats and the proposals they make stay on the phone that had
 * the chat, so only the rest of an account's data reaches the server.
 */
export const SYNCED_TABLES = Object.values(TABLES).filter(
  (table) => table.name !== TABLES.coachMessage.name && table.name !== TABLES.proposal.name,
);

const SYNCED_BY_NAME = new Map(SYNCED_TABLES.map((table) => [table.name, table]));

export const SyncedTable = Schema.Literals(SYNCED_TABLES.map((table) => table.name));
export type SyncedTable = typeof SyncedTable.Type;

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
 * which the phone keeps until its clock is right.
 */
export const SyncPushResult = Schema.Struct({
  stored: Schema.Int,
  ahead: Schema.Array(RowRef),
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

/** Checks a row from outside against its table's schema, as the phone's own database would. */
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
  );
};
