import {
  ANONYMOUS,
  databaseFileName,
  databaseLayer,
  type DatabaseOwner,
  Ids,
  type SqlDriver,
} from "@svett/core";
import { ManagedRuntime } from "effect";
import { getRandomValues } from "expo-crypto";
import { openDatabaseAsync, type SQLiteBindValue, type SQLiteDatabase } from "expo-sqlite";
import { Settings } from "react-native";

const expoSqliteDriver = (database: Promise<SQLiteDatabase>): SqlDriver => ({
  all: async (sql, params) => (await database).getAllAsync(sql, params as Array<SQLiteBindValue>),
  run: async (sql, params) => {
    await (await database).runAsync(sql, params as Array<SQLiteBindValue>);
  },
  exec: async (sql) => (await database).execAsync(sql),
});

export type DatabaseTarget =
  | { readonly kind: "owner"; readonly owner: DatabaseOwner }
  | { readonly kind: "file"; readonly path: string };

const open = (target: DatabaseTarget) => {
  if (target.kind === "owner") return openDatabaseAsync(databaseFileName(target.owner));
  const slash = target.path.lastIndexOf("/");
  return openDatabaseAsync(
    target.path.slice(slash + 1),
    undefined,
    target.path.slice(0, Math.max(slash, 0)),
  );
};

/** The database for `target`, migrated and seeded, with every repository over it. */
export const openDatabase = (target: DatabaseTarget) =>
  ManagedRuntime.make(
    databaseLayer(
      expoSqliteDriver(open(target)),
      Ids.layer((bytes) => getRandomValues(bytes)),
    ),
  );

/**
 * Launching with `-svettFixture /absolute/path.db` opens that file instead of the anonymous
 * database. iOS puts `-key value` launch arguments into NSUserDefaults, which React Native's
 * Settings module reads, so this needs no native code.
 */
export const launchTarget = (): DatabaseTarget => {
  const fixture: unknown = Settings.get("svettFixture");
  return typeof fixture === "string" && fixture.startsWith("/")
    ? { kind: "file", path: fixture }
    : { kind: "owner", owner: ANONYMOUS };
};

let launched: ReturnType<typeof openDatabase> | undefined;

/** The database this launch opened. Every screen shares it. */
export const appDatabase = () => (launched ??= openDatabase(launchTarget()));
