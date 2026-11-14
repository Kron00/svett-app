import { Cause, type Effect, Exit } from "effect";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";

import { type AppServices, appDatabase } from "./database";

export type QueryState<A> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly value: A };

/**
 * Runs `query` against the app's database each time the screen comes into
 * view, whenever the caller passes a new query, and on `reload`, such as after
 * a save. Callers memoize the query on its inputs. A result for a query the
 * screen has moved on from is dropped.
 */
export function useQuery<A, E>(
  query: Effect.Effect<A, E, AppServices>,
): {
  readonly state: QueryState<A>;
  readonly reload: () => void;
} {
  const [state, setState] = useState<QueryState<A>>({ status: "loading" });
  const load = useCallback(() => {
    let current = true;
    void appDatabase()
      .runPromiseExit(query)
      .then((exit) => {
        if (!current) return;
        setState(
          Exit.isSuccess(exit)
            ? { status: "ready", value: exit.value }
            : { status: "failed", message: Cause.pretty(exit.cause) },
        );
      });
    return () => {
      current = false;
    };
  }, [query]);
  useFocusEffect(load);
  return { state, reload: load };
}
