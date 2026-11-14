import { isIP } from "node:net";

import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";

export class ClerkConfigError extends Data.TaggedError("ClerkConfigError")<{
  readonly message: string;
}> {}

export interface ClerkSettings {
  /** The `iss` every session token must carry: Clerk's Frontend API address. */
  readonly issuer: string;
  /** Where Clerk publishes the keys that sign session tokens. */
  readonly jwksUrl: string;
  /** The origins a browser's session token may name in `azp`. */
  readonly authorizedParties: ReadonlyArray<string>;
  /** The `aud` every session token must carry, when the instance's tokens name this API. */
  readonly audience: string | undefined;
}

/**
 * Whether the server can check sessions. Without a valid Clerk setup it still runs, with
 * sign-in off, so a deploy that lacks the keys keeps the health check and backups going.
 */
export type ClerkConfigShape =
  | ({ readonly signIn: "configured" } & ClerkSettings)
  | { readonly signIn: "unconfigured"; readonly reason: string };

export class ClerkConfig extends Context.Service<ClerkConfig, ClerkConfigShape>()(
  "svett/server/ClerkConfig",
) {
  static readonly fromEnv: Layer.Layer<ClerkConfig, Config.ConfigError> = Layer.effect(
    ClerkConfig,
    Effect.gen(function* () {
      const input: ClerkEnv = {
        production: (yield* optional("NODE_ENV")).pipe(Option.contains("production")),
        publishableKey: Option.getOrUndefined(yield* optional("CLERK_PUBLISHABLE_KEY")),
        secretKey: Option.getOrUndefined(yield* Config.option(Config.Redacted("CLERK_SECRET_KEY"))),
        issuer: Option.getOrUndefined(yield* optional("CLERK_ISSUER")),
        jwksUrl: Option.getOrUndefined(yield* optional("CLERK_JWKS_URL")),
        authorizedParties: Option.getOrUndefined(yield* optional("CLERK_AUTHORIZED_PARTIES")),
        audience: Option.getOrUndefined(yield* optional("CLERK_AUDIENCE")),
      };
      return ClerkConfig.of(
        yield* clerkConfig(input).pipe(
          Effect.map((settings) => ({ signIn: "configured" as const, ...settings })),
          Effect.catchTag("ClerkConfigError", ({ message }) =>
            Effect.as(Effect.logWarning(`Sign-in is off. ${message}`), {
              signIn: "unconfigured" as const,
              reason: message,
            }),
          ),
        ),
      );
    }),
  );
}

export interface ClerkEnv {
  readonly production: boolean;
  readonly publishableKey: string | undefined;
  readonly secretKey: Redacted.Redacted | undefined;
  readonly issuer: string | undefined;
  readonly jwksUrl: string | undefined;
  /** Comma-separated origins, such as `https://svett.app`. */
  readonly authorizedParties: string | undefined;
  readonly audience: string | undefined;
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

const authorizedPartiesOf = (env: ClerkEnv) => {
  const parties = (env.authorizedParties ?? "")
    .split(",")
    .map((party) => party.trim())
    .filter((party) => party !== "");
  const wrong = parties.find((party) => {
    const url = parseUrl(party);
    return (
      url === undefined ||
      url.origin !== party ||
      (env.production && (url.protocol !== "https:" || isLocal(url.hostname)))
    );
  });
  return { parties, wrong };
};

/**
 * Checks the Clerk settings. In production the issuer and key set come from the publishable key,
 * over HTTPS, from a host that is not this machine, so a stand-in issuer can never be trusted
 * there. Elsewhere `CLERK_ISSUER` and `CLERK_JWKS_URL` may name a local stand-in.
 */
export const clerkConfig = (env: ClerkEnv): Effect.Effect<ClerkSettings, ClerkConfigError> => {
  const authorized = authorizedPartiesOf(env);
  if (authorized.wrong !== undefined) {
    return fail(
      `CLERK_AUTHORIZED_PARTIES lists ${authorized.wrong}, which is not an origin${env.production ? " served over HTTPS from another machine" : ""}.`,
    );
  }
  const audience = env.audience?.trim() || undefined;
  const settings = (issuer: string, jwksUrl: string) =>
    Effect.succeed({ issuer, jwksUrl, authorizedParties: authorized.parties, audience });
  if (!env.production) {
    if (env.issuer !== undefined && env.jwksUrl !== undefined) {
      return settings(env.issuer, env.jwksUrl);
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
  return settings(issuer, jwksUrl);
};
