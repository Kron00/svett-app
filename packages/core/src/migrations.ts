import { Clock, Data, Effect } from "effect";

import { Sql } from "./sql.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const row = "id TEXT PRIMARY KEY NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER";
const provenance = "source TEXT NOT NULL, source_id TEXT, fingerprint TEXT, import_batch_id TEXT";

// Enums are checked by the Effect Schemas, not by SQL CHECK constraints, and there are no
// foreign keys: SQLite cannot drop either without rebuilding the table, and phase 6 sync may
// deliver a child row before its parent.
const initial = `
CREATE TABLE import_batch (${row}, source TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL) STRICT;

CREATE TABLE exercise (${row}, name TEXT NOT NULL, category TEXT NOT NULL, equipment TEXT NOT NULL,
  primary_muscles TEXT NOT NULL, secondary_muscles TEXT NOT NULL, ${provenance}) STRICT;
CREATE INDEX exercise_name ON exercise (name);

CREATE TABLE activity (${row}, kind TEXT NOT NULL, started_at INTEGER NOT NULL, duration_s REAL NOT NULL,
  title TEXT NOT NULL, notes TEXT NOT NULL, energy_kcal REAL,
  audience TEXT NOT NULL DEFAULT 'only_you', hidden_fields TEXT NOT NULL DEFAULT '[]', ${provenance}) STRICT;
CREATE INDEX activity_started_at ON activity (started_at);
CREATE INDEX activity_import_batch ON activity (import_batch_id);

CREATE TABLE activity_exercise (${row}, activity_id TEXT NOT NULL, exercise_id TEXT NOT NULL,
  position INTEGER NOT NULL, superset_group INTEGER, notes TEXT NOT NULL) STRICT;
CREATE INDEX activity_exercise_activity ON activity_exercise (activity_id);
CREATE INDEX activity_exercise_exercise ON activity_exercise (exercise_id);

CREATE TABLE activity_set (${row}, activity_exercise_id TEXT NOT NULL, position INTEGER NOT NULL,
  set_type TEXT NOT NULL, weight_kg REAL, reps INTEGER, duration_s REAL, distance_m REAL, rpe REAL) STRICT;
CREATE INDEX activity_set_exercise ON activity_set (activity_exercise_id);

CREATE TABLE activity_track (${row}, activity_id TEXT NOT NULL, distance_m REAL, elevation_gain_m REAL,
  hide_start_m REAL NOT NULL, hide_end_m REAL NOT NULL) STRICT;
CREATE INDEX activity_track_activity ON activity_track (activity_id);

CREATE TABLE activity_sample (${row}, activity_track_id TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  kind TEXT NOT NULL, latitude REAL, longitude REAL, altitude_m REAL, bpm INTEGER, distance_m REAL, duration_s REAL) STRICT;
CREATE INDEX activity_sample_track ON activity_sample (activity_track_id, recorded_at);

CREATE TABLE folder (${row}, name TEXT NOT NULL, position INTEGER NOT NULL) STRICT;

CREATE TABLE routine (${row}, folder_id TEXT, title TEXT NOT NULL, notes TEXT NOT NULL, position INTEGER NOT NULL) STRICT;
CREATE INDEX routine_folder ON routine (folder_id);

CREATE TABLE routine_exercise (${row}, routine_id TEXT NOT NULL, exercise_id TEXT NOT NULL,
  position INTEGER NOT NULL, superset_group INTEGER, rest_s REAL, notes TEXT NOT NULL) STRICT;
CREATE INDEX routine_exercise_routine ON routine_exercise (routine_id);

CREATE TABLE routine_set (${row}, routine_exercise_id TEXT NOT NULL, position INTEGER NOT NULL,
  set_type TEXT NOT NULL, weight_kg REAL, reps_min INTEGER, reps_max INTEGER, duration_s REAL, distance_m REAL) STRICT;
CREATE INDEX routine_set_exercise ON routine_set (routine_exercise_id);

CREATE TABLE measurement (${row}, kind TEXT NOT NULL, measured_at INTEGER NOT NULL, value REAL NOT NULL, ${provenance}) STRICT;
CREATE INDEX measurement_kind ON measurement (kind, measured_at);

CREATE TABLE proposal (${row}, origin TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, coach_message_id TEXT) STRICT;
CREATE INDEX proposal_created ON proposal (created_at);

CREATE TABLE coach_message (${row}, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  created_at INTEGER NOT NULL) STRICT;
CREATE INDEX coach_message_conversation ON coach_message (conversation_id, created_at);
`;

const importChanges = `
CREATE TABLE import_change (${row}, import_batch_id TEXT NOT NULL, change TEXT NOT NULL, item_table TEXT NOT NULL,
  item_id TEXT NOT NULL, title TEXT NOT NULL, item_at INTEGER, row_ids TEXT NOT NULL, replaced TEXT,
  written TEXT NOT NULL) STRICT;
CREATE INDEX import_change_batch ON import_change (import_batch_id);
`;

const exerciseAliases = `
CREATE TABLE exercise_alias (${row}, source TEXT NOT NULL, name TEXT NOT NULL, exercise_id TEXT NOT NULL) STRICT;
CREATE INDEX exercise_alias_name ON exercise_alias (source, name);
`;

// Every activity before this one was finished, and every set in it done.
const workoutInProgress = `
ALTER TABLE activity ADD COLUMN status TEXT NOT NULL DEFAULT 'finished';
ALTER TABLE activity ADD COLUMN routine_id TEXT;
CREATE INDEX activity_status ON activity (status);
ALTER TABLE activity_set ADD COLUMN done INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activity_set ADD COLUMN target_reps_min INTEGER;
ALTER TABLE activity_set ADD COLUMN target_reps_max INTEGER;
`;

const has = (column: string) =>
  `EXISTS (SELECT 1 FROM activity_set s WHERE s.activity_exercise_id = activity_exercise.id AND s.${column} IS NOT NULL)`;

// An exercise logged before this records what its sets hold, as setFieldsFromSets decides.
const setFields = `
ALTER TABLE activity_exercise ADD COLUMN set_fields TEXT NOT NULL DEFAULT 'weight_reps';
UPDATE activity_exercise SET set_fields = CASE
  WHEN ${has("distance_m")} THEN CASE WHEN ${has("weight_kg")} THEN 'weight_distance' ELSE 'distance_time' END
  WHEN ${has("duration_s")} THEN CASE WHEN ${has("weight_kg")} THEN 'weight_time' ELSE 'time' END
  WHEN ${has("reps")} AND NOT ${has("weight_kg")} THEN 'reps'
  ELSE 'weight_reps'
END;
`;

// Exercises logged before the rest timer have no rest time, which the timer reads as off.
const restTimer = `
ALTER TABLE activity_exercise ADD COLUMN rest_s REAL;
`;

// Plates and bars as JSON arrays, one row per weight unit.
const gear = `
CREATE TABLE gear (${row}, unit TEXT NOT NULL, plates TEXT NOT NULL, bars TEXT NOT NULL) STRICT;
`;

// A recorded route is one line per stretch between pauses. Earlier location samples
// came from one stretch.
const sampleSegment = `
ALTER TABLE activity_sample ADD COLUMN segment INTEGER;
UPDATE activity_sample SET segment = 0 WHERE kind = 'location';
`;

// The tables migration 9 syncs, frozen as they were then. A table added later needs its own
// triggers in its own migration.
const syncedAtVersion9 = [
  "import_batch",
  "import_change",
  "exercise",
  "activity",
  "activity_exercise",
  "activity_set",
  "activity_track",
  "activity_sample",
  "folder",
  "routine",
  "routine_exercise",
  "routine_set",
  "measurement",
  "exercise_alias",
  "gear",
];

// Every write made on this phone queues its row, whichever code wrote it, unless sync is
// applying rows from the server or the bundled exercise library is being seeded, which every
// phone does for itself. A row queued again gets a new mark, so a confirmation of the copy
// sent before leaves the newer change queued.
const queueTrigger = (table: string, event: "INSERT" | "UPDATE", unless?: string) => `
CREATE TRIGGER ${table}_queue_${event.toLowerCase()} AFTER ${event} ON ${table}
WHEN (SELECT quiet FROM sync_state) = 0${unless === undefined ? "" : ` AND NOT (${unless})`}
BEGIN
  UPDATE sync_state SET mark = mark + 1;
  -- The outer statement's conflict policy overrides one written here, so no OR REPLACE.
  DELETE FROM sync_outbox WHERE table_name = '${table}' AND row_id = NEW.id;
  INSERT INTO sync_outbox (table_name, row_id, mark)
    VALUES ('${table}', NEW.id, (SELECT mark FROM sync_state));
END;`;

// `clock` is the hybrid logical clock: the time the last change written here took, or the
// newest change sync applied. It starts after every row already here.
const sync = `
CREATE TABLE sync_state (id INTEGER PRIMARY KEY NOT NULL, quiet INTEGER NOT NULL,
  mark INTEGER NOT NULL, cursor INTEGER NOT NULL, clock INTEGER NOT NULL,
  newest_seen INTEGER NOT NULL) STRICT;
INSERT INTO sync_state (id, quiet, mark, cursor, clock, newest_seen) VALUES (1, 0, 0, 0, max(0, ${[
  ...syncedAtVersion9,
  "proposal",
  "coach_message",
]
  .map((table) => `(SELECT coalesce(max(updated_at), 0) FROM ${table})`)
  .join(", ")}), 0);
CREATE TABLE sync_outbox (table_name TEXT NOT NULL, row_id TEXT NOT NULL, mark INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id)) STRICT;
CREATE INDEX sync_outbox_mark ON sync_outbox (mark);
${syncedAtVersion9
  .map(
    (table) =>
      `INSERT INTO sync_outbox (table_name, row_id, mark) SELECT '${table}', id, 0 FROM ${table}${
        // Library rows still at the bundled time 0 are unedited.
        table === "exercise" ? " WHERE source <> 'library' OR updated_at <> 0" : ""
      };`,
  )
  .join("\n")}
${syncedAtVersion9.flatMap((table) => [queueTrigger(table, "INSERT"), queueTrigger(table, "UPDATE")]).join("\n")}
`;

// A workout in progress is a draft that stays on the phone until it is finished. These say,
// for a row of each workout table, frozen as they were at migration 10, whether the workout it
// belongs to is in progress.
const inDraft: Readonly<Record<string, (row: string) => string>> = {
  activity: (target) => `${target}.status = 'in_progress'`,
  activity_exercise: (target) =>
    `EXISTS (SELECT 1 FROM activity WHERE id = ${target}.activity_id AND status = 'in_progress')`,
  activity_track: (target) =>
    `EXISTS (SELECT 1 FROM activity WHERE id = ${target}.activity_id AND status = 'in_progress')`,
  activity_set: (target) =>
    `EXISTS (SELECT 1 FROM activity_exercise e JOIN activity a ON a.id = e.activity_id
      WHERE e.id = ${target}.activity_exercise_id AND a.status = 'in_progress')`,
  activity_sample: (target) =>
    `EXISTS (SELECT 1 FROM activity_track t JOIN activity a ON a.id = t.activity_id
      WHERE t.id = ${target}.activity_track_id AND a.status = 'in_progress')`,
};

/** Every table of a workout but the activity, and the rows of each under the workout `id`. */
const workoutChildren = (id: string): ReadonlyArray<readonly [string, string]> => [
  ["activity_exercise", `activity_id = ${id}`],
  [
    "activity_set",
    `activity_exercise_id IN (SELECT id FROM activity_exercise WHERE activity_id = ${id})`,
  ],
  ["activity_track", `activity_id = ${id}`],
  [
    "activity_sample",
    `activity_track_id IN (SELECT id FROM activity_track WHERE activity_id = ${id})`,
  ],
];

/** Every row of the workout `id`, deleted ones too, as (table_name, row_id). */
const workoutRows = (id: string) => `
  SELECT 'activity' AS table_name, id AS row_id FROM activity WHERE id = ${id}
${workoutChildren(id)
  .map(([table, where]) => `  UNION ALL SELECT '${table}', id FROM ${table} WHERE ${where}`)
  .join("\n")}`;

// The columns of each workout table at migration 10, frozen, for the copies kept aside.
const workoutColumns: Readonly<Record<string, ReadonlyArray<string>>> = {
  activity: [
    "id",
    "updated_at",
    "deleted_at",
    "kind",
    "status",
    "routine_id",
    "started_at",
    "duration_s",
    "title",
    "notes",
    "energy_kcal",
    "audience",
    "hidden_fields",
    "source",
    "source_id",
    "fingerprint",
    "import_batch_id",
  ],
  activity_exercise: [
    "id",
    "updated_at",
    "deleted_at",
    "activity_id",
    "exercise_id",
    "position",
    "superset_group",
    "notes",
    "set_fields",
    "rest_s",
  ],
  activity_set: [
    "id",
    "updated_at",
    "deleted_at",
    "activity_exercise_id",
    "position",
    "set_type",
    "weight_kg",
    "reps",
    "duration_s",
    "distance_m",
    "rpe",
    "done",
    "target_reps_min",
    "target_reps_max",
  ],
  activity_track: [
    "id",
    "updated_at",
    "deleted_at",
    "activity_id",
    "distance_m",
    "elevation_gain_m",
    "hide_start_m",
    "hide_end_m",
  ],
  activity_sample: [
    "id",
    "updated_at",
    "deleted_at",
    "activity_track_id",
    "recorded_at",
    "kind",
    "latitude",
    "longitude",
    "altitude_m",
    "bpm",
    "distance_m",
    "duration_s",
    "segment",
  ],
};

/** A row of `table` as sync sends it, a JSON object keyed by field, read from `source`. */
const rowJson = (table: string, source: string) =>
  `json_object(${(workoutColumns[table] ?? [])
    .map(
      (column) =>
        `'${column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}', ${source}.${column}`,
    )
    .join(", ")})`;

// Writes to a workout in progress queue nothing. Finishing it queues every row it has, the
// ones written while it was in progress too, each with its own time, and a finished workout
// put back in progress takes its rows out of the queue again. Discarding one sends nothing of
// what was written while it was in progress. The rows a database already queued for a
// workout in progress leave the queue.
//
// A pull leaves a workout in progress here alone. The copies it brings of the workout's rows
// wait in sync_aside, which never syncs, until the workout is finished or discarded. Putting
// a finished workout back in progress first keeps aside its rows as they are, so a discard
// can put it back as every other phone has it.
const localDrafts = `
CREATE TABLE sync_aside (table_name TEXT NOT NULL, row_id TEXT NOT NULL,
  workout_id TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (table_name, row_id)) STRICT;
CREATE INDEX sync_aside_workout ON sync_aside (workout_id);
${Object.keys(inDraft)
  .flatMap((table) => [
    `DROP TRIGGER ${table}_queue_insert;`,
    `DROP TRIGGER ${table}_queue_update;`,
  ])
  .join("\n")}
${Object.entries(inDraft)
  .flatMap(([table, draft]) =>
    table === "activity"
      ? [queueTrigger(table, "INSERT", draft("NEW"))]
      : [queueTrigger(table, "INSERT", draft("NEW")), queueTrigger(table, "UPDATE", draft("NEW"))],
  )
  .join("\n")}
CREATE TRIGGER activity_queue_update AFTER UPDATE ON activity
WHEN (SELECT quiet FROM sync_state) = 0
BEGIN
  UPDATE sync_state SET mark = mark + 1;
  DELETE FROM sync_outbox WHERE (table_name, row_id) IN (${workoutRows("NEW.id")})
    AND (OLD.status = 'in_progress' OR NEW.status = 'in_progress');
  DELETE FROM sync_outbox WHERE table_name = 'activity' AND row_id = NEW.id;
  INSERT INTO sync_outbox (table_name, row_id, mark)
    SELECT table_name, row_id, (SELECT mark FROM sync_state) FROM (${workoutRows("NEW.id")})
    WHERE NEW.status <> 'in_progress' AND (OLD.status = 'in_progress' OR table_name = 'activity');
END;
CREATE TRIGGER activity_keep_aside AFTER UPDATE OF status ON activity
WHEN OLD.status <> 'in_progress' AND NEW.status = 'in_progress'
BEGIN
  DELETE FROM sync_aside WHERE workout_id = NEW.id;
  INSERT INTO sync_aside (table_name, row_id, workout_id, row)
    VALUES ('activity', NEW.id, NEW.id, ${rowJson("activity", "OLD")});
${workoutChildren("NEW.id")
  .map(
    ([table, where]) =>
      `  INSERT INTO sync_aside (table_name, row_id, workout_id, row)
    SELECT '${table}', id, NEW.id, ${rowJson(table, table)} FROM ${table} WHERE ${where};`,
  )
  .join("\n")}
END;
${Object.entries(inDraft)
  .map(
    ([table, draft]) =>
      `DELETE FROM sync_outbox WHERE table_name = '${table}' AND row_id IN (SELECT id FROM ${table} AS queued WHERE ${draft("queued")});`,
  )
  .join("\n")}
`;

// An Undo on this phone, or any write here that brings back a deleted workout row or moves its
// deletion, reverses that deletion. The server needs it named only when it may hold it, so
// `sync_unsent_deletion` keeps each deletion made here that no push has carried yet. It takes
// only a deletion stamped with the time this phone just took, never a deleted copy an import
// brings, which another phone may have sent. A reversed deletion still there never left the
// phone and is dropped. Any other goes in `sync_restore`, sent with the row until the server
// confirms a copy sent with it, since a push on the way can leave the server with the deletion
// before or after it, and only the server knows which. Writes sync applies run quietly and
// record nothing.
const syncRestores = `
CREATE TABLE sync_restore (table_name TEXT NOT NULL, row_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL, PRIMARY KEY (table_name, row_id, deleted_at)) STRICT;
CREATE TABLE sync_unsent_deletion (table_name TEXT NOT NULL, row_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL, PRIMARY KEY (table_name, row_id, deleted_at)) STRICT;
${Object.keys(workoutColumns)
  .map(
    (table) => `CREATE TRIGGER ${table}_delete_insert AFTER INSERT ON ${table}
WHEN (SELECT quiet FROM sync_state) = 0 AND NEW.deleted_at = (SELECT clock FROM sync_state)
BEGIN
  INSERT OR IGNORE INTO sync_unsent_deletion (table_name, row_id, deleted_at)
    VALUES ('${table}', NEW.id, NEW.deleted_at);
END;
CREATE TRIGGER ${table}_delete AFTER UPDATE OF deleted_at ON ${table}
WHEN (SELECT quiet FROM sync_state) = 0 AND NEW.deleted_at = (SELECT clock FROM sync_state)
  AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT OR IGNORE INTO sync_unsent_deletion (table_name, row_id, deleted_at)
    VALUES ('${table}', NEW.id, NEW.deleted_at);
END;
CREATE TRIGGER ${table}_restore AFTER UPDATE OF deleted_at ON ${table}
WHEN (SELECT quiet FROM sync_state) = 0 AND OLD.deleted_at IS NOT NULL
  AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT OR IGNORE INTO sync_restore (table_name, row_id, deleted_at)
    SELECT '${table}', NEW.id, OLD.deleted_at WHERE NOT EXISTS (SELECT 1 FROM sync_unsent_deletion
      WHERE table_name = '${table}' AND row_id = NEW.id AND deleted_at = OLD.deleted_at);
  DELETE FROM sync_unsent_deletion
    WHERE table_name = '${table}' AND row_id = NEW.id AND deleted_at = OLD.deleted_at;
END;`,
  )
  .join("\n")}
`;

/** Applied in order and never edited once released. A change to the schema is a new migration. */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, name: "initial", sql: initial },
  { version: 2, name: "import changes", sql: importChanges },
  { version: 3, name: "exercise aliases", sql: exerciseAliases },
  { version: 4, name: "workout in progress", sql: workoutInProgress },
  { version: 5, name: "set fields", sql: setFields },
  { version: 6, name: "rest timer", sql: restTimer },
  { version: 7, name: "plates and bars", sql: gear },
  { version: 8, name: "sample segment", sql: sampleSegment },
  { version: 9, name: "sync", sql: sync },
  { version: 10, name: "workout drafts stay on the phone", sql: localDrafts },
  { version: 11, name: "sync restores", sql: syncRestores },
];

export class DatabaseTooNewError extends Data.TaggedError("DatabaseTooNewError")<{
  readonly databaseVersion: number;
  readonly knownVersion: number;
}> {}

/**
 * Brings the database up to the last migration. Each migration runs in its own
 * transaction with its version row, so a crash leaves the database at a known version
 * and the next run continues from there.
 */
export const migrate = (migrations: ReadonlyArray<Migration> = MIGRATIONS) =>
  Effect.gen(function* () {
    if (migrations.some((migration, index) => migration.version !== index + 1)) {
      return yield* Effect.die(new Error("Migrations must be numbered 1, 2, 3 and so on"));
    }
    const sql = yield* Sql;
    yield* sql.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
    );
    const from = yield* currentVersion;
    if (from > migrations.length) {
      return yield* new DatabaseTooNewError({
        databaseVersion: from,
        knownVersion: migrations.length,
      });
    }
    for (const migration of migrations.slice(from)) {
      const appliedAt = yield* Clock.currentTimeMillis;
      yield* sql.transaction(
        Effect.gen(function* () {
          yield* sql.exec(migration.sql);
          yield* sql.run(
            "INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)",
            [migration.version, migration.name, appliedAt],
          );
        }),
      );
    }
    return { from, to: migrations.length };
  });

export const currentVersion = Effect.gen(function* () {
  const sql = yield* Sql;
  const rows = yield* sql.all("SELECT coalesce(max(version), 0) AS version FROM schema_version");
  return Number(rows[0]?.["version"] ?? 0);
});
