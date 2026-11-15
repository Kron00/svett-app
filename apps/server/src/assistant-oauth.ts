import {
  ASSISTANT_SCOPES,
  AssistantScope,
  clientLabel,
  pkceMatches,
  requestedScopes,
  scopeText,
} from "@svett/core";
import { Clock, Data, Effect, Layer, Option, Schedule, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AssistantConfig, publicBase } from "./assistant-config.ts";
import {
  AssistantRows,
  type OAuthClient,
  type Tokens,
  UNCONNECTED_CLIENT_MS,
} from "./assistant-rows.ts";
import { Sessions } from "./auth.ts";
import { consentPage, PAGE_HEADERS, problemPage } from "./consent-page.ts";
import { MCP_PATH, RESOURCE_METADATA_PATH } from "./mcp.ts";
import { AccountDeleted, Safety } from "./safety.ts";

export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
} as const;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });

/** OAuth's error answer (RFC 6749 section 5.2). */
const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

/** RFC 9728: which authorization server protects the MCP endpoint, and its scopes. */
const resourceMetadata = Effect.gen(function* () {
  const base = yield* publicBase;
  return json({
    resource: `${base}${MCP_PATH}`,
    resource_name: "svett",
    authorization_servers: [base],
    scopes_supported: ASSISTANT_SCOPES,
    bearer_methods_supported: ["header"],
  });
});

/** RFC 8414: where to register, sign in and get tokens, and what svett supports. */
const serverMetadata = Effect.gen(function* () {
  const base = yield* publicBase;
  return json({
    issuer: base,
    authorization_endpoint: `${base}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${base}${OAUTH_PATHS.token}`,
    registration_endpoint: `${base}${OAUTH_PATHS.register}`,
    scopes_supported: ASSISTANT_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  });
});

/** The most redirect addresses one client may register, and the longest each may be. */
const MAX_REDIRECTS = 10;
const MAX_REDIRECT_LENGTH = 2_000;

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** Why a redirect address cannot be registered, or undefined when it can. */
export const redirectProblem = (uri: string): string | undefined => {
  if (uri.length > MAX_REDIRECT_LENGTH) return "A redirect address is too long.";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `${uri.slice(0, 100)} is not an address.`;
  }
  if (url.hash !== "") return "A redirect address may not have a fragment.";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return undefined;
  return "A redirect address must use HTTPS, or HTTP on this computer.";
};

/**
 * The address a request came from. The proxy in front of the server adds the address it saw at
 * the end of X-Forwarded-For, so only the last entry is one a client cannot write itself.
 */
export const clientAddress = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["x-forwarded-for"]?.split(",").at(-1)?.trim() ||
  Option.getOrElse(request.remoteAddress, () => "unknown");

const Registration = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  client_name: Schema.optional(Schema.String),
});
const decodeRegistration = Schema.decodeUnknownOption(Registration);

/**
 * RFC 7591 dynamic client registration, which ChatGPT uses when the metadata names a
 * registration endpoint. Every client is public and proves itself with PKCE, so none gets a
 * secret.
 */
const register = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // Anyone may register, so each address gets a few registrations an hour, checked before
  // anything is stored.
  const limited = yield* (yield* Safety)
    .limitAddress(clientAddress(request), "client_register")
    .pipe(
      Effect.as(undefined),
      Effect.catchTag("RateLimited", (refused) => Effect.succeed(refused)),
    );
  if (limited !== undefined) {
    return HttpServerResponse.jsonUnsafe(
      {
        error: "rate_limited",
        error_description: "Too many apps registered from this address. Try again later.",
      },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "retry-after": String(limited.retryAfterSeconds),
        },
      },
    );
  }
  const body = yield* Effect.orElseSucceed(request.json, () => undefined);
  const registration = decodeRegistration(body);
  if (Option.isNone(registration)) {
    return oauthError("invalid_client_metadata", "Send redirect_uris as a list of addresses.");
  }
  const uris = registration.value.redirect_uris;
  if (uris.length === 0 || uris.length > MAX_REDIRECTS) {
    return oauthError(
      "invalid_redirect_uri",
      `Register between 1 and ${MAX_REDIRECTS} redirect addresses.`,
    );
  }
  const problem = uris.map(redirectProblem).find((each) => each !== undefined);
  if (problem !== undefined) return oauthError("invalid_redirect_uri", problem);
  const name = clientLabel(registration.value.client_name);
  const now = yield* Clock.currentTimeMillis;
  const id = yield* (yield* AssistantRows).registerClient({
    name,
    redirectUris: uris,
    nowMillis: now,
  });
  return json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: scopeText(ASSISTANT_SCOPES),
    },
    201,
  );
});

/** An authorization request svett must not send anywhere, as its client or address is wrong. */
class BadClient extends Data.TaggedError("BadClient")<{ readonly message: string }> {}

/** An authorization request svett answers at the client's address, with an OAuth error. */
class Refused extends Data.TaggedError("Refused")<{
  readonly redirect: string;
}> {}

interface CheckedRequest {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly offered: ReadonlyArray<AssistantScope>;
  readonly state: string | undefined;
}

/** The client's address with `params`, and `iss` as RFC 9207 asks, so it knows who answered. */
const answerAt = (
  redirectUri: string,
  base: string,
  params: Readonly<Record<string, string | undefined>>,
) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...params, iss: base })) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
};

/**
 * Checks an authorization request: a registered client, one of its addresses, the code
 * response, PKCE with S256 and, when named, svett's MCP endpoint as the resource.
 */
const checkRequest = (params: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const base = yield* publicBase;
    const clientId = params["client_id"];
    if (clientId === undefined)
      return yield* new BadClient({ message: "The app sent no client ID." });
    const found = yield* (yield* AssistantRows).client(clientId);
    if (Option.isNone(found)) {
      return yield* new BadClient({
        message: "svett does not know this app. Add svett to it again.",
      });
    }
    const client = found.value;
    const asked = params["redirect_uri"];
    const redirectUri =
      asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
      return yield* new BadClient({
        message: "The app asked svett to send you to an address it did not register.",
      });
    }
    const state = params["state"];
    const refuse = (error: string, description: string) =>
      new Refused({
        redirect: answerAt(redirectUri, base, { error, error_description: description, state }),
      });
    if (params["response_type"] !== "code") {
      return yield* refuse("unsupported_response_type", "svett answers with a code only.");
    }
    const codeChallenge = params["code_challenge"];
    if (codeChallenge === undefined || params["code_challenge_method"] !== "S256") {
      return yield* refuse("invalid_request", "svett needs PKCE with S256.");
    }
    const resource = params["resource"];
    if (resource !== undefined && resource !== `${base}${MCP_PATH}` && resource !== base) {
      return yield* refuse("invalid_target", "svett signs in for its own MCP endpoint only.");
    }
    return {
      client,
      redirectUri,
      codeChallenge,
      offered: requestedScopes(params["scope"]),
      state,
    } satisfies CheckedRequest;
  });

const page = (html: string, status = 200) =>
  HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: PAGE_HEADERS,
  });

/** The consent page, or why svett cannot show it. */
const authorizePage = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = Object.fromEntries(new URL(request.url, "http://svett").searchParams);
  const config = yield* AssistantConfig;
  return yield* checkRequest(params).pipe(
    Effect.map((checked) =>
      page(
        consentPage({
          clientName: checked.client.name,
          host: new URL(checked.redirectUri).host,
          offered: checked.offered,
          request: params,
          publishableKey: config.publishableKey,
        }),
      ),
    ),
    Effect.catchTags({
      BadClient: ({ message }) => Effect.succeed(page(problemPage(message), 400)),
      Refused: ({ redirect }) => Effect.succeed(HttpServerResponse.redirect(redirect)),
    }),
  );
});

const Decision = Schema.Struct({
  request: Schema.Record(Schema.String, Schema.String),
  decision: Schema.Literals(["allow", "deny"]),
  scopes: Schema.Array(AssistantScope),
  sessionToken: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeDecision = Schema.decodeUnknownOption(Decision);

/**
 * The person's choice on the consent page. Allow needs their Clerk session token and at least
 * one of the scopes the app asked for, and gives back the address with a code. Don't allow
 * gives back the address with access_denied.
 */
const decide = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = decodeDecision(yield* Effect.orElseSucceed(request.json, () => undefined));
  if (Option.isNone(body)) return json({ message: "svett could not read your choice." }, 400);
  const { decision, scopes, sessionToken } = body.value;
  const base = yield* publicBase;
  return yield* Effect.gen(function* () {
    const checked = yield* checkRequest(body.value.request);
    const at = (params: Readonly<Record<string, string | undefined>>) =>
      json({ redirect: answerAt(checked.redirectUri, base, { ...params, state: checked.state }) });
    if (decision === "deny") {
      return at({ error: "access_denied", error_description: "The person did not allow it." });
    }
    const chosen = checked.offered.filter((scope) => scopes.includes(scope));
    if (chosen.length === 0) {
      return json({ message: "Choose what the app may do first." }, 400);
    }
    if (sessionToken === undefined || sessionToken === null) {
      return json({ message: "Sign in to svett first." }, 401);
    }
    const account = yield* (yield* Sessions).verify(sessionToken, [base]);
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* AssistantRows;
    const code = yield* (yield* Safety).asAccount(
      account,
      undefined,
      rows.createCode(
        {
          clientId: checked.client.id,
          accountId: account,
          redirectUri: checked.redirectUri,
          codeChallenge: checked.codeChallenge,
          scopes: chosen,
        },
        now,
      ),
    );
    return at({ code });
  }).pipe(
    Effect.catchTags({
      BadClient: ({ message }) => Effect.succeed(json({ message }, 400)),
      Refused: ({ redirect }) => Effect.succeed(json({ redirect })),
      Unauthorized: () => Effect.succeed(json({ message: "Sign in to svett again." }, 401)),
      SignInUnavailable: () =>
        Effect.succeed(json({ message: "Sign-in to svett is not set up yet." }, 503)),
      AccountDeleted: () =>
        Effect.succeed(json({ message: "This svett account was deleted." }, 410)),
      RateLimited: () => Effect.succeed(json({ message: "Try again in a minute." }, 429)),
    }),
  );
});

const tokenAnswer = (tokens: Tokens) =>
  json({
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresInSeconds,
    refresh_token: tokens.refreshToken,
    scope: scopeText(tokens.scopes),
  });

/** The token endpoint's form, or its JSON from a client that sends that instead. */
const tokenParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* Effect.orElseSucceed(request.text, () => "");
  if ((request.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        return Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    } catch {}
    return {};
  }
  return Object.fromEntries(new URLSearchParams(text));
});

/**
 * Trades a code for the connection's first tokens, once, with the PKCE verifier, or a refresh
 * token for new ones. Each refresh replaces both tokens, so a used refresh token never works
 * again.
 */
const token = Effect.gen(function* () {
  const params: Readonly<Record<string, string>> = yield* tokenParams;
  const rows = yield* AssistantRows;
  const safety = yield* Safety;
  const now = yield* Clock.currentTimeMillis;
  const clientId = params["client_id"];
  if (clientId === undefined) return oauthError("invalid_client", "Send client_id.", 401);
  const grantType = params["grant_type"];
  if (grantType === "authorization_code") {
    const code = params["code"];
    const verifier = params["code_verifier"];
    if (code === undefined || verifier === undefined) {
      return oauthError("invalid_request", "Send code and code_verifier.");
    }
    const taken = yield* rows.takeCode(code);
    if (Option.isNone(taken)) return oauthError("invalid_grant", "The code is not valid.");
    const grant = taken.value;
    const redirect = params["redirect_uri"];
    if (
      grant.expiresMs <= now ||
      grant.clientId !== clientId ||
      (redirect !== undefined && redirect !== grant.redirectUri) ||
      !pkceMatches(verifier, grant.codeChallenge)
    ) {
      return oauthError("invalid_grant", "The code is not valid.");
    }
    const client = yield* rows.client(clientId);
    if (Option.isNone(client)) return oauthError("invalid_client", "Unknown client.", 401);
    return yield* safety
      .asAccount(grant.accountId, undefined, rows.connect(grant, client.value, now))
      .pipe(
        Effect.map(tokenAnswer),
        Effect.catchTag("AccountDeleted", () =>
          Effect.succeed(oauthError("invalid_grant", "The svett account was deleted.")),
        ),
      );
  }
  if (grantType === "refresh_token") {
    const refreshToken = params["refresh_token"];
    if (refreshToken === undefined) return oauthError("invalid_request", "Send refresh_token.");
    const owner = yield* rows.refreshOwner(refreshToken, clientId, now);
    if (Option.isNone(owner)) return oauthError("invalid_grant", "The refresh token is not valid.");
    return yield* safety
      .asAccount(owner.value, undefined, rows.refresh(refreshToken, clientId, now))
      .pipe(
        Effect.map(
          Option.match({
            onNone: () => oauthError("invalid_grant", "The refresh token is not valid."),
            onSome: tokenAnswer,
          }),
        ),
        Effect.catch((error) =>
          error instanceof AccountDeleted
            ? Effect.succeed(oauthError("invalid_grant", "The svett account was deleted."))
            : Effect.fail(error),
        ),
      );
  }
  return oauthError("unsupported_grant_type", "svett takes authorization_code and refresh_token.");
});

/**
 * svett's own OAuth authorization server for connected assistants, on top of the svett account
 * that Clerk signs in. Clerk keeps the person's session. svett keeps the connections, so it can
 * show separate read and propose choices, revoke a connection at once and let it last past
 * Clerk's 7-day sessions.
 */
export const AssistantOAuthRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/.well-known/oauth-protected-resource", resourceMetadata),
  HttpRouter.add("GET", RESOURCE_METADATA_PATH, resourceMetadata),
  HttpRouter.add("GET", "/.well-known/oauth-authorization-server", serverMetadata),
  HttpRouter.add("POST", OAUTH_PATHS.register, register),
  HttpRouter.add("GET", OAUTH_PATHS.authorize, authorizePage),
  HttpRouter.add("POST", OAUTH_PATHS.authorize, decide),
  HttpRouter.add("POST", OAUTH_PATHS.token, token),
);

/**
 * Removes app registrations that never connected an account within a day, and the buckets of
 * addresses that registered nothing for as long.
 */
export const expireRegistrations = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const clients = yield* (yield* AssistantRows).expireClients(now);
  yield* (yield* Safety).forgetAddresses(now - UNCONNECTED_CLIENT_MS);
  if (clients > 0) yield* Effect.logInfo(`Removed ${clients} apps that never connected`);
});

/** Expires registrations when the server starts and every hour after. */
export const ExpireRegistrations = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.repeat(
      expireRegistrations.pipe(
        Effect.catchCause((cause) => Effect.logError("Could not expire app registrations", cause)),
      ),
      Schedule.spaced("1 hour"),
    ),
  ),
);
