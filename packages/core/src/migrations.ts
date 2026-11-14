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

// The tables migration 4 syncs, frozen as they were then. A table added later needs its own
// triggers in its own migration.
const syncedAtVersion4 = [
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
];

// Every write made on this phone queues its row, whichever code wrote it, unless sync is
// applying rows from the server or the bundled exercise library is being seeded, which every
// phone does for itself. A row queued again gets a new mark, so a confirmation of the copy
// sent before leaves the newer change queued.
const queueTrigger = (table: string, event: "INSERT" | "UPDATE") => `
CREATE TRIGGER ${table}_queue_${event.toLowerCase()} AFTER ${event} ON ${table}
WHEN (SELECT quiet FROM sync_state) = 0
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
  ...syncedAtVersion4,
  "proposal",
  "coach_message",
]
  .map((table) => `(SELECT coalesce(max(updated_at), 0) FROM ${table})`)
  .join(", ")}), 0);
CREATE TABLE sync_outbox (table_name TEXT NOT NULL, row_id TEXT NOT NULL, mark INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id)) STRICT;
CREATE INDEX sync_outbox_mark ON sync_outbox (mark);
${syncedAtVersion4
  .map(
    (table) =>
      `INSERT INTO sync_outbox (table_name, row_id, mark) SELECT '${table}', id, 0 FROM ${table}${
        // Library rows still at the bundled time 0 are unedited.
        table === "exercise" ? " WHERE source <> 'library' OR updated_at <> 0" : ""
      };`,
  )
  .join("\n")}
${syncedAtVersion4.flatMap((table) => [queueTrigger(table, "INSERT"), queueTrigger(table, "UPDATE")]).join("\n")}
`;

/** Applied in order and never edited once released. A change to the schema is a new migration. */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, name: "initial", sql: initial },
  { version: 2, name: "import changes", sql: importChanges },
  { version: 3, name: "exercise aliases", sql: exerciseAliases },
  { version: 4, name: "sync", sql: sync },
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
