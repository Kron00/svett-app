import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { type ReactNode, useEffect } from "react";

import { followSession } from "../data/current";
import { CLERK_PUBLISHABLE_KEY } from "./config";
import { resumeMove } from "./move";

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
      {children}
    </ClerkProvider>
  );
}
