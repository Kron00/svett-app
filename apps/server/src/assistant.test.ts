import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import {
  ActivityRepository,
  applyProposal,
  assistantProposalId,
  httpSocialApi,
  httpSyncApi,
  MADE_HERE,
  pkceChallenge,
  proposalView,
  type RateLimit,
  type RateLimitGroup,
  receiveAssistantProposals,
  RoutineRepository,
  syncOnce,
} from "@svett/core";
import { legDay, openTestDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AccountDeletion, prepareDatabase, readyToServe } from "./account-deletion.ts";
import { AccountRoutes, DeletionRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { AssistantConfig } from "./assistant-config.ts";
import { AssistantOAuthRoutes } from "./assistant-oauth.ts";
import { AssistantRoutes } from "./assistant-routes.ts";
import { AssistantRows } from "./assistant-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { ClerkUsers } from "./clerk-users.ts";
import { databaseLayer } from "./database.ts";
import { DeletionLedger } from "./deletion-ledger.ts";
import { McpRoutes } from "./mcp.ts";
import { Safety } from "./safety.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { query, rowsNaming, startTestPostgres, type TestPostgres } from "./test-postgres.ts";

let postgres: TestPostgres;
let issuer: StandInIssuer;
let databases = 0;
let accounts = 0;
const running: Array<{ readonly dispose: () => Promise<void> }> = [];

beforeAll(async () => {
  [postgres, issuer] = await Promise.all([startTestPostgres(), startStandInIssuer()]);
}, 120_000);

afterAll(async () => {
  await Promise.all(running.map((runtime) => runtime.dispose()));
  await Promise.all([postgres?.stop(), issuer?.stop()]);
});

/** A new account ID per test, as the stand-in issuer remembers deleted users. */
const account = (name: string) => `user_${name}_${++accounts}`;

/** The address svett answers ChatGPT at, as PUBLIC_URL sets it. */
const PUBLIC = "https://svett.test";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER = "v".repeat(20) + "-verifier-of-forty-three-characters";

/** The whole server on a new database, with a ledger of its own, on a free port. */
const start = async (limits: Partial<Record<RateLimitGroup, RateLimit>> = {}) => {
  const url = await postgres.createDatabase(`assistant_${++databases}`);
  const ledger = mkdtempSync(join(tmpdir(), "svett-ledger-"));
  await Effect.runPromise(
    prepareDatabase.pipe(
      Effect.provide(Layer.merge(databaseLayer(url), DeletionLedger.layer(ledger))),
    ),
  );
  const clerk = Layer.succeed(
    ClerkConfig,
    ClerkConfig.of({
      signIn: "configured",
      issuer: issuer.issuer,
      jwksUrl: issuer.jwksUrl,
      authorizedParties: [],
      audience: undefined,
    }),
  );
  const services = Layer.mergeAll(
    AccountRows.layer,
    AssistantRows.layer,
    Sessions.layer,
    AccountDeletion.layer,
  ).pipe(
    Layer.provideMerge(Safety.layer(limits)),
    Layer.provideMerge(DeletionLedger.layer(ledger)),
    Layer.provideMerge(databaseLayer(url)),
    Layer.provideMerge(
      Layer.succeed(
        AssistantConfig,
        AssistantConfig.of({ publicUrl: PUBLIC, publishableKey: undefined }),
      ),
    ),
    Layer.provide(
      ClerkUsers.layer({ apiUrl: issuer.apiUrl, secretKey: Redacted.make(issuer.secretKey) }),
    ),
    Layer.provide(clerk),
  );
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(
      Layer.mergeAll(
        AccountRoutes,
        DeletionRoutes,
        AssistantRoutes,
        AssistantOAuthRoutes,
        McpRoutes,
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
      Layer.provide(Layer.effectDiscard(readyToServe)),
      Layer.provide(services),
    ),
  );
  running.push(runtime);
  const address = await runtime.runPromise(
    Effect.map(Effect.service(HttpServer.HttpServer), (server) => server.address),
  );
  if (!("port" in address)) throw new Error("The server is not on TCP");
  return { base: `http://127.0.0.1:${address.port}`, url };
};
type Server = Awaited<ReturnType<typeof start>>;

interface Answer {
  readonly status: number;
  readonly body: any;
  readonly headers: Headers;
}

const send = async (
  server: Server,
  method: string,
  path: string,
  options: {
    readonly token?: string;
    readonly json?: unknown;
    readonly form?: Readonly<Record<string, string>>;
    readonly redirect?: "manual";
  } = {},
): Promise<Answer> => {
  const response = await fetch(`${server.base}${path}`, {
    method,
    redirect: options.redirect ?? "follow",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.json === undefined ? {} : { "content-type": "application/json" }),
      ...(options.form === undefined
        ? {}
        : { "content-type": "application/x-www-form-urlencoded" }),
    },
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
    ...(options.form === undefined ? {} : { body: new URLSearchParams(options.form).toString() }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body, headers: response.headers };
};

/** Syncs a phone that logged a leg day titled `title` up to the server, as `who`. */
const logWorkout = async (server: Server, who: string, title: string) => {
  const phone = openTestDatabase(accounts);
  await phone.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (repository) =>
      repository.create(legDay(MADE_HERE, title)),
    ),
  );
  await phone.runtime.runPromise(
    syncOnce(
      httpSyncApi({
        server: server.base,
        accountId: who,
        token: () => issuer.sessionToken(who),
        fetch,
      }),
    ),
  );
  return phone;
};

/** Registers ChatGPT as a client, the way ChatGPT does through dynamic client registration. */
const registerChatGPT = async (server: Server) => {
  const answer = await send(server, "POST", "/oauth/register", {
    json: { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT] },
  });
  expect(answer.status).toBe(201);
  return answer.body.client_id as string;
};

const authorizeQuery = (clientId: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    state: "state-1",
    scope: "svett.read svett.propose",
    resource: `${PUBLIC}/mcp`,
    ...extra,
  });

/** The person's choice on the consent page, signed in as `who`. Gives back the code. */
const consent = async (
  server: Server,
  clientId: string,
  who: string,
  scopes: ReadonlyArray<string>,
) => {
  const answer = await send(server, "POST", "/oauth/authorize", {
    json: {
      request: Object.fromEntries(authorizeQuery(clientId)),
      decision: "allow",
      scopes,
      sessionToken: await issuer.sessionToken(who),
    },
  });
  expect(answer.status).toBe(200);
  const redirect = new URL(answer.body.redirect);
  expect(`${redirect.origin}${redirect.pathname}`).toBe(CHATGPT_REDIRECT);
  expect(redirect.searchParams.get("state")).toBe("state-1");
  expect(redirect.searchParams.get("iss")).toBe(PUBLIC);
  return redirect.searchParams.get("code")!;
};

const exchange = (server: Server, clientId: string, code: string, verifier = VERIFIER) =>
  send(server, "POST", "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: `${PUBLIC}/mcp`,
    },
  });

/** Signs `who` in through ChatGPT's whole flow and gives back the tokens. */
const connect = async (server: Server, who: string, scopes: ReadonlyArray<string>) => {
  const clientId = await registerChatGPT(server);
  const code = await consent(server, clientId, who, scopes);
  const tokens = await exchange(server, clientId, code);
  expect(tokens.status).toBe(200);
  return { clientId, ...(tokens.body as { access_token: string; refresh_token: string; scope: string }) };
};

let rpcIds = 0;
const rpc = (server: Server, token: string, method: string, params?: unknown) =>
  send(server, "POST", "/mcp", {
    token,
    json: { jsonrpc: "2.0", id: ++rpcIds, method, ...(params === undefined ? {} : { params }) },
  });

const callTool = async (server: Server, token: string, name: string, args: unknown) => {
  const answer = await rpc(server, token, "tools/call", { name, arguments: args });
  return answer;
};

const toolJson = (answer: Answer) => JSON.parse(answer.body.result.content[0].text);

const LIST_JANUARY = { from: "2025-12-30", to: "2026-01-03" };

const PUSH_DAY = {
  title: "Push day from ChatGPT",
  exercises: [
    {
      exerciseId: "",
      sets: [{ weightKg: 80, repsMin: 6, repsMax: 8 }],
      restSeconds: 120,
    },
  ],
};

/** Push day, naming the bench press by the ID search_exercises found. */
const pushDay = async (server: Server, token: string) => {
  const found = toolJson(await callTool(server, token, "search_exercises", { query: "bench press" }));
  return {
    ...PUSH_DAY,
    exercises: [{ ...PUSH_DAY.exercises[0], exerciseId: found.exercises[0].id as string }],
  };
};

describe("the connector's sign-in", () => {
  it("sends a client with no token to sign-in, through the metadata ChatGPT reads", async () => {
    const server = await start();
    const refused = await rpc(server, "", "initialize");
    // An empty bearer is no token at all.
    expect(refused.status).toBe(401);
    const unsigned = await send(server, "POST", "/mcp", {
      json: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp", scope="svett.read svett.propose"`,
    );
    const resource = await send(server, "GET", "/.well-known/oauth-protected-resource/mcp");
    expect(resource.body).toMatchObject({
      resource: `${PUBLIC}/mcp`,
      authorization_servers: [PUBLIC],
      scopes_supported: ["svett.read", "svett.propose"],
    });
    const metadata = await send(server, "GET", "/.well-known/oauth-authorization-server");
    expect(metadata.body).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/oauth/authorize`,
      token_endpoint: `${PUBLIC}/oauth/token`,
      registration_endpoint: `${PUBLIC}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("registers clients with HTTPS redirect addresses only", async () => {
    const server = await start();
    const plain = await send(server, "POST", "/oauth/register", {
      json: { client_name: "Sneaky", redirect_uris: ["http://example.com/back"] },
    });
    expect(plain.status).toBe(400);
    expect(plain.body.error).toBe("invalid_redirect_uri");
    const none = await send(server, "POST", "/oauth/register", { json: { redirect_uris: [] } });
    expect(none.status).toBe(400);
    const registered = await send(server, "POST", "/oauth/register", {
      json: { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT] },
    });
    expect(registered.body).toMatchObject({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
      token_endpoint_auth_method: "none",
    });
  });

  it("shows read and propose as separate choices, neither ticked, on the consent page", async () => {
    const server = await start();
    const clientId = await registerChatGPT(server);
    const page = await send(server, "GET", `/oauth/authorize?${authorizeQuery(clientId)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const html = page.body as string;
    expect(html).toContain("Connect ChatGPT to svett");
    expect(html).toContain("svett sends you back to chatgpt.com");
    const boxes = html.match(/<input type="checkbox" name="scope" value="[^"]+">/g);
    expect(boxes).toEqual([
      '<input type="checkbox" name="scope" value="svett.read">',
      '<input type="checkbox" name="scope" value="svett.propose">',
    ]);
    expect(html).toContain("Read your training");
    expect(html).toContain("Propose routines and programs");
    expect(html).toContain('<button id="allow" type="button" disabled>Allow</button>');
  });

  it("never sends anyone to an address the client did not register, and refuses no PKCE", async () => {
    const server = await start();
    const clientId = await registerChatGPT(server);
    const elsewhere = await send(
      server,
      "GET",
      `/oauth/authorize?${authorizeQuery(clientId, { redirect_uri: "https://evil.test/cb" })}`,
      { redirect: "manual" },
    );
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body).toContain("did not register");
    const plain = await send(
      server,
      "GET",
      `/oauth/authorize?${authorizeQuery(clientId, { code_challenge_method: "plain" })}`,
      { redirect: "manual" },
    );
    expect(plain.status).toBe(302);
    const back = new URL(plain.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("state-1");
  });

  it("answers Don't allow with access_denied and no code", async () => {
    const server = await start();
    const clientId = await registerChatGPT(server);
    const answer = await send(server, "POST", "/oauth/authorize", {
      json: { request: Object.fromEntries(authorizeQuery(clientId)), decision: "deny", scopes: [] },
    });
    const back = new URL(answer.body.redirect);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("needs a svett session and a chosen scope before it gives a code", async () => {
    const server = await start();
    const clientId = await registerChatGPT(server);
    const request = Object.fromEntries(authorizeQuery(clientId));
    const nobody = await send(server, "POST", "/oauth/authorize", {
      json: { request, decision: "allow", scopes: ["svett.read"] },
    });
    expect(nobody.status).toBe(401);
    const forged = await send(server, "POST", "/oauth/authorize", {
      json: {
        request,
        decision: "allow",
        scopes: ["svett.read"],
        sessionToken: await issuer.sessionToken(account("forger"), { key: "unpublished" }),
      },
    });
    expect(forged.status).toBe(401);
    const nothing = await send(server, "POST", "/oauth/authorize", {
      json: {
        request,
        decision: "allow",
        scopes: [],
        sessionToken: await issuer.sessionToken(account("undecided")),
      },
    });
    expect(nothing.status).toBe(400);
  });

  it("trades a code once, only with the PKCE verifier it was made for", async () => {
    const server = await start();
    const alice = account("alice");
    const clientId = await registerChatGPT(server);
    const wrong = await exchange(
      server,
      clientId,
      await consent(server, clientId, alice, ["svett.read"]),
      "w".repeat(43),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    const code = await consent(server, clientId, alice, ["svett.read"]);
    const first = await exchange(server, clientId, code);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "svett.read" });
    expect(first.headers.get("cache-control")).toBe("no-store");
    const again = await exchange(server, clientId, code);
    expect(again.body.error).toBe("invalid_grant");
  });

  it("replaces both tokens on refresh, so the old ones stop working", async () => {
    const server = await start();
    const alice = account("alice");
    const tokens = await connect(server, alice, ["svett.read"]);
    const refreshed = await send(server, "POST", "/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.scope).toBe("svett.read");
    expect((await rpc(server, tokens.access_token, "ping")).status).toBe(401);
    expect((await rpc(server, refreshed.body.access_token, "ping")).status).toBe(200);
    const reused = await send(server, "POST", "/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId },
    });
    expect(reused.body.error).toBe("invalid_grant");
  });
});

describe("the connector's tools", () => {
  it("lists the account's own workouts and nobody else's, and logs the read", async () => {
    const server = await start();
    const alice = account("alice");
    const bob = account("bob");
    await logWorkout(server, alice, "Alice legs");
    await logWorkout(server, bob, "Bob legs");
    const tokens = await connect(server, alice, ["svett.read"]);
    const before = await send(server, "GET", "/v1/connections", {
      token: await issuer.sessionToken(alice),
    });
    expect(before.body.connections).toMatchObject([
      { name: "ChatGPT", host: "chatgpt.com", scopes: ["svett.read"], lastReadAt: null },
    ]);

    const init = await rpc(server, tokens.access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "svett" },
      capabilities: { tools: {} },
    });
    const listed = await rpc(server, tokens.access_token, "tools/list");
    const names = (listed.body.result.tools as Array<{ name: string; annotations: any }>).map(
      (tool) => [tool.name, tool.annotations.readOnlyHint],
    );
    expect(names).toEqual([
      ["search_exercises", true],
      ["list_workouts", true],
      ["get_workout", true],
      ["best_sets", true],
      ["exercise_history", true],
      ["body_measurements", true],
      ["list_routines", true],
    ]);

    const workouts = toolJson(await callTool(server, tokens.access_token, "list_workouts", LIST_JANUARY));
    expect(workouts.workouts.map((each: any) => each.title.userWritten)).toEqual(["Alice legs"]);
    expect(JSON.stringify(workouts)).not.toContain("Bob");

    const after = await send(server, "GET", "/v1/connections", {
      token: await issuer.sessionToken(alice),
    });
    expect(after.body.connections[0].lastReadAt).toEqual(expect.any(Number));
    const log = await query<{ tool: string }>(
      server.url,
      `select tool from assistant_access where account_id = '${alice}' order by at_ms`,
    );
    expect(log.map(({ tool }) => tool)).toEqual(["list_workouts"]);
  });

  it("refuses a proposal from a connection allowed only to read", async () => {
    const server = await start();
    const alice = account("alice");
    const tokens = await connect(server, alice, ["svett.read"]);
    const answer = await callTool(server, tokens.access_token, "propose_routine", PUSH_DAY);
    expect(answer.body.result.isError).toBe(true);
    expect(toolJson(answer).error).toContain("may not propose");
  });

  it("refuses reads from a connection allowed only to propose", async () => {
    const server = await start();
    const alice = account("alice");
    await logWorkout(server, alice, "Alice legs");
    const tokens = await connect(server, alice, ["svett.propose"]);
    const listed = await rpc(server, tokens.access_token, "tools/list");
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "propose_routine",
      "propose_program",
    ]);
    const answer = await callTool(server, tokens.access_token, "list_workouts", LIST_JANUARY);
    expect(answer.body.result.isError).toBe(true);
    expect(JSON.stringify(answer.body)).not.toContain("Alice legs");
  });

  it("keeps a proposal pending until the phone applies it, and changes no routine itself", async () => {
    const server = await start();
    const alice = account("alice");
    const phone = await logWorkout(server, alice, "Alice legs");
    const tokens = await connect(server, alice, ["svett.read", "svett.propose"]);
    const answer = await callTool(
      server,
      tokens.access_token,
      "propose_routine",
      await pushDay(server, tokens.access_token),
    );
    expect(answer.body.result.isError).toBe(false);
    const made = toolJson(answer);
    expect(made.shown).toContain("Nothing is saved until the person taps Apply");

    const serverRoutines = await query(
      server.url,
      `select 1 from account_row where account_id = '${alice}' and table_name = 'routine'`,
    );
    expect(serverRoutines).toEqual([]);

    const api = httpSocialApi({
      server: server.base,
      token: () => issuer.sessionToken(alice),
      fetch,
    });
    const stored = await phone.runtime.runPromise(receiveAssistantProposals(api.assistantProposals));
    expect(stored).toBe(1);
    const id = assistantProposalId(made.proposalId);
    const view = await phone.runtime.runPromise(proposalView(id));
    expect(view.status).toBe("pending");
    const routines = () =>
      phone.runtime.runPromise(
        Effect.flatMap(Effect.service(RoutineRepository), (repository) => repository.listRoutines),
      );
    expect(await routines()).toEqual([]);
    await phone.runtime.runPromise(applyProposal(id));
    expect((await routines()).map((routine) => routine.title)).toEqual(["Push day from ChatGPT"]);
    // The server forgot the proposal once the phone had it.
    expect(await phone.runtime.runPromise(receiveAssistantProposals(api.assistantProposals))).toBe(0);
  });

  it("answers 401 to the next request after Revoke, and lists the connection no more", async () => {
    const server = await start();
    const alice = account("alice");
    const tokens = await connect(server, alice, ["svett.read"]);
    expect((await rpc(server, tokens.access_token, "tools/list")).status).toBe(200);
    const session = await issuer.sessionToken(alice);
    const [connection] = (await send(server, "GET", "/v1/connections", { token: session })).body
      .connections;
    const revoked = await send(server, "DELETE", `/v1/connections/${connection.id}`, {
      token: session,
    });
    expect(revoked.body).toEqual({ revoked: true });
    const after = await callTool(server, tokens.access_token, "list_workouts", LIST_JANUARY);
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const refresh = await send(server, "POST", "/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId },
    });
    expect(refresh.body.error).toBe("invalid_grant");
    expect((await send(server, "GET", "/v1/connections", { token: session })).body).toEqual({
      connections: [],
    });
    const again = await send(server, "DELETE", `/v1/connections/${connection.id}`, {
      token: session,
    });
    expect(again.status).toBe(404);
  });

  it("lets nobody revoke another account's connection", async () => {
    const server = await start();
    const alice = account("alice");
    const tokens = await connect(server, alice, ["svett.read"]);
    const [connection] = (
      await send(server, "GET", "/v1/connections", { token: await issuer.sessionToken(alice) })
    ).body.connections;
    const bob = await send(server, "DELETE", `/v1/connections/${connection.id}`, {
      token: await issuer.sessionToken(account("bob")),
    });
    expect(bob.status).toBe(404);
    expect((await rpc(server, tokens.access_token, "ping")).status).toBe(200);
  });

  it("answers 401 once the account is deleted, and keeps none of its connection", async () => {
    const server = await start();
    const alice = account("alice");
    await logWorkout(server, alice, "Alice legs");
    const tokens = await connect(server, alice, ["svett.read", "svett.propose"]);
    await callTool(server, tokens.access_token, "list_workouts", LIST_JANUARY);
    await callTool(server, tokens.access_token, "propose_routine", await pushDay(server, tokens.access_token));
    const deleted = await send(server, "DELETE", "/v1/me", {
      token: await issuer.sessionToken(alice),
    });
    expect(deleted.status).toBe(200);
    expect((await rpc(server, tokens.access_token, "tools/list")).status).toBe(401);
    const refresh = await send(server, "POST", "/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId },
    });
    expect(refresh.body.error).toBe("invalid_grant");
    const left = await rowsNaming(server.url, alice);
    expect(
      Object.fromEntries(Object.entries(left).filter(([table]) => /assistant|oauth/.test(table))),
    ).toEqual({ assistant_access: 0, assistant_connection: 0, assistant_proposal: 0, oauth_code: 0 });
  });

  it("slows a connection that calls too often, with S5's token bucket", async () => {
    const server = await start({ assistant: { capacity: 2, perSecond: 1 / 3600 } });
    const alice = account("alice");
    const tokens = await connect(server, alice, ["svett.read"]);
    for (let call = 0; call < 2; call++) {
      const answer = await callTool(server, tokens.access_token, "list_routines", {});
      expect(answer.body.result.isError).toBe(false);
    }
    const limited = await callTool(server, tokens.access_token, "list_routines", {});
    expect(limited.body.result.isError).toBe(true);
    expect(toolJson(limited).error).toMatch(/try again/i);
  });
});
