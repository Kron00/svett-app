import {
  ANONYMOUS,
  databaseFileName,
  databaseLayer,
  type DatabaseOwner,
  Ids,
  type OpenStep,
  type SqlDriver,
} from "@svett/core";
import { Effect, ManagedRuntime } from "effect";
import { getRandomValues } from "expo-crypto";
import { openDatabaseAsync, type SQLiteBindValue, type SQLiteDatabase } from "expo-sqlite";
import { Settings } from "react-native";

import { markLaunch } from "./launch-timing";

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

/**
 * The database for `target`, migrated and seeded, with every repository over it. `onStep`
 * hears when the file is open and when each step of preparing it is done.
 */
export const openDatabase = (
  target: DatabaseTarget,
  onStep: (step: "opened" | OpenStep) => void = () => {},
) =>
  ManagedRuntime.make(
    databaseLayer(
      expoSqliteDriver(
        open(target).then((database) => {
          onStep("opened");
          return database;
        }),
      ),
      Ids.layer((bytes) => getRandomValues(bytes)),
      onStep,
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

let shared: ReturnType<typeof openDatabase> | undefined;

/** The one database every screen reads and writes, opened on first use for this launch's target. */
export const appDatabase = () => (shared ??= openDatabase(launchTarget(), markLaunch));

/**
 * Opens, migrates and seeds the database now, so the Train tab finds it ready instead of
 * waiting for it on its first read.
 */
export const prepareAppDatabase = () => {
  appDatabase()
    .runPromise(Effect.void)
    .catch(() => undefined);
};

export type AppServices = ManagedRuntime.ManagedRuntime.Services<ReturnType<typeof openDatabase>>;
