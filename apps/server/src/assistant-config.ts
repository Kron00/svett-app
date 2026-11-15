import { Config, Context, Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/http";

import { frontendApiOf } from "./clerk-config.ts";

export interface AssistantConfigShape {
  /**
   * The server's public origin, such as https://svett-app.jservers.net, which names the OAuth
   * issuer and the MCP resource. Without PUBLIC_URL it comes from each request's Host and
   * X-Forwarded-Proto headers, as the proxy in front of the server sets them.
   */
  readonly publicUrl: string | undefined;
  /** The Clerk publishable key the consent page signs in with, when the server has one. */
  readonly publishableKey: string | undefined;
}

export class AssistantConfig extends Context.Service<AssistantConfig, AssistantConfigShape>()(
  "svett/server/AssistantConfig",
) {
  static readonly fromEnv: Layer.Layer<AssistantConfig, Config.ConfigError> = Layer.effect(
    AssistantConfig,
    Effect.gen(function* () {
      const publicUrl = Option.getOrUndefined(yield* Config.option(Config.String("PUBLIC_URL")));
      const key = Option.getOrUndefined(
        yield* Config.option(Config.String("CLERK_PUBLISHABLE_KEY")),
      );
      const origin = publicUrl === undefined ? undefined : originOf(publicUrl);
      if (publicUrl !== undefined && origin === undefined) {
        yield* Effect.logWarning(
          "PUBLIC_URL is not an origin such as https://svett.example, so it is ignored",
        );
      }
      return AssistantConfig.of({
        publicUrl: origin,
        publishableKey: key !== undefined && frontendApiOf(key) !== undefined ? key : undefined,
      });
    }),
  );
}

const originOf = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The server's public origin for the running request. */
export const publicBase = Effect.gen(function* () {
  const config = yield* AssistantConfig;
  if (config.publicUrl !== undefined) return config.publicUrl;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const first = (name: string) => request.headers[name]?.split(",")[0]?.trim() || undefined;
  const proto = first("x-forwarded-proto") === "https" ? "https" : "http";
  const host = first("x-forwarded-host") ?? first("host") ?? "localhost";
  return originOf(`${proto}://${host}`) ?? "http://localhost";
});
