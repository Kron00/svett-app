import { ConfigProvider, Effect, Redacted } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ClerkConfig, clerkConfig, type ClerkEnv } from "./clerk-config.ts";

/** A publishable key the way Clerk encodes one: its Frontend API host, base64, ending in `$`. */
const publishableKey = (instance: "test" | "live", host: string) =>
  `pk_${instance}_${Buffer.from(`${host}$`).toString("base64")}`;

const STAND_IN = {
  issuer: "http://127.0.0.1:4100",
  jwksUrl: "http://127.0.0.1:4100/.well-known/jwks.json",
};

const NONE: ClerkEnv = {
  production: false,
  publishableKey: undefined,
  secretKey: undefined,
  issuer: undefined,
  jwksUrl: undefined,
  authorizedParties: undefined,
  audience: undefined,
};

const ANY_PARTY = { authorizedParties: [], audience: undefined };

const check = (env: Partial<ClerkEnv>) =>
  Effect.runPromise(
    clerkConfig({ ...NONE, ...env }).pipe(
      Effect.match({
        onSuccess: (config) => ({ ok: config }),
        onFailure: (error) => ({ refused: error.message }),
      }),
    ),
  );

const production = {
  production: true,
  publishableKey: publishableKey("live", "clerk.svett.example"),
  secretKey: Redacted.make("sk_live_secret"),
};

describe("Clerk config in production", () => {
  it("uses the issuer and key set the publishable key names", async () => {
    expect(await check(production)).toEqual({
      ok: {
        issuer: "https://clerk.svett.example",
        jwksUrl: "https://clerk.svett.example/.well-known/jwks.json",
        ...ANY_PARTY,
      },
    });
  });

  it("has no settings without the Clerk keys", async () => {
    expect(await check({ production: true })).toEqual({
      refused: expect.stringContaining("CLERK_PUBLISHABLE_KEY is not set"),
    });
    expect(await check({ ...production, secretKey: undefined })).toEqual({
      refused: expect.stringContaining("CLERK_SECRET_KEY is not set"),
    });
  });

  it("never accepts the stand-in issuer", async () => {
    expect(await check({ production: true, ...STAND_IN })).toEqual({
      refused: expect.stringContaining("CLERK_PUBLISHABLE_KEY is not set"),
    });
    expect(await check({ ...production, ...STAND_IN })).toEqual({
      refused: expect.stringContaining("CLERK_ISSUER must be https://clerk.svett.example"),
    });
    expect(await check({ ...production, jwksUrl: STAND_IN.jwksUrl })).toEqual({
      refused: expect.stringContaining("CLERK_JWKS_URL must be"),
    });
  });

  it("refuses a publishable key that names this machine", async () => {
    const hosts = ["127.0.0.1:4100", "localhost:4100", "clerk.localhost"];
    const answers = await Promise.all(
      hosts.map((host) => check({ ...production, publishableKey: publishableKey("live", host) })),
    );
    expect(answers).toEqual(
      hosts.map(() => ({ refused: expect.stringContaining("local issuer") })),
    );
  });

  it("refuses keys that are not Clerk's or that come from different instances", async () => {
    expect(await check({ ...production, publishableKey: "pk_live_not-base64-of-a-host" })).toEqual({
      refused: "CLERK_PUBLISHABLE_KEY is not a Clerk publishable key.",
    });
    expect(await check({ ...production, secretKey: Redacted.make("sk_test_secret") })).toEqual({
      refused: expect.stringContaining("same kind of Clerk instance"),
    });
  });
});

describe("Clerk config outside production", () => {
  it("accepts a stand-in issuer", async () => {
    expect(await check(STAND_IN)).toEqual({ ok: { ...STAND_IN, ...ANY_PARTY } });
  });

  it("still needs an issuer from somewhere", async () => {
    expect(await check({})).toEqual({ refused: expect.stringContaining("CLERK_ISSUER") });
  });
});

const fromEnv = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.service(ClerkConfig).pipe(
      Effect.provide(ClerkConfig.fromEnv),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  );

describe("Clerk config from the environment", () => {
  it("reads the keys, the trusted origins and the audience", async () => {
    expect(
      await fromEnv({
        NODE_ENV: "production",
        CLERK_PUBLISHABLE_KEY: publishableKey("test", "svett-1.clerk.accounts.dev"),
        CLERK_SECRET_KEY: "sk_test_secret",
        CLERK_AUTHORIZED_PARTIES: "https://svett.app, https://www.svett.app",
        CLERK_AUDIENCE: "https://api.svett.app",
      }),
    ).toEqual({
      signIn: "configured",
      issuer: "https://svett-1.clerk.accounts.dev",
      jwksUrl: "https://svett-1.clerk.accounts.dev/.well-known/jwks.json",
      authorizedParties: ["https://svett.app", "https://www.svett.app"],
      audience: "https://api.svett.app",
    });
  });

  it("turns sign-in off in production without the Clerk keys", async () => {
    expect(await fromEnv({ NODE_ENV: "production" })).toEqual({
      signIn: "unconfigured",
      reason: expect.stringContaining("CLERK_PUBLISHABLE_KEY is not set"),
    });
  });

  it("turns sign-in off in production rather than trust the stand-in issuer", async () => {
    expect(
      await fromEnv({
        NODE_ENV: "production",
        CLERK_ISSUER: STAND_IN.issuer,
        CLERK_JWKS_URL: STAND_IN.jwksUrl,
      }),
    ).toEqual({ signIn: "unconfigured", reason: expect.any(String) });
  });
});

describe("trusted origins", () => {
  it("must each be an origin", async () => {
    for (const party of ["svett.app", "https://svett.app/path", "https://svett.app/"]) {
      expect(await check({ ...STAND_IN, authorizedParties: party })).toEqual({
        refused: expect.stringContaining(`CLERK_AUTHORIZED_PARTIES lists ${party}`),
      });
    }
  });

  it("must use HTTPS from another machine in production", async () => {
    for (const party of ["http://svett.app", "https://localhost:8081", "https://127.0.0.1"]) {
      expect(await check({ ...production, authorizedParties: party })).toEqual({
        refused: expect.stringContaining("served over HTTPS from another machine"),
      });
    }
  });

  it("may name a local origin outside production", async () => {
    expect(await check({ ...STAND_IN, authorizedParties: "http://localhost:8081" })).toEqual({
      ok: { ...STAND_IN, authorizedParties: ["http://localhost:8081"], audience: undefined },
    });
  });
});
