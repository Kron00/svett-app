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

const makeRuntime = (database: Promise<SQLiteDatabase>) =>
  ManagedRuntime.make(
    databaseLayer(
      expoSqliteDriver(database),
      Ids.layer((bytes) => getRandomValues(bytes)),
    ),
  );

export type DatabaseRuntime = ReturnType<typeof makeRuntime>;

/** The database for `target`, migrated and seeded, with every repository over it. */
export const openDatabase = (target: DatabaseTarget): DatabaseRuntime => makeRuntime(open(target));

export interface DatabaseHandle {
  readonly target: DatabaseTarget;
  readonly runtime: DatabaseRuntime;
  /** Stops the runtime and closes the SQLite file. The file stays on the phone. */
  readonly close: () => Promise<void>;
}

/** Like openDatabase, with a way to close the file again, as switching accounts needs. */
export const openDatabaseHandle = (target: DatabaseTarget): DatabaseHandle => {
  const database = open(target);
  const runtime = makeRuntime(database);
  return {
    target,
    runtime,
    close: async () => {
      await runtime.dispose();
      await (await database).closeAsync();
    },
  };
};

/**
 * The file launched with `-svettFixture /absolute/path.db`, if any. iOS puts `-key value`
 * launch arguments into NSUserDefaults, which React Native's Settings module reads, so this
 * needs no native code.
 */
export const launchFixture = (): DatabaseTarget | undefined => {
  const fixture: unknown = Settings.get("svettFixture");
  return typeof fixture === "string" && fixture.startsWith("/")
    ? { kind: "file", path: fixture }
    : undefined;
};

/** The fixture when the app was launched with one, or the anonymous database. */
export const launchTarget = (): DatabaseTarget =>
  launchFixture() ?? { kind: "owner", owner: ANONYMOUS };

export type AppServices = ManagedRuntime.ManagedRuntime.Services<DatabaseRuntime>;
