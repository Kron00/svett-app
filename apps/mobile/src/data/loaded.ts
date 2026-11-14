import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { currentDatabase, type OpenDatabase, sameDatabase, useCurrentDatabase } from "./current";

export type Loaded<A> =
  | { readonly state: "loading" }
  | {
      readonly state: "ready";
      readonly value: A;
      /** The database the value was read from, where every action on it writes. */
      readonly database: OpenDatabase;
    }
  | { readonly state: "failed"; readonly message: string };

/**
 * Loads on focus, so a screen shows what another screen saved before it came back. A screen in
 * front loads again when someone signs in or out, and a value read from another database than
 * the open one never shows, so it never keeps the previous owner's rows. `reload` loads again
 * at once, after the screen itself changed something.
 */
export function useOnFocus<A>(
  load: (database: OpenDatabase) => Promise<A>,
): Loaded<A> & { readonly reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded<A>>({ state: "loading" });
  // Every load cancels the one before, so a slower, older read never lands last.
  const running = useRef(() => {});
  const start = useCallback(() => {
    running.current();
    const database = currentDatabase();
    let current = true;
    load(database).then(
      (value) => current && setLoaded({ state: "ready", value, database }),
      (error: unknown) => current && setLoaded({ state: "failed", message: String(error) }),
    );
    const cancel = () => {
      current = false;
    };
    running.current = cancel;
    return cancel;
  }, [load]);
  useFocusEffect(start);
  const reload = useCallback(() => void start(), [start]);

  const navigation = useNavigation();
  const open = useCurrentDatabase();
  const loadedFor = useRef(open.version);
  const reloadIfShown = useEffectEvent(() => {
    // A read of the data before is of no use now, whether or not the screen is in front.
    running.current();
    if (navigation.isFocused()) reload();
  });
  useEffect(() => {
    if (loadedFor.current === open.version) return;
    loadedFor.current = open.version;
    reloadIfShown();
  }, [open.version]);

  return loaded.state === "ready" && !sameDatabase(loaded.database, open)
    ? { state: "loading", reload }
    : { ...loaded, reload };
}
