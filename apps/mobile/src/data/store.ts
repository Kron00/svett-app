import type { Effect } from "effect";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import {
  appDatabase,
  currentDatabase,
  movePending,
  type OpenDatabase,
  stillOpen,
  subscribeDatabase,
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
  if (!stillOpen(database)) throw new Error(SWITCHED_BEFORE_WRITE);
  if (movePending(database)) throw new Error(MOVE_UNFINISHED);
  return database.handle.runtime.runPromise(effect);
};

/** Runs a write on the open database, then has every screen read again. */
export const write = <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> =>
  writeTo(currentDatabase(), effect);

export type Query<A> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: A }
  | { readonly status: "failed"; readonly message: string };

/**
 * Reads from the database when `key` changes and after every write. The last
 * value stays on screen while the next read runs, so a list never blinks empty
 * when it loads more or refreshes.
 */
export function useQuery<A, E>(
  key: string,
  read: () => Effect.Effect<A, E, AppServices>,
): Query<A> {
  const seen = useSyncExternalStore(subscribe, () => version);
  const [query, setQuery] = useState<Query<A>>({ status: "loading" });
  // The read closes over the screen's latest props, and key and the write version say when to run it.
  const latestRead = useEffectEvent(
    (_trigger: { readonly key: string; readonly version: number }) => read(),
  );
  useEffect(() => {
    let current = true;
    appDatabase()
      .runPromise(latestRead({ key, version: seen }))
      .then(
        (value) => current && setQuery({ status: "ready", value }),
        (error: unknown) => current && setQuery({ status: "failed", message: String(error) }),
      );
    return () => {
      current = false;
    };
  }, [key, seen]);
  return query;
}
