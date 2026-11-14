import { Clock, Data, Effect, Option, Schema } from "effect";

import * as Model from "./schema.ts";
import { Sql, type SqlError, type SqlValue } from "./sql.ts";

type RowBase = {
  readonly id: string;
  readonly updatedAt: Model.EpochMillis;
  readonly deletedAt: Model.EpochMillis | null;
};

export interface Table<A extends RowBase> {
  readonly name: string;
  readonly schema: Schema.Codec<A, unknown>;
  /** Row keys in camelCase. The SQL column of each is its snake_case form. */
  readonly keys: ReadonlyArray<string>;
}

type FieldsSchema = { readonly fields: Readonly<Record<string, unknown>> };
type UnionSchema = { readonly members: ReadonlyArray<FieldsSchema> };

const keysOf = (schema: FieldsSchema | UnionSchema): ReadonlyArray<string> =>
  "fields" in schema
    ? Object.keys(schema.fields)
    : [...new Set(schema.members.flatMap((member) => Object.keys(member.fields)))];

const table = <A extends RowBase>(
  name: string,
  schema: Schema.Codec<A, unknown> & (FieldsSchema | UnionSchema),
): Table<A> => ({ name, schema, keys: keysOf(schema) });

/** Every table svett stores, in an order where parents come before their children. */
export const TABLES = {
  importBatch: table("import_batch", Model.ImportBatch),
  importChange: table("import_change", Model.ImportChange),
  exercise: table("exercise", Model.Exercise),
  exerciseAlias: table("exercise_alias", Model.ExerciseAlias),
  activity: table("activity", Model.Activity),
  activityExercise: table("activity_exercise", Model.ActivityExercise),
  activitySet: table("activity_set", Model.ActivitySet),
  activityTrack: table("activity_track", Model.ActivityTrack),
  activitySample: table("activity_sample", Model.ActivitySample),
  folder: table("folder", Model.Folder),
  routine: table("routine", Model.Routine),
  routineExercise: table("routine_exercise", Model.RoutineExercise),
  routineSet: table("routine_set", Model.RoutineSet),
  measurement: table("measurement", Model.Measurement),
  proposal: table("proposal", Model.Proposal),
  coachMessage: table("coach_message", Model.CoachMessage),
  gear: table("gear", Model.Gear),
} as const;

type TableName = { readonly name: string };

export const columnOf = (key: string): string =>
  key.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export class InvalidRowError extends Data.TaggedError("InvalidRowError")<{
  readonly table: string;
  readonly message: string;
}> {}

export class RowNotFoundError extends Data.TaggedError("RowNotFoundError")<{
  readonly table: string;
  readonly id: string;
}> {}

/**
 * The time a change written here takes, from the database's hybrid logical clock: the wall
 * clock, or one past the last time the database handed out or took from sync, whichever is
 * later. Two writes in the same millisecond, or after the wall clock moved back, still come
 * in order, and an edit always comes after the copy it edited. The clock is kept in the
 * database, so it survives a restart.
 */
export const currentTime: Effect.Effect<Model.EpochMillis, SqlError, Sql> = Effect.gen(
  function* () {
    const millis = yield* Clock.currentTimeMillis;
    const sql = yield* Sql;
    const [row] = yield* sql.all(
      "UPDATE sync_state SET clock = max(clock + 1, ?) WHERE id = 1 RETURNING clock",
      [millis],
    );
    return Model.EpochMillis.make(Number(row?.["clock"] ?? millis));
  },
);

const encode = <A extends RowBase>(target: Table<A>, row: A) =>
  Schema.encodeEffect(target.schema)(row).pipe(
    Effect.mapError((issue) => new InvalidRowError({ table: target.name, message: issue.message })),
    Effect.map((encoded) =>
      target.keys.map((key) => (encoded as Record<string, SqlValue | undefined>)[key] ?? null),
    ),
  );

const selectList = (target: { readonly keys: ReadonlyArray<string> }) =>
  target.keys.map(columnOf).join(", ");

export const insertRows = <A extends RowBase>(target: Table<A>, rows: ReadonlyArray<A>) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const statement = `INSERT INTO ${target.name} (${selectList(target)}) VALUES (${target.keys.map(() => "?").join(", ")})`;
    for (const row of rows) {
      yield* sql.run(statement, yield* encode(target, row));
    }
  });

/**
 * Writes whole rows that arrive with their own IDs, such as a svett file's. A row with
 * the same ID, live or deleted, is replaced.
 */
export const putRows = <A extends RowBase>(target: Table<A>, rows: ReadonlyArray<A>) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const columns = target.keys.map(columnOf);
    const statement = `INSERT INTO ${target.name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (id) DO UPDATE SET ${columns
      .filter((column) => column !== "id")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ")}`;
    for (const row of rows) {
      yield* sql.run(statement, yield* encode(target, row));
    }
  });

const readRows = <A extends RowBase>(
  target: Table<A>,
  where: string,
  params: ReadonlyArray<SqlValue>,
  orderBy: string,
) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const rows = yield* sql.all(
      `SELECT ${selectList(target)} FROM ${target.name} WHERE ${where} ORDER BY ${orderBy}`,
      params,
    );
    const decode = Schema.decodeUnknownSync(target.schema);
    return rows.map((row) =>
      decode(Object.fromEntries(target.keys.map((key) => [key, row[columnOf(key)] ?? null]))),
    );
  });

/** Reads the live rows that match `where`. Rows with `deleted_at` set are never returned. */
export const selectRows = <A extends RowBase>(
  target: Table<A>,
  where = "1 = 1",
  params: ReadonlyArray<SqlValue> = [],
  orderBy = "id",
) => readRows(target, `deleted_at IS NULL AND (${where})`, params, orderBy);

/**
 * Reads the rows that match `where`, deleted ones too. Only export, import and Undo need
 * deleted rows, so that a deletion travels with the data like any other change.
 */
export const selectRowsWithDeleted = <A extends RowBase>(
  target: Table<A>,
  where = "1 = 1",
  params: ReadonlyArray<SqlValue> = [],
) => readRows(target, `(${where})`, params, "id");

export const selectById = <A extends RowBase>(target: Table<A>, id: string) =>
  Effect.map(selectRows(target, "id = ?", [id]), (rows) => Option.fromNullishOr(rows[0]));

export type Patch<A> = Partial<Omit<A, "id" | "updatedAt" | "deletedAt">>;

/** Reads the row, applies the patch, and writes it back only if the result is a valid row. */
export const updateRow = <A extends RowBase>(target: Table<A>, id: string, patch: Patch<A>) =>
  Effect.flatMap(Effect.service(Sql), (sql) =>
    sql.transaction(
      Effect.gen(function* () {
        const current = yield* selectById(target, id);
        if (Option.isNone(current)) {
          return yield* new RowNotFoundError({ table: target.name, id });
        }
        const next = { ...current.value, ...patch, updatedAt: yield* currentTime } as A;
        const values = yield* encode(target, next);
        yield* sql.run(
          `UPDATE ${target.name} SET ${target.keys.map((key) => `${columnOf(key)} = ?`).join(", ")} WHERE id = ?`,
          [...values, id],
        );
        return next;
      }),
    ),
  );

/** Marks matching live rows deleted at `at`. Returns how many rows it changed. */
export const softDeleteRows = (
  target: TableName,
  where: string,
  params: ReadonlyArray<SqlValue>,
  at: Model.EpochMillis,
): Effect.Effect<number, SqlError, Sql> =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const changed = yield* sql.all(
      `UPDATE ${target.name} SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND (${where}) RETURNING id`,
      [at, at, ...params],
    );
    return changed.length;
  });

/** Brings back the rows that one delete removed, identified by its `deleted_at` time. */
export const restoreRows = (
  target: TableName,
  where: string,
  params: ReadonlyArray<SqlValue>,
  deletedAt: Model.EpochMillis,
  at: Model.EpochMillis,
): Effect.Effect<void, SqlError, Sql> =>
  Effect.flatMap(Effect.service(Sql), (sql) =>
    sql.run(
      `UPDATE ${target.name} SET deleted_at = NULL, updated_at = ? WHERE deleted_at = ? AND (${where})`,
      [at, deletedAt, ...params],
    ),
  );

export const countRows = (
  target: TableName,
  where = "1 = 1",
  params: ReadonlyArray<SqlValue> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    const rows = yield* sql.all(
      `SELECT count(*) AS n FROM ${target.name} WHERE deleted_at IS NULL AND (${where})`,
      params,
    );
    return Number(rows[0]?.["n"] ?? 0);
  });
