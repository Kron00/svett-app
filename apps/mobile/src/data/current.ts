import { AccountId, ANONYMOUS, anonymousDataLocked, type DatabaseOwner } from "@svett/core";
import { Option, Schema } from "effect";
import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";

import { CLERK_PUBLISHABLE_KEY } from "../account/config";
import { storedMoveJournal } from "../account/journal";

import {
  type DatabaseHandle,
  type DatabaseTarget,
  launchFixture,
  openDatabaseHandle,
} from "./database";
import { transfersSettled } from "./turns";

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
const closing = new Set<Promise<void>>();

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

export const sameOwner = (a: DatabaseOwner, b: DatabaseOwner) =>
  a.kind === "anonymous"
    ? b.kind === "anonymous"
    : b.kind === "account" && a.accountId === b.accountId;

const sameTarget = (a: DatabaseTarget, b: DatabaseTarget) => {
  if (a.kind === "owner") return b.kind === "owner" && sameOwner(a.owner, b.owner);
  if (a.kind === "file") return b.kind === "file" && a.path === b.path;
  return b.kind === a.kind;
};

/**
 * The file to open for `owner`. While a move into an account is unfinished, the anonymous
 * rows already belong to that account, so someone signed out sees an empty database instead.
 */
const targetOf = (owner: DatabaseOwner): DatabaseTarget =>
  fixture ??
  (owner.kind === "anonymous" && anonymousDataLocked(storedMoveJournal())
    ? { kind: "empty" }
    : { kind: "owner", owner });

const closeLater = (handle: DatabaseHandle) => {
  // Signing in or out while an import is being applied closes its file only once it is done.
  const closed = transfersSettled()
    .then(() => handle.close())
    .then(
      () => undefined,
      () => undefined,
    );
  closing.add(closed);
  void closed.then(() => closing.delete(closed));
};

/** Waits until every database this module let go of is closed. */
export const databasesClosed = async () => {
  await Promise.all(closing);
};

// Whose database was open last. The app opens it at launch, before Clerk has read the session,
// so a signed-in launch never shows the phone's own data first, and an offline one still opens.
const OWNER_KEY = "svett.databaseOwner";

const lastOwner = (): DatabaseOwner =>
  CLERK_PUBLISHABLE_KEY === undefined ? ANONYMOUS : ownerOf(Storage.getItemSync(OWNER_KEY));

/** The database every screen reads: the signed-in account's, or the anonymous one. */
export const currentDatabase = (): CurrentDatabase => {
  if (current === undefined) {
    const owner = lastOwner();
    current = { owner, handle: openDatabaseHandle(targetOf(owner)), version: 0 };
  }
  return current;
};

/**
 * Opens the database of `owner` and closes the one before, which stays on the phone. Each
 * owner has its own file, so one account never reads another's rows.
 */
export const switchOwner = (owner: DatabaseOwner) => {
  const previous = currentDatabase();
  const target = targetOf(owner);
  const sameFile = sameTarget(previous.handle.target, target);
  if (sameOwner(previous.owner, owner) && sameFile) return;
  if (owner.kind === "account") Storage.setItemSync(OWNER_KEY, owner.accountId);
  else Storage.removeItemSync(OWNER_KEY);
  current = {
    owner,
    handle: sameFile ? previous.handle : openDatabaseHandle(target),
    version: previous.version + 1,
  };
  notify();
  if (current.handle !== previous.handle) closeLater(previous.handle);
};

/** Opens the right file again for whoever is signed in, after a move changed which one it is. */
export const reopenDatabase = () => switchOwner(currentDatabase().owner);

/** Tells every screen to read again, after something replaced the data as a whole. */
export const dataChanged = () => {
  const now = currentDatabase();
  current = { ...now, version: now.version + 1 };
  notify();
};

/** The database runtime every screen reads and writes through, the current owner's. */
export const appDatabase = () => currentDatabase().handle.runtime;

/** Calls `listener` whenever the current database changes as a whole. */
export const subscribeDatabase = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useCurrentDatabase = () => useSyncExternalStore(subscribeDatabase, currentDatabase);
