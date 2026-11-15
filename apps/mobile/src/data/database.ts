import {
  ANONYMOUS,
  databaseFileName,
  databaseLayer,
  type DatabaseOwner,
  Ids,
  type OpenStep,
  type SqlDriver,
} from "@svett/core";
import { ManagedRuntime } from "effect";
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
  | { readonly kind: "file"; readonly path: string }
  /** An empty database in memory, for when no file on the phone may be shown. */
  | { readonly kind: "empty" };

const open = (target: DatabaseTarget) => {
  if (target.kind === "owner") return openDatabaseAsync(databaseFileName(target.owner));
  if (target.kind === "empty") return openDatabaseAsync(":memory:");
  const slash = target.path.lastIndexOf("/");
  return openDatabaseAsync(
    target.path.slice(slash + 1),
    undefined,
    target.path.slice(0, Math.max(slash, 0)),
  );
};

/** Hears when the file is open and when each step of preparing it is done. */
export type OnOpenStep = (step: "opened" | OpenStep) => void;

const makeRuntime = (database: Promise<SQLiteDatabase>, onStep: OnOpenStep) =>
  ManagedRuntime.make(
    databaseLayer(
      expoSqliteDriver(
        database.then((opened) => {
          onStep("opened");
          return opened;
        }),
      ),
      Ids.layer((bytes) => getRandomValues(bytes)),
      onStep,
    ),
  );

export type DatabaseRuntime = ReturnType<typeof makeRuntime>;

/** The database for `target`, migrated and seeded, with every repository over it. */
export const openDatabase = (
  target: DatabaseTarget,
  onStep: OnOpenStep = () => {},
): DatabaseRuntime => makeRuntime(open(target), onStep);

export interface DatabaseHandle {
  readonly target: DatabaseTarget;
  readonly runtime: DatabaseRuntime;
  /** Stops the runtime and closes the SQLite file. The file stays on the phone. */
  readonly close: () => Promise<void>;
}

/**
 * Like openDatabase, with a way to close the file again, as switching accounts needs. The
 * first open in this process times the cold start, and later ones mark nothing.
 */
export const openDatabaseHandle = (
  target: DatabaseTarget,
  onStep: OnOpenStep = markLaunch,
): DatabaseHandle => {
  const database = open(target);
  const runtime = makeRuntime(database, onStep);
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
