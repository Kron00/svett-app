import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";

let issuer: StandInIssuer;

beforeAll(async () => {
  issuer = await startStandInIssuer();
});

afterAll(async () => {
  await issuer?.stop();
});

const verify = (token: string) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(Sessions), (sessions) => sessions.verify(token)).pipe(
      Effect.match({
        onSuccess: (account) => ({ account }),
        onFailure: (error) => ({ refused: error.reason }),
      }),
      Effect.provide(
        Sessions.layer.pipe(
          Layer.provide(
            Layer.succeed(
              ClerkConfig,
              ClerkConfig.of({ issuer: issuer.issuer, jwksUrl: issuer.jwksUrl }),
            ),
          ),
        ),
      ),
    ),
  );

const now = () => Math.floor(Date.now() / 1000);

describe("Clerk session tokens", () => {
  it("names the account of a token Clerk signed", async () => {
    expect(await verify(await issuer.sessionToken("user_2abc"))).toEqual({ account: "user_2abc" });
  });

  it("refuses a token signed with a key Clerk does not publish", async () => {
    expect(await verify(await issuer.sessionToken("user_2abc", { key: "unpublished" }))).toEqual({
      refused: expect.any(String),
    });
  });

  it("refuses a token from another issuer", async () => {
    const token = await issuer.sessionToken("user_2abc", {
      claims: { iss: "https://someone-else.clerk.accounts.dev" },
    });
    expect(await verify(token)).toEqual({ refused: expect.stringContaining("iss") });
  });

  it("refuses an expired token", async () => {
    const token = await issuer.sessionToken("user_2abc", {
      claims: { iat: now() - 600, nbf: now() - 600, exp: now() - 60 },
    });
    expect(await verify(token)).toEqual({ refused: expect.stringContaining("exp") });
  });

  it("refuses a pending session", async () => {
    const token = await issuer.sessionToken("user_2abc", { claims: { sts: "pending" } });
    expect(await verify(token)).toEqual({ refused: "The session is still pending." });
  });

  it("refuses a token whose subject is not an account ID", async () => {
    expect(await verify(await issuer.sessionToken("user/../../2abc"))).toEqual({
      refused: "The session names no valid account.",
    });
  });

  it("refuses something that is not a token", async () => {
    expect(await verify("not-a-token")).toEqual({ refused: expect.any(String) });
  });
});
