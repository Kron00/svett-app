import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { Sessions } from "./auth.ts";
import { ClerkConfig, type ClerkConfigShape } from "./clerk-config.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";

let issuer: StandInIssuer;

beforeAll(async () => {
  issuer = await startStandInIssuer();
});

afterAll(async () => {
  await issuer?.stop();
});

const verifyWith = (config: ClerkConfigShape, token: string) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(Sessions), (sessions) => sessions.verify(token)).pipe(
      Effect.match({
        onSuccess: (account) => ({ account }),
        onFailure: (error) => ({ refused: error.reason }),
      }),
      Effect.provide(Sessions.layer.pipe(Layer.provide(Layer.succeed(ClerkConfig, config)))),
    ),
  );

const configured = (
  settings: { authorizedParties?: ReadonlyArray<string>; audience?: string } = {},
): ClerkConfigShape => ({
  signIn: "configured",
  issuer: issuer.issuer,
  jwksUrl: issuer.jwksUrl,
  authorizedParties: settings.authorizedParties ?? [],
  audience: settings.audience,
});

const verify = (token: string) => verifyWith(configured(), token);

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

const UNTRUSTED_ORIGIN = "The session token comes from an origin this server does not trust.";

describe("who a session token is for", () => {
  it("accepts a token from the iPhone app, which names no origin", async () => {
    const token = await issuer.sessionToken("user_2abc");
    expect(
      await verifyWith(configured({ authorizedParties: ["https://svett.app"] }), token),
    ).toEqual({ account: "user_2abc" });
  });

  it("accepts a token from an origin the server trusts", async () => {
    const token = await issuer.sessionToken("user_2abc", { claims: { azp: "https://svett.app" } });
    expect(
      await verifyWith(configured({ authorizedParties: ["https://svett.app"] }), token),
    ).toEqual({ account: "user_2abc" });
  });

  it("refuses a token from an origin the server does not trust", async () => {
    const token = await issuer.sessionToken("user_2abc", {
      claims: { azp: "https://evil.example" },
    });
    expect(await verify(token)).toEqual({ refused: UNTRUSTED_ORIGIN });
    expect(
      await verifyWith(configured({ authorizedParties: ["https://svett.app"] }), token),
    ).toEqual({ refused: UNTRUSTED_ORIGIN });
  });

  it("refuses a token whose origin is not a string", async () => {
    const token = await issuer.sessionToken("user_2abc", {
      claims: { azp: ["https://svett.app"] },
    });
    expect(
      await verifyWith(configured({ authorizedParties: ["https://svett.app"] }), token),
    ).toEqual({ refused: UNTRUSTED_ORIGIN });
  });

  it("refuses a token meant for another audience", async () => {
    const token = await issuer.sessionToken("user_2abc", {
      claims: { aud: "https://unrelated.example" },
    });
    expect(await verify(token)).toEqual({
      refused: "The session token is meant for another audience.",
    });
    expect(await verifyWith(configured({ audience: "https://api.svett.app" }), token)).toEqual({
      refused: expect.stringContaining("aud"),
    });
  });

  it("needs the API's audience once the instance names one", async () => {
    const audience = "https://api.svett.app";
    const named = await issuer.sessionToken("user_2abc", { claims: { aud: audience } });
    const unnamed = await issuer.sessionToken("user_2abc");
    expect(await verifyWith(configured({ audience }), named)).toEqual({ account: "user_2abc" });
    expect(await verifyWith(configured({ audience }), unnamed)).toEqual({
      refused: expect.stringContaining("aud"),
    });
  });

  it("refuses every token when sign-in is off", async () => {
    const token = await issuer.sessionToken("user_2abc");
    expect(
      await verifyWith(
        { signIn: "unconfigured", reason: "CLERK_PUBLISHABLE_KEY is not set." },
        token,
      ),
    ).toEqual({ refused: "CLERK_PUBLISHABLE_KEY is not set." });
  });
});
