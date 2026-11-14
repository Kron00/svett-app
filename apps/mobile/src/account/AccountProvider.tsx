import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { type ReactNode, useEffect, useEffectEvent } from "react";
import { AppState } from "react-native";

import { followSession, ownerOf, subscribeDatabase } from "../data/current";
import { subscribeWrites } from "../data/store";
import { CLERK_PUBLISHABLE_KEY } from "./config";
import { resumeMove } from "./move";
import { resetSyncStatus, syncNow } from "./sync";

const SYNC_EVERY_MS = 60_000;
// Several quick edits, such as sets logged one after another, upload together.
const SYNC_AFTER_WRITE_MS = 3_000;

/**
 * Opens the signed-in account's database. A lapsed session keeps it open, and only Sign out
 * on the Account screen opens the anonymous one.
 */
function OwnerFromSession() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (isLoaded) followSession(userId);
  }, [isLoaded, userId]);
  return null;
}

/**
 * Syncs the signed-in account's database: at once, when svett comes to the front, a few
 * seconds after a write, when the open data changes as a whole, and every minute while open.
 */
function SyncWhileSignedIn() {
  const { isLoaded, userId, getToken } = useAuth();
  const token = useEffectEvent(() => getToken());
  useEffect(() => {
    const owner = ownerOf(isLoaded ? userId : undefined);
    if (owner.kind !== "account") return;
    const run = () => {
      void syncNow(owner.accountId, token);
    };
    let soon: ReturnType<typeof setTimeout> | undefined;
    const runSoon = () => {
      clearTimeout(soon);
      soon = setTimeout(run, SYNC_AFTER_WRITE_MS);
    };
    run();
    const every = setInterval(() => {
      if (AppState.currentState === "active") run();
    }, SYNC_EVERY_MS);
    const front = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    const stopWrites = subscribeWrites(runSoon);
    const stopData = subscribeDatabase(runSoon);
    return () => {
      clearTimeout(soon);
      clearInterval(every);
      front.remove();
      stopWrites();
      stopData();
      resetSyncStatus();
    };
  }, [isLoaded, userId]);
  return null;
}

/**
 * Clerk keeps the svett session in the Keychain, and the phone opens the database of whoever
 * is signed in. Without a publishable key the app has no accounts and stays anonymous.
 */
export function AccountProvider({ children }: { readonly children: ReactNode }) {
  useEffect(() => {
    // A move that fails again stays in the journal, and the Account screen or the next launch
    // tries once more.
    resumeMove().catch(() => undefined);
  }, []);
  if (CLERK_PUBLISHABLE_KEY === undefined) return children;
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <OwnerFromSession />
      <SyncWhileSignedIn />
      {children}
    </ClerkProvider>
  );
}
