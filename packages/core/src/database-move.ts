import { Effect, Schema } from "effect";

import type { SqlService, SqlValue } from "./sql.ts";
import { columnOf, InvalidRowError, TABLES } from "./table.ts";

// Small enough to stay far below SQLite's limit on bound values in one statement.
const ROWS_PER_INSERT = 40;

const tables = Object.values(TABLES);

/**
 * How many rows the database holds that someone made or imported, deleted ones included.
 * The bundled exercise library does not count, since every database has it.
 */
export const ownRowCount = (sql: SqlService) =>
  Effect.gen(function* () {
    let total = 0;
    for (const table of tables) {
      const where = table.name === TABLES.exercise.name ? "WHERE source <> 'library'" : "";
      const rows = yield* sql.all(`SELECT count(*) AS n FROM ${table.name} ${where}`);
      total += Number(rows[0]?.["n"] ?? 0);
    }
    return total;
  });

/**
 * Copies every row of `from` into `to`, deleted ones included, with their IDs, in one
 * transaction on `to`. Each row is checked against its table's schema on the way. Where `to`
 * already holds a row with the same ID, such as a library exercise, the newer copy stays.
 * Returns how many rows it copied.
 */
export const copyDatabase = (from: SqlService, to: SqlService) =>
  to.transaction(
    Effect.gen(function* () {
      let copied = 0;
      for (const table of tables) {
        const columns = table.keys.map(columnOf);
        const rows = yield* from.all(`SELECT ${columns.join(", ")} FROM ${table.name} ORDER BY id`);
        const decode = Schema.decodeUnknownEffect(table.schema);
        const encode = Schema.encodeEffect(table.schema);
        const values: Array<ReadonlyArray<SqlValue>> = [];
        for (const row of rows) {
          const checked = yield* decode(
            Object.fromEntries(table.keys.map((key) => [key, row[columnOf(key)] ?? null])),
          ).pipe(
            Effect.flatMap(encode),
            Effect.mapError(
              (issue) => new InvalidRowError({ table: table.name, message: issue.message }),
            ),
          );
          values.push(
            table.keys.map((key) => (checked as Record<string, SqlValue | undefined>)[key] ?? null),
          );
        }
        const placeholders = `(${columns.map(() => "?").join(", ")})`;
        const updates = columns
          .filter((column) => column !== "id")
          .map((column) => `${column} = excluded.${column}`)
          .join(", ");
        for (let start = 0; start < values.length; start += ROWS_PER_INSERT) {
          const chunk = values.slice(start, start + ROWS_PER_INSERT);
          yield* to.run(
            `INSERT INTO ${table.name} (${columns.join(", ")}) VALUES ${chunk.map(() => placeholders).join(", ")}
             ON CONFLICT (id) DO UPDATE SET ${updates} WHERE excluded.updated_at > ${table.name}.updated_at`,
            chunk.flat(),
          );
        }
        copied += values.length;
      }
      return copied;
    }),
  );
