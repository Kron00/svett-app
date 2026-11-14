import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { Ids } from "../ids.ts";
import {
  type EpochMillis,
  type ImportBatch,
  type ImportBatchId,
  type ImportChange,
  ImportChangeId,
  type RowIdsByTable,
  type RowsByTable,
} from "../schema.ts";
import { Sql, type SqlError } from "../sql.ts";
import { encodeSvettFile, exportFileName, type SvettFile } from "../svett-file.ts";
import {
  columnOf,
  currentTime,
  insertRows,
  putRows,
  RowNotFoundError,
  selectRows,
  selectRowsWithDeleted,
  softDeleteRows,
  type Table,
  TABLES,
} from "../table.ts";
import {
  type AnyRow,
  CHILDREN,
  type ImportInput,
  type ImportPlan,
  isLive,
  PARENT,
  planImport,
  REFERENCES,
  type Snapshot,
  svettFileInput,
  TABLE_KEYS,
  type TableKey,
  type TableRows,
  tableKeyOf,
  type UndoEntry,
  undoSelection,
  withRequired,
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
  /**
   * Each record the import added or replaced, whether it changed after the import, and the
   * live rows that point at it. `undoSelection` tells from them what Undo takes back.
   */
  readonly changes: ReadonlyArray<UndoEntry>;
}

export interface UndoResult {
  readonly removed: number;
  readonly restored: number;
  /** Records changed after the import that Undo left as they are. */
  readonly left: number;
  /** Records Undo kept because records it keeps still point at them. */
  readonly kept: number;
}

const anyTable = (key: TableKey) => TABLES[key] as unknown as Table<AnyRow>;

const rowCount = (rows: TableRows) =>
  TABLE_KEYS.reduce((sum, key) => sum + (rows[key]?.length ?? 0), 0);

const byTableName = <A>(rows: Partial<Record<TableKey, ReadonlyArray<A>>>) =>
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
  Effect.forEach(TABLE_KEYS, (key) => selectRowsWithDeleted(anyTable(key))),
  (rows) =>
    Object.fromEntries(TABLE_KEYS.map((key, index) => [key, rows[index]])) as unknown as Snapshot,
).pipe(Effect.orDie);

const inIds = "id IN (SELECT value FROM json_each(?))";

/**
 * The rows an import wrote and every row now below them, deleted or not, such as a set added to
 * an imported workout later. With `root`, also the record's top row and every row below it, so
 * the rows cover the whole record, deleted rows included.
 */
const journalRows = (
  rowIds: RowIdsByTable,
  root?: { readonly table: string; readonly id: string },
) =>
  Effect.gen(function* () {
    const rows: Partial<Record<TableKey, Map<string, AnyRow>>> = {};
    const add = (key: TableKey, found: ReadonlyArray<AnyRow>) => {
      const byId = (rows[key] ??= new Map());
      const fresh = found.filter((row) => !byId.has(row.id));
      for (const row of fresh) byId.set(row.id, row);
      return fresh.map((row) => row.id);
    };
    const below = (key: TableKey, parents: ReadonlyArray<string>) =>
      Effect.gen(function* (): Effect.fn.Return<void, never, Sql> {
        if (parents.length === 0) return;
        const parentIds = JSON.stringify(parents);
        for (const child of CHILDREN[key]) {
          const parentKey = columnOf(PARENT[child]?.key ?? "id");
          const found = yield* Effect.orDie(
            selectRowsWithDeleted(
              anyTable(child),
              `${parentKey} IN (SELECT value FROM json_each(?))`,
              [parentIds],
            ),
          );
          yield* below(child, add(child, found));
        }
      });
    for (const [name, ids] of Object.entries(rowIds)) {
      const key = tableKeyOf(name);
      if (key === undefined || ids.length === 0) continue;
      const found = yield* Effect.orDie(
        selectRowsWithDeleted(anyTable(key), inIds, [JSON.stringify(ids)]),
      );
      yield* below(key, add(key, found));
    }
    const rootKey = root === undefined ? undefined : tableKeyOf(root.table);
    if (root !== undefined && rootKey !== undefined) {
      const found = yield* Effect.orDie(
        selectRowsWithDeleted(anyTable(rootKey), inIds, [JSON.stringify([root.id])]),
      );
      add(rootKey, found);
      // The top row may be missing, as for a set imported without its workout, so the rows
      // below it are found by its ID.
      yield* below(rootKey, [root.id]);
    }
    return Object.fromEntries(
      TABLE_KEYS.flatMap((key) => (rows[key] ? [[key, [...rows[key].values()]]] : [])),
    ) as TableRows;
  });

const putAll = (rows: TableRows) =>
  Effect.forEach(TABLE_KEYS, (key) => putRows(anyTable(key), rows[key] ?? []), {
    discard: true,
  });

/** Marks the rows deleted, with every live row below them, all at the same time. */
const deleteWithChildren = (rows: TableRows, at: EpochMillis): Effect.Effect<void, SqlError, Sql> =>
  Effect.forEach(
    TABLE_KEYS,
    (key) => {
      const ids = (rows[key] ?? []).map((row) => row.id);
      if (ids.length === 0) return Effect.succeed(0);
      return Effect.gen(function* () {
        const deleted = yield* softDeleteRows(TABLES[key], inIds, [JSON.stringify(ids)], at);
        for (const child of CHILDREN[key]) {
          const parentKey = columnOf(PARENT[child]?.key ?? "id");
          const children = yield* selectRows(
            anyTable(child),
            `${parentKey} IN (SELECT value FROM json_each(?))`,
            [JSON.stringify(ids)],
          );
          yield* deleteWithChildren({ [child]: children }, at);
        }
        return deleted;
      });
    },
    { discard: true },
  );

/**
 * Marks the rows another app's import brings as written by this import. A svett file's rows
 * keep the batch they name, so an export and import give back the same rows.
 */
const fromBatch = (rows: TableRows, input: ImportInput, importBatchId: ImportBatchId): TableRows =>
  input.source === "svett_file"
    ? rows
    : (Object.fromEntries(
        TABLE_KEYS.flatMap((key) =>
          rows[key]
            ? [
                [
                  key,
                  rows[key].map((row) =>
                    "importBatchId" in row && row["source"] === input.source
                      ? { ...row, importBatchId }
                      : row,
                  ),
                ],
              ]
            : [],
        ),
      ) as TableRows);

const inputOf = (input: SvettFile | ImportInput): ImportInput =>
  "read" in input ? input : svettFileInput(input);

const restamped = (rows: TableRows, at: EpochMillis): TableRows =>
  Object.fromEntries(
    TABLE_KEYS.flatMap((key) =>
      rows[key] ? [[key, rows[key].map((row) => ({ ...row, updatedAt: at }))]] : [],
    ),
  );

const idsOf = (rows: TableRows): RowIdsByTable =>
  byTableName(
    Object.fromEntries(
      TABLE_KEYS.flatMap((key) => (rows[key] ? [[key, rows[key].map((row) => row.id)]] : [])),
    ) as Partial<Record<TableKey, ReadonlyArray<RowIdsByTable[string][number]>>>,
  );

const recordChange = (
  importBatchId: ImportBatchId,
  change: ImportChange["change"],
  item: { readonly table: TableKey; readonly id: string },
  summary: { readonly title: string; readonly at: EpochMillis | null },
  written: TableRows,
  replaced: TableRows,
) =>
  Effect.gen(function* () {
    const now = yield* currentTime;
    const rowIds = idsOf(written);
    yield* insertRows(TABLES.importChange, [
      {
        id: ImportChangeId.make(yield* rowId(TABLES.importChange, MADE_HERE)),
        updatedAt: now,
        deletedAt: null,
        importBatchId,
        change,
        itemTable: TABLES[item.table].name,
        itemId: item.id as ImportChange["itemId"],
        title: summary.title,
        itemAt: summary.at,
        rowIds,
        replaced: change === "added" && rowCount(replaced) === 0 ? null : byTableName(replaced),
        written: writtenOf(
          yield* journalRows(rowIds, { table: TABLES[item.table].name, id: item.id }),
        ),
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

/** True when any row of the record changed after the import, not only a row it wrote. */
const isEdited = (change: ImportChange) =>
  Effect.map(
    journalRows(change.rowIds, { table: change.itemTable, id: change.itemId }),
    (rows) => writtenOf(rows) !== change.written,
  );

const rowKey = (key: TableKey, id: string) => `${key}/${id}`;

/** What undoing one change writes, and the rows it leaves deleted that are live now. */
interface UndoStep extends UndoEntry {
  readonly before: TableRows;
  readonly added: TableRows;
  readonly ends: ReadonlySet<string>;
}

/**
 * What undoing each change of an import would do. The rows it adds go, with every row
 * below them, and the versions it replaced come back, deleted ones deleted.
 */
const undoSteps = (importBatchId: ImportBatchId) =>
  Effect.gen(function* () {
    const steps = yield* Effect.forEach(yield* changesOf(importBatchId), (change) =>
      Effect.gen(function* () {
        const edited = yield* isEdited(change);
        const current = yield* journalRows(change.rowIds);
        const before = yield* decodeRows(change.replaced ?? {});
        const kept = new Set(
          TABLE_KEYS.flatMap((key) => (before[key] ?? []).map((row) => rowKey(key, row.id))),
        );
        const added = Object.fromEntries(
          Object.entries(change.rowIds).flatMap(([name, written]) => {
            const key = tableKeyOf(name);
            if (key === undefined) return [];
            const fresh = new Set<string>(written.filter((id) => !kept.has(rowKey(key, id))));
            return [[key, (current[key] ?? []).filter((row) => fresh.has(row.id))]];
          }),
        ) as TableRows;
        const ends = new Set<string>();
        for (const key of TABLE_KEYS) {
          const parent = PARENT[key];
          for (const row of current[key] ?? []) {
            const goes =
              (added[key] ?? []).some((gone) => gone.id === row.id) ||
              (parent !== null && ends.has(rowKey(parent.table, String(row[parent.key]))));
            if (goes) ends.add(rowKey(key, row.id));
          }
          for (const row of before[key] ?? []) {
            if (row.deletedAt !== null) ends.add(rowKey(key, row.id));
          }
        }
        return { change, edited, before, added, ends };
      }),
    );
    const removers = new Map<string, Array<ImportChangeId>>();
    for (const step of steps) {
      for (const row of step.ends)
        removers.set(row, [...(removers.get(row) ?? []), step.change.id]);
    }
    return yield* Effect.forEach(steps, (step) =>
      Effect.gen(function* () {
        const usedBy = new Map<string, ReadonlyArray<ImportChangeId>>();
        for (const reference of REFERENCES) {
          const targets = [...step.ends].flatMap((row) => {
            const [key, id] = row.split("/") as [TableKey, string];
            return key === reference.target ? [id] : [];
          });
          if (targets.length === 0) continue;
          const users = yield* selectRows(
            anyTable(reference.table),
            `${columnOf(reference.key)} IN (SELECT value FROM json_each(?))`,
            [JSON.stringify(targets)],
          );
          for (const user of users) {
            const key = rowKey(reference.table, user.id);
            usedBy.set(key, removers.get(key) ?? []);
          }
        }
        return { ...step, usedBy: [...usedBy.values()] } satisfies UndoStep;
      }),
    );
  });

const makeTransferRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const ids = yield* Ids;
  const imports = yield* ImportRepository;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql | Ids>) =>
    effect.pipe(Effect.provideService(Sql, sql), Effect.provideService(Ids, ids));

  /**
   * Adds the file's new records and, for each changed record named in `take`, replaces
   * yours with the file's. Each brings back the deleted records it names, such as its
   * exercises. Nothing is written when there is nothing to add or take.
   * The plan is made again inside the transaction, so it matches what is here.
   */
  const applyImport = (file: SvettFile | ImportInput, take: ReadonlyArray<string>) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const input = inputOf(file);
          const local = yield* snapshot;
          const plan = planImport(local, input.read(local, yield* currentTime).tables);
          const picked = plan.items.filter(
            (item) =>
              item.status === "new" ||
              (item.status === "changed" && take.includes(item.summary.key)),
          );
          if (picked.length === 0) return Option.none<ImportResult>();
          const chosen = withRequired(plan.items, picked);
          const importBatchId = yield* imports.create(input.source);
          yield* imports.setStatus(importBatchId, "applied");
          const at = yield* currentTime;
          let added = 0;
          let replaced = 0;
          for (const item of chosen) {
            if (item.status === "new") {
              // New rows keep their own times, so export and import give back the same rows.
              const written = fromBatch(item.writes, input, importBatchId);
              yield* putAll(written);
              // A record that arrives deleted and replaces nothing leaves Undo nothing to do.
              if (!isLive(item.writes) && rowCount(item.replaced) === 0) continue;
              yield* recordChange(
                importBatchId,
                "added",
                item.incoming,
                item.summary,
                written,
                item.replaced,
              );
              if (isLive(item.writes)) added++;
            } else if (item.status === "changed" || item.status === "restore") {
              // A version taken from the file is the newest change to the record, also for sync.
              const written = fromBatch(restamped(item.writes, at), input, importBatchId);
              yield* putAll(written);
              yield* recordChange(
                importBatchId,
                "replaced",
                item.incoming,
                item.summary,
                written,
                item.replaced,
              );
              if (item.status === "changed") replaced++;
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
        const changes = (yield* undoSteps(importBatchId)).map(
          ({ change, edited, usedBy }): UndoEntry => ({ change, edited, usedBy }),
        );
        return { batch: batch.value, changes } satisfies UndoPreview;
      }),
    );

  /**
   * Removes the records an import added and puts back the versions it replaced. A record
   * changed after the import stays as it is, unless its change is in `alsoEdited`. A record
   * that a live row still points at after Undo, such as an exercise a kept workout uses,
   * stays too.
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
          const { undone, removing, restoring, keeping, leaving } = undoSelection(
            yield* undoSteps(importBatchId),
            alsoEdited,
          );
          for (const step of undone) {
            yield* putAll(restamped(step.before, at));
            yield* deleteWithChildren(step.added, at);
          }
          yield* imports.setStatus(importBatchId, "undone");
          return {
            removed: removing,
            restored: restoring,
            left: leaving,
            kept: keeping,
          } satisfies UndoResult;
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
    previewImport: (file: SvettFile | ImportInput): Effect.Effect<ImportPlan, never> =>
      run(
        Effect.gen(function* () {
          const local = yield* snapshot;
          const { tables, duplicates } = inputOf(file).read(local, yield* currentTime);
          return planImport(local, tables, duplicates);
        }),
      ),
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
