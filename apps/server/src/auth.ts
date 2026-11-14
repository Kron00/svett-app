import { AccountId } from "@svett/core";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

import { ClerkConfig } from "./clerk-config.ts";

export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly reason: string;
}> {}

export class SignInUnavailable extends Data.TaggedError("SignInUnavailable")<{
  readonly reason: string;
}> {}

export interface SessionsShape {
  /** Fails when the server has no Clerk setup, so no session can be checked at all. */
  readonly available: Effect.Effect<void, SignInUnavailable>;
  /** The account a Clerk session token belongs to, once its signature and claims check out. */
  readonly verify: (token: string) => Effect.Effect<AccountId, Unauthorized | SignInUnavailable>;
}

const decodeAccountId = Schema.decodeUnknownEffect(AccountId);

// Clerk session tokens live for a minute, so a few seconds covers clock drift without
// keeping a stolen one useful for long.
const CLOCK_TOLERANCE_SECONDS = 5;

export class Sessions extends Context.Service<Sessions, SessionsShape>()("svett/server/Sessions") {
  static readonly layer: Layer.Layer<Sessions, never, ClerkConfig> = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const config = yield* ClerkConfig;
      if (config.signIn === "unconfigured") {
        const unavailable = Effect.fail(new SignInUnavailable({ reason: config.reason }));
        return Sessions.of({ available: unavailable, verify: () => unavailable });
      }
      const { issuer, jwksUrl, authorizedParties, audience } = config;
      const keys = createRemoteJWKSet(new URL(jwksUrl));
      return Sessions.of({
        available: Effect.void,
        verify: (token) =>
          Effect.tryPromise({
            try: () =>
              jwtVerify(token, keys, {
                issuer,
                algorithms: ["RS256"],
                clockTolerance: CLOCK_TOLERANCE_SECONDS,
                requiredClaims: ["sub", "exp", "iat"],
                ...(audience === undefined ? {} : { audience }),
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
              const refused = refusedParty(payload, authorizedParties, audience);
              if (refused !== undefined) return Effect.fail(new Unauthorized({ reason: refused }));
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

/**
 * Why a verified token is still not for this server, if it is not. Clerk puts the browser's
 * Origin in `azp`, and leaves it out for native apps, which send none, so a token without one
 * is the iPhone app's. One with an `azp` must name an origin the server trusts. Clerk's session
 * tokens name no `aud` unless the instance adds one, so a token that names an audience must
 * name this API's.
 */
const refusedParty = (
  payload: JWTPayload,
  authorizedParties: ReadonlyArray<string>,
  audience: string | undefined,
) => {
  const azp = payload["azp"];
  if (azp !== undefined && (typeof azp !== "string" || !authorizedParties.includes(azp))) {
    return "The session token comes from an origin this server does not trust.";
  }
  if (audience === undefined && payload.aud !== undefined) {
    return "The session token is meant for another audience.";
  }
  return undefined;
};

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

/** The signed-in account of the current request, from its `Authorization: Bearer` header. */
export const signedInAccount = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const match = BEARER.exec(request.headers["authorization"] ?? "");
  const sessions = yield* Sessions;
  yield* sessions.available;
  if (match?.[1] === undefined) {
    return yield* new Unauthorized({ reason: "The request has no session token." });
  }
  return yield* sessions.verify(match[1]);
});
