import { Cause, type Effect, Exit } from "effect";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";

import {
  currentDatabase,
  type OpenDatabase,
  sameDatabase,
  subscribeDatabase,
  useCurrentDatabase,
} from "./current";
import type { AppServices } from "./database";

export type QueryState<A> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly value: A;
      /** The database the value was read from, where every action on it writes. */
      readonly database: OpenDatabase;
    };

/**
 * Runs `query` against the app's database each time the screen comes into
 * view, whenever the caller passes a new query, when signing in or out swaps
 * the database, and on `reload`, such as after a save. Callers memoize the query on its inputs. A result for a query the
 * screen has moved on from is dropped, and a value read from another database than the open
 * one never shows.
 */
export function useQuery<A, E>(
  query: Effect.Effect<A, E, AppServices>,
): {
  readonly state: QueryState<A>;
  readonly reload: () => void;
} {
  const [state, setState] = useState<QueryState<A>>({ status: "loading" });
  const open = useCurrentDatabase();
  // Every read cancels the one before, a reload's too, so an older read never lands last.
  const running = useRef(() => {});
  const load = useCallback(() => {
    running.current();
    let current = true;
    const database = currentDatabase();
    void database.handle.runtime.runPromiseExit(query).then((exit) => {
      if (!current) return;
      setState(
        Exit.isSuccess(exit)
          ? { status: "ready", value: exit.value, database }
          : { status: "failed", message: Cause.pretty(exit.cause) },
      );
    });
    running.current = () => {
      current = false;
    };
  }, [query]);
  useFocusEffect(
    useCallback(() => {
      load();
      // Signing in or out swaps the database, so a screen in view reads the new one.
      const stop = subscribeDatabase(load);
      return () => {
        stop();
        running.current();
      };
    }, [load]),
  );
  return {
    state:
      state.status === "ready" && !sameDatabase(state.database, open)
        ? { status: "loading" }
        : state,
    reload: load,
  };
}
