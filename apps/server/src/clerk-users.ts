import type { AccountId } from "@svett/core";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";

/** Clerk did not delete the user, so its sessions may still be alive. */
export class SessionEndFailed extends Data.TaggedError("SessionEndFailed")<{
  readonly reason: string;
}> {}

export interface ClerkUsersShape {
  /** Fails when the server has no secret key, so it could not end any session. */
  readonly available: Effect.Effect<void, SessionEndFailed>;
  /**
   * Deletes the Clerk user, which ends every one of its sessions at once. A user that is
   * already gone counts as deleted.
   */
  readonly deleteUser: (account: AccountId) => Effect.Effect<void, SessionEndFailed>;
}

export interface ClerkApiSettings {
  /** Clerk's Backend API, https://api.clerk.com, or a local stand-in outside production. */
  readonly apiUrl: string;
  readonly secretKey: Redacted.Redacted | undefined;
}

const CLERK_API = "https://api.clerk.com";

/** The Backend API address to use. Production always talks to Clerk itself. */
export const clerkApiUrl = (production: boolean, configured: string | undefined) =>
  production || configured === undefined || configured.trim() === "" ? CLERK_API : configured;

export class ClerkUsers extends Context.Service<ClerkUsers, ClerkUsersShape>()(
  "svett/server/ClerkUsers",
) {
  static readonly layer = (settings: ClerkApiSettings): Layer.Layer<ClerkUsers> =>
    Layer.succeed(
      ClerkUsers,
      ClerkUsers.of({
        available:
          settings.secretKey === undefined
            ? Effect.fail(
                new SessionEndFailed({
                  reason: "CLERK_SECRET_KEY is not set, so the server cannot end sessions.",
                }),
              )
            : Effect.void,
        deleteUser: (account) =>
          settings.secretKey === undefined
            ? Effect.fail(
                new SessionEndFailed({
                  reason: "CLERK_SECRET_KEY is not set, so the server cannot end sessions.",
                }),
              )
            : Effect.tryPromise({
                try: (signal) =>
                  fetch(`${settings.apiUrl}/v1/users/${encodeURIComponent(account)}`, {
                    method: "DELETE",
                    headers: {
                      authorization: `Bearer ${Redacted.value(settings.secretKey!)}`,
                    },
                    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                  }),
                catch: () => new SessionEndFailed({ reason: "Clerk did not answer." }),
              }).pipe(
                Effect.flatMap((response) =>
                  response.ok || response.status === 404
                    ? Effect.void
                    : Effect.fail(
                        new SessionEndFailed({ reason: `Clerk answered ${response.status}.` }),
                      ),
                ),
              ),
      }),
    );

  /** From CLERK_SECRET_KEY, and CLERK_API_URL outside production. */
  static readonly fromEnv: Layer.Layer<ClerkUsers, Config.ConfigError> = Layer.unwrap(
    Effect.gen(function* () {
      const production = Option.contains(
        yield* Config.option(Config.String("NODE_ENV")),
        "production",
      );
      const secretKey = yield* Config.option(Config.Redacted("CLERK_SECRET_KEY"));
      const apiUrl = yield* Config.option(Config.String("CLERK_API_URL"));
      return ClerkUsers.layer({
        apiUrl: clerkApiUrl(production, Option.getOrUndefined(apiUrl)),
        secretKey: Option.getOrUndefined(secretKey),
      });
    }),
  );
}
