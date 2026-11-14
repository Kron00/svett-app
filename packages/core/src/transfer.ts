import { Exit, Schema } from "effect";

import { LIBRARY_UPDATED_AT } from "./exercise-library.ts";
import { canonicalJson, contentFingerprint } from "./ids.ts";
import { setFieldsFromSets } from "./logger.ts";
import {
  EpochMillis,
  Fingerprint,
  type ImportChange,
  type ImportChangeId,
  type ImportSource,
  type MeasurementKind,
  type SetFields,
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
  activity: null,
  activityExercise: { table: "activity", key: "activityId" },
  activitySet: { table: "activityExercise", key: "activityExerciseId" },
  activityTrack: { table: "activity", key: "activityId" },
  activitySample: { table: "activityTrack", key: "activityTrackId" },
  folder: null,
  routine: null,
  routineExercise: { table: "routine", key: "routineId" },
  routineSet: { table: "routineExercise", key: "routineExerciseId" },
  measurement: null,
  proposal: null,
  coachMessage: null,
  gear: null,
};

/**
 * Keys that point at a row of another record, such as a workout exercise's exercise. Undo
 * keeps a record that a live row still points at, so no live row is left pointing at a
 * deleted one.
 */
export const REFERENCES: ReadonlyArray<{
  readonly table: TableKey;
  readonly key: string;
  readonly target: TableKey;
}> = [
  { table: "activityExercise", key: "exerciseId", target: "exercise" },
  { table: "routineExercise", key: "exerciseId", target: "exercise" },
  { table: "routine", key: "folderId", target: "folder" },
  { table: "activity", key: "routineId", target: "routine" },
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

/** Rows of some tables as they were read, before any schema checked them. */
export type RawRows = Partial<Record<TableKey, ReadonlyArray<unknown>>>;

type Fields = Readonly<Record<string, unknown>>;

type SetValues = Parameters<typeof setFieldsFromSets>[0][number];

const SET_VALUE_KEYS: ReadonlyArray<keyof SetValues> = [
  "weightKg",
  "reps",
  "durationS",
  "distanceM",
];

const fieldsOf = (raw: unknown): Fields | undefined =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Fields) : undefined;

/**
 * Each exercise's set fields as migration 4 gave an exercise logged before them, from all its
 * sets, deleted ones too.
 */
const setFieldsBySets = (sets: ReadonlyArray<unknown>) => {
  const byExercise = new Map<unknown, Array<SetValues>>();
  for (const raw of sets) {
    const set = fieldsOf(raw);
    if (set === undefined) continue;
    const list = byExercise.get(set["activityExerciseId"]) ?? [];
    list.push(
      Object.fromEntries(
        SET_VALUE_KEYS.map((key) => [key, set[key] ?? null]),
      ) as unknown as SetValues,
    );
    byExercise.set(set["activityExerciseId"], list);
  }
  return (exerciseId: unknown): SetFields =>
    setFieldsFromSets(byExercise.get(exerciseId) ?? []) ?? "weight_reps";
};

/**
 * Fields added after svett files and import journals were first written, with the value the
 * migration gave every row before them. A row written before a field existed reads with it,
 * and a row whose field still has that value fingerprints as it did before. A value can come
 * from the rows in `beside`, as an exercise's set fields come from its sets.
 */
const addedFields = (beside: RawRows): Partial<Record<TableKey, (row: Fields) => Fields>> => {
  let setFieldsOf: ((exerciseId: unknown) => SetFields) | undefined;
  return {
    activity: () => ({ status: "finished", routineId: null }),
    activityExercise: (row) => ({
      setFields: (setFieldsOf ??= setFieldsBySets(beside.activitySet ?? []))(row["id"]),
      restS: null,
    }),
    activitySet: () => ({ done: true, targetRepsMin: null, targetRepsMax: null }),
  };
};

/**
 * Raw rows with each field added since they were written filled in, ready for their schemas.
 * `beside` holds the rows a filled in value comes from, by default the rows themselves.
 */
export const withAddedFields = (rows: RawRows, beside: RawRows = rows): RawRows => {
  const added = addedFields(beside);
  return Object.fromEntries(
    Object.entries(rows).map(([key, list]) => {
      const fill = added[key as TableKey];
      return [
        key,
        fill === undefined
          ? list
          : (list ?? []).map((raw) => {
              const row = fieldsOf(raw);
              return row === undefined ? raw : Object.assign(fill(row), row);
            }),
      ];
    }),
  ) as RawRows;
};

/** Raw rows by table name, such as a journal keeps, by table. Unknown tables are left out. */
export const rawRowsByKey = (rows: Readonly<Record<string, ReadonlyArray<unknown>>>): RawRows =>
  Object.fromEntries(
    Object.entries(rows).flatMap(([name, list]) => {
      const key = tableKeyOf(name);
      return key === undefined ? [] : [[key, list]];
    }),
  ) as RawRows;

const withoutAddedFields = (rows: TableRows): TableRows => {
  const added = addedFields(rows);
  return Object.fromEntries(
    Object.entries(rows).map(([key, list]) => {
      const fill = added[key as TableKey];
      if (fill === undefined) return [key, list];
      return [
        key,
        (list ?? []).map((row) => {
          const first = fill(row);
          return Object.fromEntries(
            Object.entries(row).filter(
              ([field, value]) => !(field in first) || first[field] !== value,
            ),
          ) as AnyRow;
        }),
      ];
    }),
  ) as TableRows;
};

/** A workout still in progress, deleted or not. It is a draft on the phone that started it. */
const isDraft = (table: TableKey, row: AnyRow | undefined) =>
  table === "activity" && row !== undefined && row["status"] === "in_progress";

/**
 * The rows without any workout in progress and the rows below it. A workout in progress is
 * never exported, imported or synced.
 */
export const withoutDrafts = (rows: Snapshot): Snapshot => {
  const dropped = new Map<TableKey, Set<string>>();
  const kept = {} as Record<TableKey, ReadonlyArray<AnyRow>>;
  for (const key of TABLE_KEYS) {
    const parent = PARENT[key];
    const gone = new Set<string>();
    kept[key] = rows[key].filter((row) => {
      const drop =
        isDraft(key, row) ||
        (parent !== null && dropped.get(parent.table)?.has(String(row[parent.key])) === true);
      if (drop) gone.add(row.id);
      return !drop;
    });
    dropped.set(key, gone);
  }
  return kept;
};

/** What one record is called in a preview. */
const NOUN: Readonly<Record<TableKey, readonly [one: string, other: string]>> = {
  importBatch: ["import", "imports"],
  importChange: ["import record", "import records"],
  exercise: ["exercise", "exercises"],
  activity: ["workout", "workouts"],
  activityExercise: ["workout exercise", "workout exercises"],
  activitySet: ["workout set", "workout sets"],
  activityTrack: ["route", "routes"],
  activitySample: ["route point", "route points"],
  folder: ["folder", "folders"],
  routine: ["routine", "routines"],
  routineExercise: ["routine exercise", "routine exercises"],
  routineSet: ["routine set", "routine sets"],
  measurement: ["measurement", "measurements"],
  proposal: ["coach proposal", "coach proposals"],
  coachMessage: ["coach message", "coach messages"],
  gear: ["set of plates and bars", "sets of plates and bars"],
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
export const writtenOf = (rows: TableRows): Fingerprint => {
  const first = withoutAddedFields(rows);
  return Fingerprint.make(
    contentFingerprint(
      TABLE_KEYS.flatMap((table) =>
        [...(first[table] ?? [])]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((row) => [TABLES[table].name, row]),
      ),
    ),
  );
};

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
    case "gear":
      return { ...base, title: `Plates and bars in ${text(top["unit"])}`, at: null };
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
}

export type PlannedItem =
  | ({ readonly status: "new" } & Writes)
  | ({ readonly status: "changed" } & Writes)
  | { readonly status: "unchanged"; readonly summary: ItemSummary }
  | { readonly status: "skipped"; readonly summary: ItemSummary };

export interface ImportPlan {
  readonly items: ReadonlyArray<PlannedItem>;
  /** New records per table, in table order, for the tables that have any. */
  readonly added: ReadonlyArray<{ readonly table: TableKey; readonly count: number }>;
  /** New records the file holds only as deleted. Import keeps them, still deleted. */
  readonly deleted: number;
  /** Records here that the file holds another version of. Import keeps yours unless chosen. */
  readonly changed: ReadonlyArray<ItemSummary>;
  readonly unchanged: number;
  /** Workouts in progress, in the file or here. Import leaves them as they are. */
  readonly skipped: number;
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
 * is changed, and the preview lists it.
 */
export const planImport = (local: TableRows, incoming: TableRows): ImportPlan => {
  const lookup = Object.fromEntries(
    TABLE_KEYS.map((key) => [key, [...(incoming[key] ?? []), ...(local[key] ?? [])]]),
  ) as TableRows;
  const here = new Map(
    TABLE_KEYS.map((key) => [key, new Map((local[key] ?? []).map((row) => [row.id, row]))]),
  );
  const items: Array<PlannedItem> = [];
  for (const item of groupItems(incoming, lookup).values()) {
    const summary = summarize(item);
    if (
      isDraft(
        item.table,
        item.rows[item.table]?.find((row) => row.id === item.id),
      ) ||
      isDraft(item.table, here.get(item.table)?.get(item.id))
    ) {
      items.push({ status: "skipped", summary });
      continue;
    }
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
    if (Object.keys(writes).length === 0) items.push({ status: "unchanged", summary });
    else {
      items.push({ status: yours ? "changed" : "new", incoming: item, writes, replaced, summary });
    }
  }
  const added = TABLE_KEYS.map((table) => ({
    table,
    count: items.filter(
      (item) => item.status === "new" && item.summary.table === table && isLive(item.writes),
    ).length,
  })).filter(({ count }) => count > 0);
  return {
    items,
    added,
    deleted: items.filter((item) => item.status === "new" && !isLive(item.writes)).length,
    changed: items
      .filter((item) => item.status === "changed")
      .map((item) => item.summary)
      .sort(byTimeThenTitle),
    unchanged: items.filter((item) => item.status === "unchanged").length,
    skipped: items.filter((item) => item.status === "skipped").length,
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
  const replaced = change.replaced ?? {};
  const unknown = Object.keys(replaced).find((name) => tableKeyOf(name) === undefined);
  if (unknown !== undefined) return `it names a table svett does not know, ${unknown}`;
  const filled = withAddedFields(rawRowsByKey(replaced));
  for (const key of TABLE_KEYS) {
    const raws = filled[key];
    if (raws === undefined) continue;
    const name = TABLES[key].name;
    const decode = Schema.decodeUnknownExit(Schema.toType(TABLES[key].schema));
    for (const raw of raws) {
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
  plan.added.length === 0 && plan.deleted === 0 && plan.changed.length === 0;

export const recordsLabel = (count: number): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "record" : "records"}`;

const workoutsLabel = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "workout" : "workouts"}`;

/** Why an import leaves workouts in progress out, or undefined when it leaves none out. */
export const skippedLabel = (skipped: number): string | undefined =>
  skipped === 0
    ? undefined
    : `Import skips ${workoutsLabel(skipped)} in progress. A workout in progress stays on the phone that started it until it is finished.`;

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
  discarded = 0,
}: {
  readonly removed: number;
  readonly restored: number;
  readonly left: number;
  readonly kept?: number;
  readonly discarded?: number;
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
    discarded === 0
      ? ""
      : ` Kept ${workoutsLabel(discarded)} in progress discarded, because another workout is in progress.`,
  ].join("");
};
