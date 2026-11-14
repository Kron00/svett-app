import { AccountId } from "@svett/core";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { ClerkConfig } from "./clerk-config.ts";

export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly reason: string;
}> {}

export interface SessionsShape {
  /** The account a Clerk session token belongs to, once its signature and claims check out. */
  readonly verify: (token: string) => Effect.Effect<AccountId, Unauthorized>;
}

const decodeAccountId = Schema.decodeUnknownEffect(AccountId);

// Clerk session tokens live for a minute, so a few seconds covers clock drift without
// keeping a stolen one useful for long.
const CLOCK_TOLERANCE_SECONDS = 5;

export class Sessions extends Context.Service<Sessions, SessionsShape>()("svett/server/Sessions") {
  static readonly layer: Layer.Layer<Sessions, never, ClerkConfig> = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const { issuer, jwksUrl } = yield* ClerkConfig;
      const keys = createRemoteJWKSet(new URL(jwksUrl));
      return Sessions.of({
        verify: (token) =>
          Effect.tryPromise({
            try: () =>
              jwtVerify(token, keys, {
                issuer,
                algorithms: ["RS256"],
                clockTolerance: CLOCK_TOLERANCE_SECONDS,
                requiredClaims: ["sub", "exp", "iat"],
              }),
            catch: (cause) =>
              new Unauthorized({
                reason: cause instanceof Error ? cause.message : "The session token is not valid.",
              }),
          }).pipe(
            Effect.flatMap(({ payload }) => {
              // A pending session still has a task to finish, such as choosing an organization.
              if (payload["sts"] === "pending") {
                return Effect.fail(new Unauthorized({ reason: "The session is still pending." }));
              }
              return decodeAccountId(payload.sub).pipe(
                Effect.mapError(
                  () => new Unauthorized({ reason: "The session names no valid account." }),
                ),
              );
            }),
          ),
      });
    }),
  );
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

/** The signed-in account of the current request, from its `Authorization: Bearer` header. */
export const signedInAccount = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const match = BEARER.exec(request.headers["authorization"] ?? "");
  if (match?.[1] === undefined) {
    return yield* new Unauthorized({ reason: "The request has no session token." });
  }
  const sessions = yield* Sessions;
  return yield* sessions.verify(match[1]);
});
