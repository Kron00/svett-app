// Checks a svett database against another row for row, for the export and import proof.
// Usage: node scripts/compare-databases.ts compare <original.db> <imported.db>
//        node scripts/compare-databases.ts counts <database.db>
import { DatabaseSync } from "node:sqlite";

export interface TableComparison {
  readonly table: string;
  /** Rows in the original, deleted ones too. */
  readonly rows: number;
  /** Original rows the other database lacks or holds with any column different. */
  readonly missing: number;
  /** Rows the other database holds that the original does not. */
  readonly extra: number;
}

export interface Comparison {
  readonly tables: ReadonlyArray<TableComparison>;
  /** Tables only one of the two databases has. */
  readonly unmatchedTables: ReadonlyArray<string>;
  /** Import batches only the other database has. They are the imports that made it. */
  readonly newImports: ReadonlyArray<string>;
  readonly equal: boolean;
}

// Each file keeps its own version and sync queue, which are not data.
const tablesOf = (database: DatabaseSync, schema: string) =>
  database
    .prepare(
      `SELECT name FROM ${schema}.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('schema_version', 'sync_outbox', 'sync_state') ORDER BY name`,
    )
    .all()
    .map((row) => String(row["name"]));

/**
 * Compares every row of every table, deleted ones too, every column. The import batches the other
 * database has and the original lacks, and their changes, come from the import that made
 * it, so they are left out of the comparison and listed instead.
 */
export function compareDatabases(originalPath: string, importedPath: string): Comparison {
  const database = new DatabaseSync(importedPath, { readOnly: true });
  try {
    database.prepare("ATTACH DATABASE ? AS original").run(originalPath);
    const originalTables = tablesOf(database, "original");
    const importedTables = tablesOf(database, "main");
    const unmatchedTables = [
      ...originalTables.filter((name) => !importedTables.includes(name)),
      ...importedTables.filter((name) => !originalTables.includes(name)),
    ];
    const newImports = originalTables.includes("import_batch")
      ? database
          .prepare(
            "SELECT id FROM main.import_batch EXCEPT SELECT id FROM original.import_batch ORDER BY id",
          )
          .all()
          .map((row) => String(row["id"]))
      : [];
    const skip = JSON.stringify(newImports);
    const leftOut: Readonly<Record<string, string>> = {
      import_batch: "id NOT IN (SELECT value FROM json_each(:skip))",
      import_change: "import_batch_id NOT IN (SELECT value FROM json_each(:skip))",
    };

    const tables = originalTables
      .filter((name) => importedTables.includes(name))
      .map((table) => {
        const columns = database
          .prepare("SELECT name FROM pragma_table_info(?, 'original') ORDER BY cid")
          .all(table)
          .map((row) => `"${String(row["name"])}"`)
          .join(", ");
        const original = `SELECT ${columns} FROM original."${table}"`;
        const imported = `SELECT ${columns} FROM main."${table}" WHERE ${leftOut[table] ?? "1 = 1"}`;
        const count = (query: string) => {
          const statement = database.prepare(`SELECT count(*) AS n FROM (${query})`);
          statement.setAllowUnknownNamedParameters(true);
          return Number(statement.get({ skip })?.["n"]);
        };
        return {
          table,
          rows: count(original),
          missing: count(`${original} EXCEPT ${imported}`),
          extra: count(`${imported} EXCEPT ${original}`),
        };
      });
    return {
      tables,
      unmatchedTables,
      newImports,
      equal:
        unmatchedTables.length === 0 &&
        tables.every(({ missing, extra }) => missing === 0 && extra === 0),
    };
  } finally {
    database.close();
  }
}

export function formatComparison(comparison: Comparison): string {
  const lines = comparison.tables.map(({ table, rows, missing, extra }) =>
    missing === 0 && extra === 0
      ? `${table}: ${rows} rows, equal`
      : `${table}: ${rows} rows, ${missing} missing or different, ${extra} extra`,
  );
  for (const table of comparison.unmatchedTables) lines.push(`${table}: in only one database`);
  lines.push(
    comparison.newImports.length === 0
      ? "No import batch made this database."
      : `Left out the import batches that made it: ${comparison.newImports.join(", ")}`,
  );
  lines.push(comparison.equal ? "Equal row for row." : "NOT equal.");
  return lines.join("\n");
}

/** Live rows per table, and every import batch with its status. */
export function databaseCounts(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const live = Object.fromEntries(
      tablesOf(database, "main").map((table) => [
        table,
        Number(
          database.prepare(`SELECT count(*) AS n FROM "${table}" WHERE deleted_at IS NULL`).get()?.[
            "n"
          ],
        ),
      ]),
    );
    const imports = database
      .prepare("SELECT id, source, status FROM import_batch ORDER BY created_at, id")
      .all()
      .map((row) => ({ id: String(row["id"]), source: row["source"], status: row["status"] }));
    return { live, imports };
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  const [command, first, second] = process.argv.slice(2);
  if (command === "compare" && first && second) {
    const comparison = compareDatabases(first, second);
    console.log(formatComparison(comparison));
    process.exitCode = comparison.equal ? 0 : 1;
  } else if (command === "counts" && first) {
    console.log(JSON.stringify(databaseCounts(first)));
  } else {
    console.error(
      "Usage: node scripts/compare-databases.ts compare <original.db> <imported.db> | counts <database.db>",
    );
    process.exitCode = 64;
  }
}
