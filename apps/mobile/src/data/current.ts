import { AccountId, ANONYMOUS, type DatabaseOwner } from "@svett/core";
import { Option, Schema } from "effect";
import { useSyncExternalStore } from "react";

import { type DatabaseHandle, launchFixture, openDatabaseHandle } from "./database";

export interface CurrentDatabase {
  readonly owner: DatabaseOwner;
  readonly handle: DatabaseHandle;
  /** Goes up whenever the data underneath changes as a whole, such as after a move. */
  readonly version: number;
}

// A proof run launched with a fixture stays on that file, whoever signs in.
const fixture = launchFixture();
const listeners = new Set<() => void>();
let current: CurrentDatabase | undefined;

const notify = () => {
  for (const listener of listeners) listener();
};

const decodeAccountId = Schema.decodeUnknownOption(AccountId);

/** The database owner for a Clerk user ID, or nobody when no one is signed in. */
export const ownerOf = (userId: string | null | undefined): DatabaseOwner =>
  Option.match(decodeAccountId(userId ?? undefined), {
    onNone: () => ANONYMOUS,
    onSome: (accountId) => ({ kind: "account", accountId }),
  });

const sameOwner = (a: DatabaseOwner, b: DatabaseOwner) =>
  a.kind === "anonymous"
    ? b.kind === "anonymous"
    : b.kind === "account" && a.accountId === b.accountId;

/** The database every screen reads: the signed-in account's, or the anonymous one. */
export const currentDatabase = (): CurrentDatabase => {
  current ??= {
    owner: ANONYMOUS,
    handle: openDatabaseHandle(fixture ?? { kind: "owner", owner: ANONYMOUS }),
    version: 0,
  };
  return current;
};

/**
 * Opens the database of `owner` and closes the one before, which stays on the phone. Each
 * owner has its own file, so one account never reads another's rows.
 */
export const switchOwner = (owner: DatabaseOwner) => {
  const previous = currentDatabase();
  if (sameOwner(previous.owner, owner)) return;
  current = {
    owner,
    handle: fixture === undefined ? openDatabaseHandle({ kind: "owner", owner }) : previous.handle,
    version: previous.version + 1,
  };
  notify();
  if (current.handle !== previous.handle) void previous.handle.close();
};

/** Tells every screen to read again, after something replaced the data as a whole. */
export const dataChanged = () => {
  const now = currentDatabase();
  current = { ...now, version: now.version + 1 };
  notify();
};

/** The database runtime every screen reads and writes through, the current owner's. */
export const appDatabase = () => currentDatabase().handle.runtime;

/** Goes up whenever the current database changes as a whole. */
export const databaseVersion = () => currentDatabase().version;

/** Calls `listener` whenever the current database changes as a whole. */
export const subscribeDatabase = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useCurrentDatabase = () => useSyncExternalStore(subscribeDatabase, currentDatabase);
