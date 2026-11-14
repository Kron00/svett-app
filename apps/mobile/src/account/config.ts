/**
 * The Clerk instance's publishable key, set at build time. It is public by design. A build
 * without one has no accounts, and everything on the phone still works.
 */
export const CLERK_PUBLISHABLE_KEY: string | undefined =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || undefined;
