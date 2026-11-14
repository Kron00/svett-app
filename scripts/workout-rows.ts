// Reads a logged workout out of a svett database file, for the logger proof.
// Usage: node scripts/workout-rows.ts routine <database.db> <routine title>
//        node scripts/workout-rows.ts workout <database.db> <workout title>
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

const open = (path: string) => new DatabaseSync(path, { readOnly: true });

/** The ID of the live routine with this title, or null. */
export function routineId(path: string, title: string): string | null {
  const database = open(path);
  try {
    const row = database
      .prepare(
        "SELECT id FROM routine WHERE deleted_at IS NULL AND title = ? ORDER BY position, id",
      )
      .get(title);
    return row === undefined ? null : String(row["id"]);
  } finally {
    database.close();
  }
}

const value = (row: Row, column: string, unit: string) =>
  row[column] === null ? [] : [`${String(row[column])} ${unit}`];

/**
 * The newest live workout with this title as lines a person can read and a script can match:
 * its status, then each live exercise in order with what it records, then each live set.
 * Null when there is no such workout.
 */
export function workoutRows(path: string, title: string): ReadonlyArray<string> | null {
  const database = open(path);
  try {
    const activity = database
      .prepare(
        "SELECT id, status, notes FROM activity WHERE deleted_at IS NULL AND title = ? ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get(title);
    if (activity === undefined) return null;
    const inProgress = database
      .prepare(
        "SELECT count(*) AS n FROM activity WHERE deleted_at IS NULL AND status = 'in_progress'",
      )
      .get();
    const lines = [
      `${title}: ${String(activity["status"])}`,
      `Notes: ${String(activity["notes"]) || "none"}`,
      `Workouts in progress: ${String(inProgress?.["n"])}`,
    ];
    const exercises = database
      .prepare(
        `SELECT e.id, e.set_fields, e.notes, coalesce(x.name, 'Deleted exercise') AS name
         FROM activity_exercise e LEFT JOIN exercise x ON x.id = e.exercise_id
         WHERE e.deleted_at IS NULL AND e.activity_id = ? ORDER BY e.position, e.id`,
      )
      .all(String(activity["id"]));
    for (const [index, exercise] of exercises.entries()) {
      const notes = String(exercise["notes"]);
      lines.push(
        `Exercise ${index + 1}: ${String(exercise["name"])}, by ${String(exercise["set_fields"])}${notes === "" ? "" : `, notes: ${notes}`}`,
      );
      const sets = database
        .prepare(
          `SELECT set_type, weight_kg, reps, duration_s, distance_m, done FROM activity_set
           WHERE deleted_at IS NULL AND activity_exercise_id = ? ORDER BY position, id`,
        )
        .all(String(exercise["id"]));
      for (const [setIndex, set] of sets.entries()) {
        const values = [
          ...value(set, "weight_kg", "kg"),
          ...value(set, "reps", "reps"),
          ...value(set, "duration_s", "s"),
          ...value(set, "distance_m", "m"),
        ];
        lines.push(
          `Set ${index + 1}.${setIndex + 1}: ${[String(set["set_type"]), ...values, set["done"] === 1 ? "done" : "to do"].join(", ")}`,
        );
      }
    }
    return lines;
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  const [command, path, title] = process.argv.slice(2);
  if (command === "routine" && path && title) {
    const id = routineId(path, title);
    if (id === null) {
      console.error(`No routine is called "${title}"`);
      process.exitCode = 1;
    } else {
      console.log(id);
    }
  } else if (command === "workout" && path && title) {
    const lines = workoutRows(path, title);
    if (lines === null) {
      console.error(`No workout is called "${title}"`);
      process.exitCode = 1;
    } else {
      console.log(lines.join("\n"));
    }
  } else {
    console.error(
      "Usage: node scripts/workout-rows.ts routine <database.db> <title> | workout <database.db> <title>",
    );
    process.exitCode = 64;
  }
}
