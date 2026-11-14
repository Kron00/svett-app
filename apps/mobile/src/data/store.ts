import type { Effect } from "effect";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import {
  currentDatabase,
  movePending,
  type OpenDatabase,
  sameDatabase,
  stillOpen,
  subscribeDatabase,
  useCurrentDatabase,
} from "./current";
import type { AppServices } from "./database";

let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  for (const listener of listeners) listener();
};
// Signing in or out, or moving data into an account, replaces the data as a whole.
subscribeDatabase(changed);
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const writeListeners = new Set<() => void>();

/** Calls `listener` after each write, as sync does to upload it soon. */
export const subscribeWrites = (listener: () => void) => {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
};

export const SWITCHED_BEFORE_WRITE =
  "Someone signed in or out before it was saved, so svett saved nothing to either account.";

export const MOVE_UNFINISHED =
  "This phone's data is still moving into an account, so svett cannot save anything until it finishes. Sign in to that account to go on.";

/**
 * Runs a write on `database`, the one the change was made for, then has every screen that
 * reads the database read it again. It refuses once another database is open, and while a move
 * leaves only an empty one in memory, which would lose the write when the app closes.
 */
export const writeTo = async <A, E>(
  database: OpenDatabase,
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> => {
  try {
    return await quietWriteTo(database, effect);
  } finally {
    changed();
    for (const listener of writeListeners) listener();
  }
};

/**
 * Like `writeTo`, without having every screen read again, for a change only the screen that
 * made it shows, such as a set typed into the workout in progress.
 */
export const quietWriteTo = async <A, E>(
  database: OpenDatabase,
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> => {
  const refusal = writeRefusal(database);
  if (refusal !== null) throw new Error(refusal);
  return database.handle.runtime.runPromise(effect);
};

/** Why a write to `database` would be refused now, or null when it may go ahead. */
export const writeRefusal = (database: OpenDatabase): string | null => {
  if (!stillOpen(database)) return SWITCHED_BEFORE_WRITE;
  if (movePending(database)) return MOVE_UNFINISHED;
  return null;
};

/**
 * Runs a write that `writeRefusal` let through earlier and that waited its turn since. It
 * writes into `database` even when someone signed in or out meanwhile, because the change was
 * made to that database's data. The caller keeps the database open until it is done.
 */
export const writeAccepted = async <A, E>(
  database: OpenDatabase,
  effect: Effect.Effect<A, E, AppServices>,
  everywhere: boolean,
): Promise<A> => {
  try {
    return await database.handle.runtime.runPromise(effect);
  } finally {
    if (everywhere) changed();
  }
};

/** Runs a read on `database`. */
export const readFrom = <A, E>(
  database: OpenDatabase,
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> => database.handle.runtime.runPromise(effect);

export type Query<A> =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly value: A;
      /** The database the value was read from, where every action on it writes. */
      readonly database: OpenDatabase;
    }
  | { readonly status: "failed"; readonly message: string };

/**
 * Reads from the database when `key` changes and after every write. The last
 * value stays on screen while the next read runs, so a list never blinks empty
 * when it loads more or refreshes. A value read from another database than the open one
 * never shows, so after a sign-in or sign-out the screen loads instead.
 */
export function useQuery<A, E>(
  key: string,
  read: () => Effect.Effect<A, E, AppServices>,
): Query<A> {
  const seen = useSyncExternalStore(subscribe, () => version);
  const open = useCurrentDatabase();
  const [query, setQuery] = useState<Query<A>>({ status: "loading" });
  // The read closes over the screen's latest props, and key and the write version say when to run it.
  const latestRead = useEffectEvent(
    (_trigger: { readonly key: string; readonly version: number }) => read(),
  );
  useEffect(() => {
    let current = true;
    const database = currentDatabase();
    readFrom(database, latestRead({ key, version: seen })).then(
      (value) => current && setQuery({ status: "ready", value, database }),
      (error: unknown) => current && setQuery({ status: "failed", message: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [key, seen]);
  return query.status === "ready" && !sameDatabase(query.database, open)
    ? { status: "loading" }
    : query;
}
