import type { Effect } from "effect";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { type AppServices, appDatabase } from "./database";

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Runs a write, then has every screen that reads the database read it again. */
export const write = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> => {
  try {
    return await appDatabase().runPromise(effect);
  } finally {
    version++;
    for (const listener of listeners) listener();
  }
};

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
