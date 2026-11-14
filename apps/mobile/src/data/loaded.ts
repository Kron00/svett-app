import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";

import { useCurrentDatabase } from "./current";

export type Loaded<A> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly value: A }
  | { readonly state: "failed"; readonly message: string };

/**
 * Loads on focus, so a screen shows what another screen saved before it came back. It loads
 * again when someone signs in or out, so a screen never keeps showing the previous owner's rows.
 * `reload` loads again at once, after the screen itself changed something.
 */
export function useOnFocus<A>(load: () => Promise<A>): Loaded<A> & { readonly reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded<A>>({ state: "loading" });
  const { version } = useCurrentDatabase();
  const start = useCallback(() => {
    let current = true;
    load().then(
      (value) => current && setLoaded({ state: "ready", value }),
      (error: unknown) => current && setLoaded({ state: "failed", message: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [load, version]);
  useFocusEffect(start);
  const reload = useCallback(() => void start(), [start]);
  return { ...loaded, reload };
}
