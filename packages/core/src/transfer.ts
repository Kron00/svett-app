import { Exit, Schema } from "effect";

import { LIBRARY_UPDATED_AT } from "./exercise-library.ts";
import { canonicalJson, contentFingerprint } from "./ids.ts";
import {
  EpochMillis,
  Fingerprint,
  type ImportChange,
  type ImportChangeId,
  type ImportSource,
  type MeasurementKind,
} from "./schema.ts";
import { TABLES } from "./table.ts";

export type TableKey = keyof typeof TABLES;

/** Every table, parents before their children. */
export const TABLE_KEYS = Object.keys(TABLES) as ReadonlyArray<TableKey>;

export type AnyRow = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly updatedAt: EpochMillis;
  readonly deletedAt: EpochMillis | null;
};

/** Every row of every table, deleted ones too. */
export type Snapshot = Readonly<Record<TableKey, ReadonlyArray<AnyRow>>>;

/** Rows of some tables, such as the rows of one record. */
export type TableRows = Partial<Record<TableKey, ReadonlyArray<AnyRow>>>;

/**
 * The table each table's rows belong to, through which key. A row with no parent is the
 * top of a record, such as a workout's activity, and its record holds every row below it.
 * Adding a table fails the type check until it is listed here, so export and import cover it.
 */
export const PARENT: Readonly<
  Record<TableKey, { readonly table: TableKey; readonly key: string } | null>
> = {
  importBatch: null,
  importChange: { table: "importBatch", key: "importBatchId" },
  exercise: null,
  exerciseAlias: null,
  activity: null,
  activityExercise: { table: "activity", key: "activityId" },
  activitySet: { table: "activityExercise", key: "activityExerciseId" },
  activityTrack: { table: "activity", key: "activityId" },
  activitySample: { table: "activityTrack", key: "activityTrackId" },
  activitySource: { table: "activity", key: "activityId" },
  folder: null,
  routine: null,
  routineExercise: { table: "routine", key: "routineId" },
  routineSet: { table: "routineExercise", key: "routineExerciseId" },
  measurement: null,
  proposal: null,
  coachMessage: null,
};

/**
 * Keys that point at a row of another record, such as a workout exercise's exercise. Undo
 * keeps a record that a live row still points at, and an import that brings such a row back
 * also brings back what it points at, so no live row is left pointing at a deleted one.
 */
export const REFERENCES: ReadonlyArray<{
  readonly table: TableKey;
  readonly key: string;
  readonly target: TableKey;
}> = [
  { table: "activityExercise", key: "exerciseId", target: "exercise" },
  { table: "routineExercise", key: "exerciseId", target: "exercise" },
  { table: "exerciseAlias", key: "exerciseId", target: "exercise" },
  { table: "routine", key: "folderId", target: "folder" },
  { table: "proposal", key: "coachMessageId", target: "coachMessage" },
  { table: "activity", key: "importBatchId", target: "importBatch" },
  { table: "exercise", key: "importBatchId", target: "importBatch" },
  { table: "measurement", key: "importBatchId", target: "importBatch" },
];

export const CHILDREN: Readonly<Record<TableKey, ReadonlyArray<TableKey>>> = Object.fromEntries(
  TABLE_KEYS.map((key) => [key, TABLE_KEYS.filter((child) => PARENT[child]?.table === key)]),
) as unknown as Record<TableKey, ReadonlyArray<TableKey>>;

export const tableKeyOf = (name: string): TableKey | undefined =>
  TABLE_KEYS.find((key) => TABLES[key].name === name);

/** What one record is called in a preview. */
const NOUN: Readonly<Record<TableKey, readonly [one: string, other: string]>> = {
  importBatch: ["import", "imports"],
  importChange: ["import record", "import records"],
  exercise: ["exercise", "exercises"],
  exerciseAlias: ["exercise name match", "exercise name matches"],
  activity: ["workout", "workouts"],
  activityExercise: ["workout exercise", "workout exercises"],
  activitySet: ["workout set", "workout sets"],
  activityTrack: ["route", "routes"],
  activitySample: ["route point", "route points"],
  activitySource: ["linked source", "linked sources"],
  folder: ["folder", "folders"],
  routine: ["routine", "routines"],
  routineExercise: ["routine exercise", "routine exercises"],
  routineSet: ["routine set", "routine sets"],
  measurement: ["measurement", "measurements"],
  proposal: ["coach proposal", "coach proposals"],
  coachMessage: ["coach message", "coach messages"],
};

export const countLabel = (table: TableKey, count: number): string =>
  `${count.toLocaleString("en-US")} ${NOUN[table][count === 1 ? 0 : 1]}`;

/** A record: its top row and every row below it. */
export interface Item {
  readonly key: string;
  readonly table: TableKey;
  readonly id: string;
  readonly rows: TableRows;
}

export interface ItemSummary {
  readonly key: string;
  readonly table: TableKey;
  readonly id: string;
  readonly title: string;
  /** When the record happened, such as a workout's start, when it has such a time. */
  readonly at: EpochMillis | null;
}

const itemKey = (table: TableKey, id: string) => `${TABLES[table].name}/${id}`;

/**
 * Groups rows into records. A row whose parent is missing heads its own record under the
 * parent's key, so the same rows group the same way on both sides of an import.
 */
export const groupItems = (rows: TableRows, lookup: TableRows = rows): Map<string, Item> => {
  const index = new Map<TableKey, Map<string, AnyRow>>();
  for (const source of [lookup, rows]) {
    for (const key of TABLE_KEYS) {
      const byId = index.get(key) ?? new Map<string, AnyRow>();
      for (const row of source[key] ?? []) if (!byId.has(row.id)) byId.set(row.id, row);
      index.set(key, byId);
    }
  }
  const rootOf = (table: TableKey, row: AnyRow): { table: TableKey; id: string } => {
    const parent = PARENT[table];
    if (parent === null) return { table, id: row.id };
    const parentId = String(row[parent.key]);
    const parentRow = index.get(parent.table)?.get(parentId);
    return parentRow === undefined
      ? { table: parent.table, id: parentId }
      : rootOf(parent.table, parentRow);
  };

  const items = new Map<
    string,
    Item & { readonly rows: Partial<Record<TableKey, Array<AnyRow>>> }
  >();
  for (const table of TABLE_KEYS) {
    for (const row of rows[table] ?? []) {
      const root = rootOf(table, row);
      const key = itemKey(root.table, root.id);
      const item = items.get(key) ?? { key, ...root, rows: {} };
      (item.rows[table] ??= []).push(row);
      items.set(key, item);
    }
  }
  return items;
};

/** Changes with any write to the record, even one that leaves its content as it was. */
export const writtenOf = (rows: TableRows): Fingerprint =>
  Fingerprint.make(
    contentFingerprint(
      TABLE_KEYS.flatMap((table) =>
        [...(rows[table] ?? [])]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((row) => [TABLES[table].name, row]),
      ),
    ),
  );

const MEASUREMENT_TITLE: Readonly<Record<MeasurementKind, string>> = {
  body_weight: "Body weight",
  body_fat: "Body fat",
  neck: "Neck",
  shoulders: "Shoulders",
  chest: "Chest",
  left_biceps: "Left biceps",
  right_biceps: "Right biceps",
  left_forearm: "Left forearm",
  right_forearm: "Right forearm",
  abdomen: "Abdomen",
  waist: "Waist",
  hips: "Hips",
  left_thigh: "Left thigh",
  right_thigh: "Right thigh",
  left_calf: "Left calf",
  right_calf: "Right calf",
};

const IMPORT_SOURCE_TITLE: Readonly<Record<ImportSource, string>> = {
  hevy: "Hevy import",
  apple_health: "Apple Health import",
  gpx: "GPX import",
  svett_file: "svett file import",
};

export const importTitle = (source: ImportSource): string => IMPORT_SOURCE_TITLE[source];

const text = (value: unknown) => (typeof value === "string" ? value : "");
const time = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? EpochMillis.make(value)
    : null;
const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const shortened = (value: string, length = 60) =>
  value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;

/** The title and time a preview shows for a record. */
export const summarize = (item: Item): ItemSummary => {
  const top = item.rows[item.table]?.find((row) => row.id === item.id);
  const base = { key: item.key, table: item.table, id: item.id };
  const fallback = capitalized(NOUN[item.table][0]);
  if (top === undefined) return { ...base, title: fallback, at: null };
  switch (item.table) {
    case "activity":
      return {
        ...base,
        title: text(top["title"]) || capitalized(text(top["kind"])) || fallback,
        at: time(top["startedAt"]),
      };
    case "routine":
    case "proposal":
      return {
        ...base,
        title: text(top["title"]) || fallback,
        at: time(top["createdAt"] ?? null),
      };
    case "folder":
    case "exercise":
    case "exerciseAlias":
      return { ...base, title: text(top["name"]) || fallback, at: null };
    case "measurement":
      return {
        ...base,
        title: MEASUREMENT_TITLE[top["kind"] as MeasurementKind] ?? fallback,
        at: time(top["measuredAt"]),
      };
    case "coachMessage":
      return {
        ...base,
        title: shortened(text(top["content"]).replaceAll(/\s+/g, " ").trim()) || fallback,
        at: time(top["createdAt"]),
      };
    case "importBatch":
      return {
        ...base,
        title: IMPORT_SOURCE_TITLE[text(top["source"]) as ImportSource] ?? fallback,
        at: time(top["createdAt"]),
      };
    default:
      return { ...base, title: fallback, at: null };
  }
};

/** The rows an import writes for one record, and the versions here it writes over. */
interface Writes {
  readonly incoming: Item;
  /** The file's rows that differ from the rows here with the same ID, or are not here. */
  readonly writes: TableRows;
  /** The rows here that `writes` replace, deleted or not. */
  readonly replaced: TableRows;
  readonly summary: ItemSummary;
  /** The keys of the `restore` records this record names, which come back with it. */
  readonly requires: ReadonlyArray<string>;
}

/**
 * `restore` is a record deleted here that the file holds live and another record in the file
 * names, such as an exercise an Undo removed with its workouts. It is not listed on its own.
 * It comes back with any record that names it, so no workout points to a deleted exercise.
 */
export type PlannedItem =
  | ({ readonly status: "new" } & Writes)
  | ({ readonly status: "changed" } & Writes)
  | ({ readonly status: "restore" } & Writes)
  | { readonly status: "unchanged"; readonly summary: ItemSummary };

/**
 * A record the file holds that may be one already here or another in the file: a workout with
 * the same start as another in the file, one with a new start and the same sets as one here,
 * or one whose time overlaps a workout here from another source. It is imported only when you
 * choose it.
 */
export interface PossibleDuplicate {
  readonly key: string;
  readonly summary: ItemSummary;
  readonly reason: "same_start" | "same_sets" | "overlap";
  /** The record it may repeat. */
  readonly other: ItemSummary;
  readonly kept: boolean;
}

/** What an import brings: rows by table, and the records held back as possible duplicates. */
export interface ImportRows {
  readonly tables: TableRows;
  readonly duplicates: ReadonlyArray<PossibleDuplicate>;
}

/**
 * Something to import from. A svett file's rows carry their own IDs and arrive as they are.
 * Another app's file gives rows that depend on what is here, such as the exercises its names
 * match, so it reads them from the rows here, at the time of the import.
 */
export interface ImportInput {
  readonly source: ImportSource;
  readonly read: (local: Snapshot, at: EpochMillis) => ImportRows;
}

export const svettFileInput = (file: { readonly tables: TableRows }): ImportInput => ({
  source: "svett_file",
  read: () => ({ tables: file.tables, duplicates: [] }),
});

export interface ImportPlan {
  /** Records held back as possible duplicates, kept or not. */
  readonly duplicates: ReadonlyArray<PossibleDuplicate>;
  readonly items: ReadonlyArray<PlannedItem>;
  /** New records per table, in table order, for the tables that have any. */
  readonly added: ReadonlyArray<{ readonly table: TableKey; readonly count: number }>;
  /** New records the file holds only as deleted. Import keeps them, still deleted. */
  readonly deleted: number;
  /** Records here that the file holds another version of. Import keeps yours unless chosen. */
  readonly changed: ReadonlyArray<ItemSummary>;
  readonly unchanged: number;
}

const byTimeThenTitle = (a: ItemSummary, b: ItemSummary) =>
  (b.at ?? 0) - (a.at ?? 0) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key);

const sameContent = (a: AnyRow, b: AnyRow) =>
  canonicalJson({ ...a, updatedAt: 0 }) === canonicalJson({ ...b, updatedAt: 0 });

/**
 * A library exercise as the app seeded it. It is not yours to keep, so a file's version of
 * it, such as a deletion, counts as new rather than as a change to your copy.
 */
const isSeed = (table: TableKey, row: AnyRow) =>
  table === "exercise" &&
  row["source"] === "library" &&
  row.updatedAt === LIBRARY_UPDATED_AT &&
  row.deletedAt === null;

export const isLive = (rows: TableRows) =>
  TABLE_KEYS.some((key) => (rows[key] ?? []).some((row) => row.deletedAt === null));

/**
 * Compares the rows in a file with the ones here, by ID, and groups them into records. An
 * import writes only the file's rows. A row the file leaves out stays as it is here, and a
 * deletion travels as a row marked deleted. A record none of whose rows are here is new. One
 * whose rows all match, however long ago each changed, is unchanged and left alone. Any other
 * is changed, and the preview lists it, unless it is a deleted record another one names, which
 * comes back with that one.
 */
export const planImport = (
  local: TableRows,
  incoming: TableRows,
  duplicates: ReadonlyArray<PossibleDuplicate> = [],
): ImportPlan => {
  const lookup = Object.fromEntries(
    TABLE_KEYS.map((key) => [key, [...(incoming[key] ?? []), ...(local[key] ?? [])]]),
  ) as TableRows;
  const here = new Map(
    TABLE_KEYS.map((key) => [key, new Map((local[key] ?? []).map((row) => [row.id, row]))]),
  );
  const planned: Array<
    | { readonly status: "unchanged"; readonly summary: ItemSummary }
    | ({ readonly status: "new" | "changed"; readonly restorable: boolean } & Omit<
        Writes,
        "requires"
      >)
  > = [];
  for (const item of groupItems(incoming, lookup).values()) {
    const summary = summarize(item);
    const writes: Partial<Record<TableKey, Array<AnyRow>>> = {};
    const replaced: Partial<Record<TableKey, Array<AnyRow>>> = {};
    let yours = !isRootSeedOrMissing(item, here);
    for (const table of TABLE_KEYS) {
      for (const row of item.rows[table] ?? []) {
        const current = here.get(table)?.get(row.id);
        if (current !== undefined && !isSeed(table, current)) yours = true;
        if (current !== undefined && sameContent(current, row)) continue;
        (writes[table] ??= []).push(row);
        if (current !== undefined) (replaced[table] ??= []).push(current);
      }
    }
    if (Object.keys(writes).length === 0) planned.push({ status: "unchanged", summary });
    else {
      const root = here.get(item.table)?.get(item.id);
      const top = item.rows[item.table]?.find((row) => row.id === item.id);
      planned.push({
        status: yours ? "changed" : "new",
        restorable: root !== undefined && root.deletedAt !== null && top?.deletedAt === null,
        incoming: item,
        writes,
        replaced,
        summary,
      });
    }
  }
  const restorable = new Set(
    planned.flatMap((item) =>
      item.status === "changed" && item.restorable ? [item.summary.key] : [],
    ),
  );
  const requiresOf = (item: Item) => {
    const keys = new Set<string>();
    for (const table of TABLE_KEYS) {
      for (const row of item.rows[table] ?? []) {
        if (row.deletedAt !== null) continue;
        for (const reference of REFERENCES) {
          if (reference.table !== table) continue;
          const key = itemKey(reference.target, String(row[reference.key]));
          if (key !== item.key && restorable.has(key)) keys.add(key);
        }
      }
    }
    return [...keys];
  };
  const requires = new Map(
    planned.flatMap((item) =>
      item.status === "unchanged" ? [] : [[item.summary.key, requiresOf(item.incoming)] as const],
    ),
  );
  const required = new Set([...requires.values()].flat());
  const items = planned.map((item): PlannedItem => {
    if (item.status === "unchanged") return item;
    const key = item.summary.key;
    return {
      status: required.has(key) ? "restore" : item.status,
      incoming: item.incoming,
      writes: item.writes,
      replaced: item.replaced,
      summary: item.summary,
      requires: requires.get(key) ?? [],
    };
  });
  const added = TABLE_KEYS.map((table) => ({
    table,
    count: items.filter(
      (item) => item.status === "new" && item.summary.table === table && isLive(item.writes),
    ).length,
  })).filter(({ count }) => count > 0);
  return {
    duplicates,
    items,
    added,
    deleted: items.filter((item) => item.status === "new" && !isLive(item.writes)).length,
    changed: items
      .filter((item) => item.status === "changed")
      .map((item) => item.summary)
      .sort(byTimeThenTitle),
    unchanged: items.filter((item) => item.status === "unchanged").length,
  };
};

/** True when the record's top row is not here, or is a library exercise as seeded. */
const isRootSeedOrMissing = (
  item: Item,
  here: ReadonlyMap<TableKey, ReadonlyMap<string, AnyRow>>,
) => {
  const root = here.get(item.table)?.get(item.id);
  return root === undefined || isSeed(item.table, root);
};

/**
 * Why an import change cannot be trusted, or undefined when it can. Its journal must name
 * known tables, and each kept row must pass its table's schema and be one the import wrote.
 * An import change kept inside another is checked the same way.
 */
export const journalProblem = (change: ImportChange): string | undefined => {
  if (tableKeyOf(change.itemTable) === undefined) {
    return `it names a table svett does not know, ${change.itemTable}`;
  }
  const written = new Map<string, ReadonlySet<string>>();
  for (const [name, ids] of Object.entries(change.rowIds)) {
    if (tableKeyOf(name) === undefined) return `it names a table svett does not know, ${name}`;
    written.set(name, new Set(ids));
  }
  for (const [name, rows] of Object.entries(change.replaced ?? {})) {
    const key = tableKeyOf(name);
    if (key === undefined) return `it names a table svett does not know, ${name}`;
    const decode = Schema.decodeUnknownExit(Schema.toType(TABLES[key].schema));
    for (const raw of rows) {
      const row = decode(raw);
      if (Exit.isFailure(row)) return `it keeps a ${name} row that is not valid`;
      const value = row.value as AnyRow;
      if (!written.get(name)?.has(value.id)) {
        return `it keeps a ${name} row the import did not write`;
      }
      if (key === "importChange") {
        const nested = journalProblem(value as unknown as ImportChange);
        if (nested !== undefined) return nested;
      }
    }
  }
  return undefined;
};

export const isNothingToImport = (plan: ImportPlan): boolean =>
  plan.added.length === 0 &&
  plan.deleted === 0 &&
  plan.changed.length === 0 &&
  plan.duplicates.length === 0;

export const recordsLabel = (count: number): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "record" : "records"}`;

/** What an import did, in one or two sentences. */
export const importOutcome = ({
  added,
  replaced,
}: {
  readonly added: number;
  readonly replaced: number;
}): string => {
  const took = `the file's version of ${recordsLabel(replaced)}`;
  if (added === 0) return replaced === 0 ? "Nothing changed." : `Took ${took}.`;
  return replaced === 0
    ? `Added ${recordsLabel(added)}.`
    : `Added ${recordsLabel(added)} and took ${took}.`;
};

/**
 * The records an import writes for the ones you picked: each picked record, and the `restore`
 * records it names, with the ones those name in turn, such as the import an exercise came from.
 */
export const withRequired = (
  items: ReadonlyArray<PlannedItem>,
  picked: ReadonlyArray<PlannedItem>,
): ReadonlyArray<PlannedItem> => {
  const restores = new Map(
    items.flatMap((item) => (item.status === "restore" ? [[item.summary.key, item] as const] : [])),
  );
  const required = new Set<string>();
  const pending = picked.flatMap((item) => (item.status === "unchanged" ? [] : item.requires));
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    const item = restores.get(key);
    if (item === undefined || required.has(key)) continue;
    required.add(key);
    pending.push(...item.requires);
  }
  return [
    ...items.filter((item) => item.status === "restore" && required.has(item.summary.key)),
    ...picked,
  ];
};

/** One change of an import as Undo sees it. */
export interface UndoEntry {
  readonly change: ImportChange;
  /** True when the record changed after the import. */
  readonly edited: boolean;
  /**
   * One entry per live row that points at this record, such as a workout that uses an
   * imported exercise. Each lists the changes of this import whose Undo removes that row.
   * An empty list is a row Undo never removes, such as a workout logged after the import.
   */
  readonly usedBy: ReadonlyArray<ReadonlyArray<ImportChangeId>>;
}

/**
 * Which changes Undo takes back. A change edited after the import is left, unless it is in
 * `alsoEdited`. A change whose record a live row still points at after Undo is kept, so no
 * live row points at a deleted one.
 */
export const undoSelection = <A extends UndoEntry>(
  entries: ReadonlyArray<A>,
  alsoEdited: ReadonlyArray<ImportChangeId>,
) => {
  const left = new Set(
    entries
      .filter((entry) => entry.edited && !alsoEdited.includes(entry.change.id))
      .map((entry) => entry.change.id),
  );
  const kept = new Set<ImportChangeId>();
  const stays = (id: ImportChangeId) => left.has(id) || kept.has(id);
  // Keeping a record can keep a row that points at another, so this runs until nothing changes.
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of entries) {
      if (stays(entry.change.id)) continue;
      if (entry.usedBy.some((removers) => removers.every(stays))) {
        kept.add(entry.change.id);
        grew = true;
      }
    }
  }
  const undone = entries.filter((entry) => !stays(entry.change.id));
  return {
    undone,
    removing: undone.filter((entry) => entry.change.change === "added").length,
    restoring: undone.filter((entry) => entry.change.change === "replaced").length,
    keeping: kept.size,
    leaving: left.size,
  };
};

const STILL_USED = "that records you keep still use";

/** What Undo is about to do, from the changes it will take back. */
export const undoPlanLabel = ({
  removing,
  restoring,
  keeping = 0,
}: {
  readonly removing: number;
  readonly restoring: number;
  readonly keeping?: number;
}): string => {
  const keeps = keeping === 0 ? "" : ` It keeps ${recordsLabel(keeping)} ${STILL_USED}.`;
  if (removing === 0 && restoring === 0) {
    return keeping === 0
      ? "Undo leaves every record as it is, because you changed each one after the import."
      : `Undo changes nothing.${keeps}`;
  }
  if (restoring === 0)
    return `Undo removes the ${recordsLabel(removing)} this import added.${keeps}`;
  if (removing === 0) {
    return `Undo puts back the ${recordsLabel(restoring)} this import replaced.${keeps}`;
  }
  return `Undo removes the ${recordsLabel(removing)} this import added and puts back the ${recordsLabel(restoring)} it replaced.${keeps}`;
};

/** What Undo did. */
export const undoOutcome = ({
  removed,
  restored,
  left,
  kept = 0,
}: {
  readonly removed: number;
  readonly restored: number;
  readonly left: number;
  readonly kept?: number;
}): string => {
  const done =
    removed > 0 && restored > 0
      ? `Removed ${recordsLabel(removed)} and put back ${recordsLabel(restored)}.`
      : removed > 0
        ? `Removed ${recordsLabel(removed)}.`
        : restored > 0
          ? `Put back ${recordsLabel(restored)}.`
          : "Nothing was taken back.";
  return [
    done,
    kept === 0 ? "" : ` Kept ${recordsLabel(kept)} ${STILL_USED}.`,
    left === 0 ? "" : ` Left ${recordsLabel(left)} you changed after the import.`,
  ].join("");
};
