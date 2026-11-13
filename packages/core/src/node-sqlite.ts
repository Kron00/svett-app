import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { SqlDriver, SqlRow } from "./sql.ts";

/** A `SqlDriver` over node:sqlite, for tests and scripts. Never imported by the app. */
export const nodeSqliteDriver = (database: DatabaseSync): SqlDriver => ({
  all: async (sql, params) =>
    database.prepare(sql).all(...(params as Array<SQLInputValue>)) as ReadonlyArray<SqlRow>,
  run: async (sql, params) => {
    database.prepare(sql).run(...(params as Array<SQLInputValue>));
  },
  exec: async (sql) => database.exec(sql),
});

export const openNodeDatabase = (path = ":memory:") => {
  const database = new DatabaseSync(path);
  return { database, driver: nodeSqliteDriver(database) };
};
