import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { useCurrentDatabase } from "./current";

export type Loaded<A> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly value: A }
  | { readonly state: "failed"; readonly message: string };

/**
 * Loads on focus, so a screen shows what another screen saved before it came back. A screen in
 * front loads again when someone signs in or out, so it never keeps the previous owner's rows.
 * `reload` loads again at once, after the screen itself changed something.
 */
export function useOnFocus<A>(load: () => Promise<A>): Loaded<A> & { readonly reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded<A>>({ state: "loading" });
  const start = useCallback(() => {
    let current = true;
    load().then(
      (value) => current && setLoaded({ state: "ready", value }),
      (error: unknown) => current && setLoaded({ state: "failed", message: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [load]);
  useFocusEffect(start);
  const reload = useCallback(() => void start(), [start]);

  const navigation = useNavigation();
  const { version } = useCurrentDatabase();
  const loadedFor = useRef(version);
  const reloadIfShown = useEffectEvent(() => {
    if (navigation.isFocused()) reload();
  });
  useEffect(() => {
    if (loadedFor.current === version) return;
    loadedFor.current = version;
    reloadIfShown();
  }, [version]);

  return { ...loaded, reload };
}
