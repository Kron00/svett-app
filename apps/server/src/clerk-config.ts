import { isIP } from "node:net";

import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";

export class ClerkConfigError extends Data.TaggedError("ClerkConfigError")<{
  readonly message: string;
}> {}

export interface ClerkConfigShape {
  /** The `iss` every session token must carry: Clerk's Frontend API address. */
  readonly issuer: string;
  /** Where Clerk publishes the keys that sign session tokens. */
  readonly jwksUrl: string;
}

export class ClerkConfig extends Context.Service<ClerkConfig, ClerkConfigShape>()(
  "svett/server/ClerkConfig",
) {
  static readonly fromEnv: Layer.Layer<ClerkConfig, ClerkConfigError | Config.ConfigError> =
    Layer.effect(
      ClerkConfig,
      Effect.gen(function* () {
        const input: ClerkEnv = {
          production: (yield* optional("NODE_ENV")).pipe(Option.contains("production")),
          publishableKey: Option.getOrUndefined(yield* optional("CLERK_PUBLISHABLE_KEY")),
          secretKey: Option.getOrUndefined(
            yield* Config.option(Config.Redacted("CLERK_SECRET_KEY")),
          ),
          issuer: Option.getOrUndefined(yield* optional("CLERK_ISSUER")),
          jwksUrl: Option.getOrUndefined(yield* optional("CLERK_JWKS_URL")),
        };
        return ClerkConfig.of(yield* clerkConfig(input));
      }),
    );
}

export interface ClerkEnv {
  readonly production: boolean;
  readonly publishableKey: string | undefined;
  readonly secretKey: Redacted.Redacted | undefined;
  readonly issuer: string | undefined;
  readonly jwksUrl: string | undefined;
}

const optional = (name: string) => Config.option(Config.String(name));

const fail = (message: string) => Effect.fail(new ClerkConfigError({ message }));

const KEY_PATTERN = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/;

/** The Frontend API host a publishable key names, or undefined when it is not a Clerk key. */
export const frontendApiOf = (publishableKey: string) => {
  const match = KEY_PATTERN.exec(publishableKey);
  if (match === null) return undefined;
  const decoded = Buffer.from(match[2] ?? "", "base64").toString("utf8");
  if (!decoded.endsWith("$")) return undefined;
  const host = decoded.slice(0, -1);
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host)
    ? { instance: match[1] as "test" | "live", host }
    : undefined;
};

const isLocal = (hostname: string) =>
  hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname) !== 0;

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/**
 * Checks the Clerk settings. In production the issuer and key set come from the publishable key,
 * over HTTPS, from a host that is not this machine, so a stand-in issuer can never be trusted
 * there. Elsewhere `CLERK_ISSUER` and `CLERK_JWKS_URL` may name a local stand-in.
 */
export const clerkConfig = (env: ClerkEnv): Effect.Effect<ClerkConfigShape, ClerkConfigError> => {
  if (!env.production) {
    if (env.issuer !== undefined && env.jwksUrl !== undefined) {
      return Effect.succeed({ issuer: env.issuer, jwksUrl: env.jwksUrl });
    }
  }
  if (env.publishableKey === undefined) {
    return fail(
      env.production
        ? "CLERK_PUBLISHABLE_KEY is not set. The server needs the Clerk instance's keys in production."
        : "Set CLERK_PUBLISHABLE_KEY, or CLERK_ISSUER and CLERK_JWKS_URL for a stand-in issuer.",
    );
  }
  const frontendApi = frontendApiOf(env.publishableKey);
  if (frontendApi === undefined) {
    return fail("CLERK_PUBLISHABLE_KEY is not a Clerk publishable key.");
  }
  const issuer = `https://${frontendApi.host}`;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  if (env.production) {
    if (env.secretKey === undefined) {
      return fail(
        "CLERK_SECRET_KEY is not set. The server needs the Clerk instance's keys in production.",
      );
    }
    if (!Redacted.value(env.secretKey).startsWith(`sk_${frontendApi.instance}_`)) {
      return fail(
        `CLERK_SECRET_KEY does not belong to the same kind of Clerk instance as CLERK_PUBLISHABLE_KEY (${frontendApi.instance}).`,
      );
    }
    if (isLocal(parseUrl(issuer)?.hostname ?? "localhost")) {
      return fail("CLERK_PUBLISHABLE_KEY names a local issuer, which production never trusts.");
    }
  }
  if (env.issuer !== undefined && env.issuer !== issuer) {
    return fail(`CLERK_ISSUER must be ${issuer}, the issuer CLERK_PUBLISHABLE_KEY names.`);
  }
  if (env.jwksUrl !== undefined && env.jwksUrl !== jwksUrl) {
    return fail(`CLERK_JWKS_URL must be ${jwksUrl}, the key set CLERK_PUBLISHABLE_KEY names.`);
  }
  return Effect.succeed({ issuer, jwksUrl });
};
