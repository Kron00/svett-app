import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { Ids } from "../ids.ts";
import {
  type EpochMillis,
  type ImportBatch,
  type ImportBatchId,
  type ImportChange,
  ImportChangeId,
  type RowsByTable,
} from "../schema.ts";
import { Sql, type SqlValue } from "../sql.ts";
import { encodeSvettFile, exportFileName, type SvettFile } from "../svett-file.ts";
import {
  columnOf,
  currentTime,
  insertRows,
  putRows,
  RowNotFoundError,
  selectRows,
  softDeleteRows,
  type Table,
  TABLES,
} from "../table.ts";
import {
  type AnyRow,
  CHILDREN,
  type ImportPlan,
  PARENT,
  type Item,
  planImport,
  type Snapshot,
  TABLE_KEYS,
  type TableKey,
  type TableRows,
  tableKeyOf,
  writtenOf,
} from "../transfer.ts";
import { MADE_HERE, rowId } from "./origin.ts";
import { ImportRepository } from "./records.ts";

export class ImportNotUndoableError extends Data.TaggedError("ImportNotUndoableError")<{
  readonly importBatchId: ImportBatchId;
  readonly status: ImportBatch["status"];
}> {}

export interface ImportResult {
  readonly importBatchId: ImportBatchId;
  readonly added: number;
  readonly replaced: number;
}

export interface UndoPreview {
  readonly batch: ImportBatch;
  /** Each record the import added or replaced, and whether it changed after the import. */
  readonly changes: ReadonlyArray<{ readonly change: ImportChange; readonly edited: boolean }>;
}

export interface UndoResult {
  readonly removed: number;
  readonly restored: number;
  /** Records changed after the import that Undo left as they are. */
  readonly left: number;
}

const anyTable = (key: TableKey) => TABLES[key] as unknown as Table<AnyRow>;

const rowCount = (rows: TableRows) =>
  TABLE_KEYS.reduce((sum, key) => sum + (rows[key]?.length ?? 0), 0);

const byTableName = (rows: TableRows) =>
  Object.fromEntries(
    TABLE_KEYS.flatMap((key) => (rows[key]?.length ? [[TABLES[key].name, rows[key]]] : [])),
  );

/** Parses rows an import kept, by table name, with each table's schema. */
const decodeRows = (rows: RowsByTable) =>
  Effect.gen(function* () {
    const decoded: Partial<Record<TableKey, ReadonlyArray<AnyRow>>> = {};
    for (const [name, list] of Object.entries(rows)) {
      const key = tableKeyOf(name);
      if (key === undefined) return yield* Effect.die(new Error(`Unknown table ${name}`));
      const decode = Schema.decodeUnknownEffect(Schema.toType(TABLES[key].schema));
      decoded[key] = (yield* Effect.orDie(
        Effect.forEach(list, (row) => decode(row)),
      )) as ReadonlyArray<AnyRow>;
    }
    return decoded as TableRows;
  });

const snapshot: Effect.Effect<Snapshot, never, Sql> = Effect.map(
  Effect.forEach(TABLE_KEYS, (key) => selectRows(anyTable(key))),
  (rows) =>
    Object.fromEntries(TABLE_KEYS.map((key, index) => [key, rows[index]])) as unknown as Snapshot,
).pipe(Effect.orDie);

/** The live rows of one record here: its top row and every row below it. */
const itemRows = (table: TableKey, id: string) =>
  Effect.gen(function* () {
    const rows: Partial<Record<TableKey, ReadonlyArray<AnyRow>>> = {};
    const visit = (key: TableKey, where: string, params: ReadonlyArray<SqlValue>) =>
      Effect.gen(function* (): Effect.fn.Return<void, never, Sql> {
        const found = yield* Effect.orDie(selectRows(anyTable(key), where, params));
        if (found.length === 0) return;
        rows[key] = found;
        const parentIds = JSON.stringify(found.map((row) => row.id));
        for (const child of CHILDREN[key]) {
          const parentKey = columnOf(PARENT[child]?.key ?? "id");
          yield* visit(child, `${parentKey} IN (SELECT value FROM json_each(?))`, [parentIds]);
        }
      });
    yield* visit(table, "id = ?", [id]);
    return rows as TableRows;
  });

const putAll = (rows: TableRows) =>
  Effect.forEach(TABLE_KEYS, (key) => putRows(anyTable(key), rows[key] ?? []), {
    discard: true,
  });

/** Deletes the rows of `rows` whose IDs `keep` does not hold. */
const deleteMissing = (rows: TableRows, keep: TableRows, at: EpochMillis) =>
  Effect.forEach(
    TABLE_KEYS,
    (key) => {
      const kept = new Set((keep[key] ?? []).map((row) => row.id));
      const gone = (rows[key] ?? []).filter((row) => !kept.has(row.id)).map((row) => row.id);
      return gone.length === 0
        ? Effect.succeed(0)
        : softDeleteRows(
            TABLES[key],
            "id IN (SELECT value FROM json_each(?))",
            [JSON.stringify(gone)],
            at,
          );
    },
    { discard: true },
  );

const restamped = (rows: TableRows, at: EpochMillis): TableRows =>
  Object.fromEntries(
    TABLE_KEYS.flatMap((key) =>
      rows[key]
        ? [[key, rows[key].map((row) => ({ ...row, updatedAt: at, deletedAt: null }))]]
        : [],
    ),
  );

const recordChange = (
  importBatchId: ImportBatchId,
  item: Item,
  summary: { readonly title: string; readonly at: EpochMillis | null },
  written: TableRows,
  replaced: TableRows | null,
) =>
  Effect.gen(function* () {
    const now = yield* currentTime;
    yield* insertRows(TABLES.importChange, [
      {
        id: ImportChangeId.make(yield* rowId(TABLES.importChange, MADE_HERE)),
        updatedAt: now,
        deletedAt: null,
        importBatchId,
        change: replaced === null ? "added" : "replaced",
        itemTable: TABLES[item.table].name,
        itemId: item.id as ImportChange["itemId"],
        title: summary.title,
        itemAt: summary.at,
        replaced: replaced === null ? null : byTableName(replaced),
        written: writtenOf(written),
      },
    ]);
  });

const changesOf = (importBatchId: ImportBatchId) =>
  selectRows(
    TABLES.importChange,
    "import_batch_id = ?",
    [importBatchId],
    "item_at DESC, title, id",
  );

const isEdited = (change: ImportChange) =>
  Effect.gen(function* () {
    const table = tableKeyOf(change.itemTable);
    if (table === undefined) return true;
    return writtenOf(yield* itemRows(table, change.itemId)) !== change.written;
  });

const makeTransferRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const ids = yield* Ids;
  const imports = yield* ImportRepository;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql | Ids>) =>
    effect.pipe(Effect.provideService(Sql, sql), Effect.provideService(Ids, ids));

  /**
   * Adds the file's new records and, for each changed record named in `take`, replaces
   * yours with the file's. Nothing is written when there is nothing to add or take.
   * The plan is made again inside the transaction, so it matches what is here.
   */
  const applyImport = (file: SvettFile, take: ReadonlyArray<string>) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const plan = planImport(yield* snapshot, file.tables);
          const chosen = plan.items.filter(
            (item) =>
              item.status === "new" ||
              (item.status === "changed" && take.includes(item.summary.key)),
          );
          if (chosen.length === 0) return Option.none<ImportResult>();
          const importBatchId = yield* imports.create("svett_file");
          yield* imports.setStatus(importBatchId, "applied");
          const at = yield* currentTime;
          let added = 0;
          let replaced = 0;
          for (const item of chosen) {
            if (item.status === "new") {
              // New rows keep their own times, so export and import give back the same rows.
              yield* putAll(item.incoming.rows);
              yield* recordChange(
                importBatchId,
                item.incoming,
                item.summary,
                item.incoming.rows,
                null,
              );
              added++;
            } else if (item.status === "changed") {
              // A version taken from the file is the newest change to the record, also for sync.
              const written = restamped(item.incoming.rows, at);
              yield* putAll(written);
              yield* deleteMissing(item.local.rows, written, at);
              yield* recordChange(
                importBatchId,
                item.incoming,
                item.summary,
                written,
                item.local.rows,
              );
              replaced++;
            }
          }
          return Option.some<ImportResult>({ importBatchId, added, replaced });
        }),
      ),
    );

  const previewUndo = (importBatchId: ImportBatchId) =>
    run(
      Effect.gen(function* () {
        const batch = yield* imports.get(importBatchId);
        if (Option.isNone(batch)) {
          return yield* new RowNotFoundError({ table: "import_batch", id: importBatchId });
        }
        const changes = yield* Effect.forEach(yield* changesOf(importBatchId), (change) =>
          Effect.map(isEdited(change), (edited) => ({ change, edited })),
        );
        return { batch: batch.value, changes } satisfies UndoPreview;
      }),
    );

  /**
   * Removes the records an import added and puts back the versions it replaced. A record
   * changed after the import stays as it is, unless its change is in `alsoEdited`.
   */
  const undoImport = (importBatchId: ImportBatchId, alsoEdited: ReadonlyArray<ImportChangeId>) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const batch = yield* imports.get(importBatchId);
          if (Option.isNone(batch)) {
            return yield* new RowNotFoundError({ table: "import_batch", id: importBatchId });
          }
          if (batch.value.status !== "applied") {
            return yield* new ImportNotUndoableError({ importBatchId, status: batch.value.status });
          }
          const at = yield* currentTime;
          let removed = 0;
          let restored = 0;
          let left = 0;
          for (const change of yield* changesOf(importBatchId)) {
            const table = tableKeyOf(change.itemTable);
            if (table === undefined) {
              left++;
              continue;
            }
            const current = yield* itemRows(table, change.itemId);
            if (writtenOf(current) !== change.written && !alsoEdited.includes(change.id)) {
              left++;
              continue;
            }
            if (change.replaced === null) {
              yield* deleteMissing(current, {}, at);
              removed++;
            } else {
              const before = yield* decodeRows(change.replaced);
              yield* putAll(restamped(before, at));
              yield* deleteMissing(current, before, at);
              restored++;
            }
          }
          yield* imports.setStatus(importBatchId, "undone");
          return { removed, restored, left } satisfies UndoResult;
        }),
      ),
    );

  return {
    /** The whole database as a svett file, with the name to give it. */
    exportFile: run(
      Effect.gen(function* () {
        const at = yield* currentTime;
        const rows = yield* sql.transaction(snapshot);
        return { name: exportFileName(at), text: encodeSvettFile(rows, at), rows: rowCount(rows) };
      }),
    ),
    previewImport: (file: SvettFile): Effect.Effect<ImportPlan, never> =>
      run(Effect.map(snapshot, (local) => planImport(local, file.tables))),
    applyImport,
    previewUndo,
    undoImport,
    /** Imports that changed something, newest first. */
    listImports: run(
      selectRows(TABLES.importBatch, "status != 'previewed'", [], "created_at DESC, id"),
    ),
  };
});

/**
 * The writer of import_change, and of whole rows that arrive with their own IDs. A svett
 * file holds rows of every table, so this one repository writes them all, and puts back
 * what an import replaced. Phase 6 sync will apply rows the same way.
 */
export class TransferRepository extends Context.Service<
  TransferRepository,
  Effect.Success<typeof makeTransferRepository>
>()("svett/TransferRepository") {
  static readonly layer = Layer.effect(TransferRepository, makeTransferRepository).pipe(
    Layer.provide(ImportRepository.layer),
  );
}
