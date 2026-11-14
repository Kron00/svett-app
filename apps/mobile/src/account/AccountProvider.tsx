import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { type ReactNode, useEffect } from "react";

import { ownerOf, switchOwner } from "../data/current";
import { CLERK_PUBLISHABLE_KEY } from "./config";

/** Opens the signed-in account's database, and the anonymous one when nobody is signed in. */
function OwnerFromSession() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    switchOwner(ownerOf(userId));
  }, [isLoaded, userId]);
  return null;
}

/**
 * Clerk keeps the svett session in the Keychain, and the phone opens the database of whoever
 * is signed in. Without a publishable key the app has no accounts and stays anonymous.
 */
export function AccountProvider({ children }: { readonly children: ReactNode }) {
  if (CLERK_PUBLISHABLE_KEY === undefined) return children;
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <OwnerFromSession />
      {children}
    </ClerkProvider>
  );
}
