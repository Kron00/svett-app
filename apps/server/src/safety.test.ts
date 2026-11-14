import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  AccountId,
  ActivityRepository,
  decodeSvettFile,
  httpSyncApi,
  MADE_HERE,
  type RateLimit,
  type RateLimitGroup,
  SyncFailed,
  syncOnce,
  SyncRepository,
  TransferRepository,
} from "@svett/core";
import { legDay, openTestDatabase, syncedRows } from "@svett/core/node";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted, Result } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { ACCOUNT_TABLES, AccountDeletion, KEPT_TABLES } from "./account-deletion.ts";
import { AccountRoutes, DeletionRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { ClerkUsers } from "./clerk-users.ts";
import { databaseLayer, migrate } from "./database.ts";
import { FeedRoutes } from "./feed-routes.ts";
import { FeedRows } from "./feed-rows.ts";
import { Safety } from "./safety.ts";
import { safetyProof } from "./safety-proof.ts";
import { SocialRoutes } from "./social-routes.ts";
import { SocialRows } from "./social-rows.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { startTestPostgres, type TestPostgres } from "./test-postgres.ts";

let postgres: TestPostgres;
let issuer: StandInIssuer;
let databases = 0;
const running: Array<{ readonly dispose: () => Promise<void> }> = [];

beforeAll(async () => {
  [postgres, issuer] = await Promise.all([startTestPostgres(), startStandInIssuer()]);
}, 120_000);

afterAll(async () => {
  await Promise.all(running.map((runtime) => runtime.dispose()));
  await Promise.all([postgres?.stop(), issuer?.stop()]);
});

let accounts = 0;
/** A new account ID per test, as the stand-in issuer remembers deleted users. */
const account = (name: string) => `user_${name}_${++accounts}`;

const freshDatabase = async () => {
  const url = await postgres.createDatabase(`safety_${++databases}`);
  await Effect.runPromise(migrate.pipe(Effect.provide(databaseLayer(url))));
  return url;
};

interface ServerOptions {
  readonly limits?: Partial<Record<RateLimitGroup, RateLimit>>;
  /** Null starts the server without a Clerk secret key. */
  readonly secretKey?: string | null;
}

const servicesOf = (url: Redacted.Redacted, options: ServerOptions = {}) => {
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
  const users = ClerkUsers.layer({
    apiUrl: issuer.apiUrl,
    secretKey:
      options.secretKey === null
        ? undefined
        : Redacted.make(options.secretKey ?? issuer.secretKey),
  });
  return Layer.mergeAll(
    AccountRows.layer,
    SocialRows.layer,
    FeedRows.layer,
    Sessions.layer,
    AccountDeletion.layer,
  ).pipe(
    Layer.provideMerge(Safety.layer(options.limits)),
    Layer.provideMerge(databaseLayer(url)),
    Layer.provide(users),
    Layer.provide(clerk),
  );
};

/** The whole server on `url`, listening on a free port. Gives back its address. */
const start = async (url: Redacted.Redacted, options: ServerOptions = {}) => {
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(Layer.mergeAll(AccountRoutes, DeletionRoutes, SocialRoutes, FeedRoutes), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
      Layer.provide(servicesOf(url, options)),
    ),
  );
  running.push(runtime);
  const address = await runtime.runPromise(
    Effect.map(Effect.service(HttpServer.HttpServer), (server) => server.address),
  );
  if (!("port" in address)) throw new Error("The server is not on TCP");
  return { base: `http://127.0.0.1:${address.port}`, stop: () => runtime.dispose() };
};

type Answer = {
  readonly status: number;
  readonly body: any;
  readonly headers: Headers;
};

/** Sends a request as `who`, an account or a token it holds already. */
const send = async (
  base: string,
  who: string | { readonly token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> => {
  const token = typeof who === "string" ? await issuer.sessionToken(who) : who.token;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Kept as text.
  }
  return { status: response.status, body: parsed, headers: response.headers };
};

/** A client for one server that expects 200 from `ok` and gives back any answer from `call`. */
const client = (base: string) => {
  const call = (who: string | { readonly token: string }, method: string, path: string, body?: unknown) =>
    send(base, who, method, path, body);
  const ok = async (who: string, method: string, path: string, body?: unknown) => {
    const answer = await call(who, method, path, body);
    if (answer.status !== 200) {
      throw new Error(`${method} ${path} answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    }
    return answer.body;
  };
  return {
    call,
    ok,
    name: (who: string, username: string, isPrivate = false) =>
      ok(who, "PUT", "/v1/profile", { username, private: isPrivate }),
    write: (who: string, rows: ReadonlyArray<Record<string, unknown>>) =>
      ok(who, "PUT", "/v1/rows", { rows: rows.map((row) => ({ table: "activity", row })) }),
    /** The social ID of the owner's activity with this title, as `viewer` reads it. */
    postId: async (viewer: string, owner: string, title: string) => {
      const profile = await ok(viewer, "GET", `/v1/profiles/${owner}`);
      const found = (profile.activities as ReadonlyArray<{ id: string; title: string }>).find(
        (each) => each.title === title,
      );
      if (found === undefined) throw new Error(`${viewer} does not see ${title}`);
      return found.id;
    },
  };
};

let ids = 0;
const activity = (title: string, audience = "everyone") => ({
  id: `0190a0b2-0000-7000-8000-${String(++ids).padStart(12, "0")}`,
  updatedAt: 1,
  deletedAt: null,
  kind: "run",
  startedAt: 1_790_000_000_000 + ids,
  durationS: 1800,
  title,
  notes: "",
  energyKcal: 410,
  audience,
  hiddenFields: "[]",
  source: "svett",
  sourceId: null,
  fingerprint: null,
  importBatchId: null,
});

const query = <A extends object = Record<string, unknown>>(url: Redacted.Redacted, text: string) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(PgClient.PgClient), (sql) => sql.unsafe<A>(text)).pipe(
      Effect.provide(databaseLayer(url)),
    ),
  );

/** How many rows of each table name `id` in any of their text columns. */
const rowsNaming = async (url: Redacted.Redacted, id: string) => {
  const columns = await query<{ table_name: string; column_name: string }>(
    url,
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public' and data_type = 'text' order by table_name, column_name`,
  );
  const tables = new Map<string, Array<string>>();
  for (const { table_name, column_name } of columns) {
    tables.set(table_name, [...(tables.get(table_name) ?? []), column_name]);
  }
  const counts: Record<string, number> = {};
  for (const [table, names] of tables) {
    if (table in KEPT_TABLES) continue;
    const where = names.map((column) => `"${column}" = '${id}'`).join(" or ");
    const [row] = await query<{ n: number }>(
      url,
      `select count(*)::int as n from "${table}" where ${where}`,
    );
    counts[table] = row?.n ?? 0;
  }
  return counts;
};

const schemaTables = async (url: Redacted.Redacted) =>
  (
    await query<{ table_name: string }>(
      url,
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    )
  ).map((row) => row.table_name);

describe("blocking", { timeout: 60_000 }, () => {
  it("hides each account from the other, ends follows both ways and refuses follows, likes and comments", async () => {
    const url = await freshDatabase();
    const { base } = await start(url);
    const api = client(base);
    const [anna, ben, cara] = [account("anna"), account("ben"), account("cara")];
    await api.name(anna, "anna");
    await api.name(ben, "ben");
    await api.name(cara, "cara");
    const annasRun = activity("Anna's run");
    const bensRun = activity("Ben's run");
    await api.write(anna, [annasRun]);
    await api.write(ben, [bensRun]);
    await api.ok(ben, "PUT", "/v1/profiles/anna/follow");
    await api.ok(anna, "PUT", "/v1/profiles/ben/follow");
    await api.ok(anna, "PUT", "/v1/profiles/cara/follow");
    const post = await api.postId(ben, "anna", annasRun.title);
    await api.ok(ben, "PUT", `/v1/posts/${post}/like`);
    await api.ok(ben, "POST", `/v1/posts/${post}/comments`, { body: "Strong pace" });
    expect((await api.ok(ben, "GET", "/v1/feed")).posts.map((each: any) => each.username)).toContain(
      "anna",
    );

    await api.ok(anna, "PUT", "/v1/profiles/ben/block");

    // Ben, the blocked account.
    expect((await api.call(ben, "GET", "/v1/profiles/anna")).status).toBe(404);
    expect((await api.ok(ben, "GET", "/v1/profiles?prefix=an")).profiles).toEqual([]);
    expect(
      (await api.ok(ben, "GET", "/v1/profiles/cara/followers")).profiles.map(
        (each: any) => each.username,
      ),
    ).toEqual([]);
    expect((await api.ok(ben, "GET", "/v1/feed")).posts.map((each: any) => each.username)).toEqual(
      ["ben"],
    );
    expect((await api.call(ben, "GET", `/v1/posts/${post}`)).body).toEqual({
      error: "post_not_found",
    });
    expect((await api.call(ben, "GET", `/v1/activities/${post}`)).status).toBe(404);
    expect((await api.call(ben, "PUT", `/v1/posts/${post}/like`)).body).toEqual({
      error: "post_not_found",
    });
    expect(
      (await api.call(ben, "POST", `/v1/posts/${post}/comments`, { body: "Hello?" })).body,
    ).toEqual({ error: "post_not_found" });
    expect((await api.call(ben, "PUT", "/v1/profiles/anna/follow")).body).toEqual({
      error: "not_found",
    });

    // Anna, the blocker, sees none of Ben either.
    expect((await api.call(anna, "GET", "/v1/profiles/ben")).status).toBe(404);
    expect((await api.ok(anna, "GET", "/v1/profiles?prefix=be")).profiles).toEqual([]);
    expect((await api.ok(anna, "GET", "/v1/feed")).posts.map((each: any) => each.username)).toEqual(
      ["anna"],
    );
    expect((await api.ok(anna, "GET", "/v1/inbox")).items).toEqual([]);
    expect((await api.ok(anna, "GET", `/v1/posts/${post}`)).comments).toEqual([]);
    expect(await api.ok(anna, "GET", "/v1/profile")).toMatchObject({
      followers: 0,
      following: 1,
    });

    // Each side can keep the other out, whoever blocked first.
    await api.ok(ben, "PUT", "/v1/profiles/anna/block");
    expect((await api.ok(ben, "GET", "/v1/blocks")).blocks.map((each: any) => each.username)).toEqual(
      ["anna"],
    );
  });

  it("ends a block by its ID only for the account that made it, and leaves the follow ended", async () => {
    const { base } = await start(await freshDatabase());
    const api = client(base);
    const [anna, ben] = [account("anna"), account("ben")];
    await api.name(anna, "anna");
    await api.name(ben, "ben");
    await api.ok(ben, "PUT", "/v1/profiles/anna/follow");
    await api.ok(anna, "PUT", "/v1/profiles/ben/block");
    const [block] = (await api.ok(anna, "GET", "/v1/blocks")).blocks;
    expect(block.username).toBe("ben");

    expect((await api.call(ben, "DELETE", `/v1/blocks/${block.id}`)).body).toEqual({
      error: "block_not_found",
    });
    await api.ok(anna, "DELETE", `/v1/blocks/${block.id}`);

    expect(await api.ok(ben, "GET", "/v1/profiles/anna")).toMatchObject({ follow: "none" });
    expect((await api.ok(anna, "GET", "/v1/blocks")).blocks).toEqual([]);
  });

  it("refuses to block yourself or nobody", async () => {
    const { base } = await start(await freshDatabase());
    const api = client(base);
    const anna = account("anna");
    await api.name(anna, "anna");
    expect((await api.call(anna, "PUT", "/v1/profiles/anna/block")).body).toEqual({
      error: "cannot_block_self",
    });
    expect((await api.call(anna, "PUT", "/v1/profiles/nobody/block")).body).toEqual({
      error: "not_found",
    });
  });
});

describe("removing a follower", { timeout: 60_000 }, () => {
  it("ends their follow without blocking them", async () => {
    const { base } = await start(await freshDatabase());
    const api = client(base);
    const [anna, ben] = [account("anna"), account("ben")];
    await api.name(anna, "anna", true);
    await api.name(ben, "ben");
    await api.ok(ben, "PUT", "/v1/profiles/anna/follow");
    const [request] = (await api.ok(anna, "GET", "/v1/follow-requests")).requests;
    await api.ok(anna, "PUT", `/v1/follow-requests/${request.id}`);
    expect(await api.ok(anna, "GET", "/v1/profile")).toMatchObject({ followers: 1 });

    await api.ok(anna, "DELETE", "/v1/followers/ben");

    expect(await api.ok(anna, "GET", "/v1/profile")).toMatchObject({ followers: 0 });
    expect(await api.ok(ben, "GET", "/v1/profiles/anna")).toMatchObject({ follow: "none" });
    expect((await api.ok(ben, "PUT", "/v1/profiles/anna/follow")).follow).toBe("requested");
  });
});

const retryAfter = (answer: Answer) => Number(answer.headers.get("retry-after"));

describe("rate limits", { timeout: 60_000 }, () => {
  it("answer 429 with Retry-After once an account spends its likes, per account and per group", async () => {
    const { base } = await start(await freshDatabase(), {
      limits: { likes: { capacity: 2, perSecond: 1 / 60 } },
    });
    const api = client(base);
    const [anna, ben, cara] = [account("anna"), account("ben"), account("cara")];
    await api.name(anna, "anna");
    await api.name(ben, "ben");
    await api.name(cara, "cara");
    const run = activity("Anna's run");
    await api.write(anna, [run]);
    const post = await api.postId(ben, "anna", run.title);

    await api.ok(ben, "PUT", `/v1/posts/${post}/like`);
    await api.ok(ben, "DELETE", `/v1/posts/${post}/like`);
    const refused = await api.call(ben, "PUT", `/v1/posts/${post}/like`);

    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: "rate_limited", group: "likes" });
    expect(retryAfter(refused)).toBeGreaterThanOrEqual(59);
    expect(retryAfter(refused)).toBeLessThanOrEqual(60);
    expect(refused.body.retryAfter).toBe(retryAfter(refused));
    expect((await api.call(cara, "PUT", `/v1/posts/${post}/like`)).status).toBe(200);
    expect((await api.call(ben, "POST", `/v1/posts/${post}/comments`, { body: "Nice" })).status).toBe(
      200,
    );
  });

  it("counts a refused request too", async () => {
    const { base } = await start(await freshDatabase(), {
      limits: { follows: { capacity: 1, perSecond: 1 / 60 } },
    });
    const api = client(base);
    const [anna, ben] = [account("anna"), account("ben")];
    await api.name(anna, "anna");
    await api.name(ben, "ben");
    expect((await api.call(ben, "PUT", "/v1/profiles/nobody/follow")).status).toBe(404);
    expect((await api.call(ben, "PUT", "/v1/profiles/anna/follow")).status).toBe(429);
  });

  it("keeps counting across a restart and across servers on one database", async () => {
    const url = await freshDatabase();
    const limits = { search: { capacity: 2, perSecond: 1 / 3600 } };
    const first = await start(url, { limits });
    const second = await start(url, { limits });
    const ben = account("ben");
    await client(first.base).name(ben, "ben");

    expect((await client(first.base).call(ben, "GET", "/v1/profiles?prefix=a")).status).toBe(200);
    expect((await client(second.base).call(ben, "GET", "/v1/profiles?prefix=a")).status).toBe(200);
    expect((await client(first.base).call(ben, "GET", "/v1/profiles?prefix=a")).status).toBe(429);

    await first.stop();
    await second.stop();
    const restarted = await start(url, { limits });
    const refused = await client(restarted.base).call(ben, "GET", "/v1/profiles?prefix=a");
    expect(refused.status).toBe(429);
    expect(retryAfter(refused)).toBeGreaterThan(3_000);
  });

  it("limits sync pushes", async () => {
    const { base } = await start(await freshDatabase(), {
      limits: { sync_push: { capacity: 1, perSecond: 1 / 60 } },
    });
    const api = client(base);
    const anna = account("anna");
    await api.write(anna, [activity("First")]);
    const refused = await api.call(anna, "PUT", "/v1/rows", {
      rows: [{ table: "activity", row: activity("Second") }],
    });
    expect(refused.status).toBe(429);
    expect((await api.ok(anna, "GET", "/v1/rows")).rows).toHaveLength(1);
  });
});

/** A phone signed in to `who`, with its own database, syncing with `base`. */
const openPhone = (base: string, who: string, seed: number) => {
  const database = openTestDatabase(seed);
  const sync = (token: () => Promise<string | null> = () => issuer.sessionToken(who)) =>
    database.runtime.runPromiseExit(
      syncOnce(httpSyncApi({ server: base, accountId: who, token, fetch })),
    );
  const logLegDay = () =>
    database.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(legDay(MADE_HERE)),
      ),
    );
  return { ...database, sync, logLegDay };
};

const problemOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "synced";
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return error instanceof SyncFailed ? error.problem : String(error);
};

describe("the server-side export", { timeout: 60_000 }, () => {
  it("gives back the account's own rows as a svett file that the app imports to the same rows", async () => {
    const { base } = await start(await freshDatabase());
    const [anna, ben] = [account("anna"), account("ben")];
    const phone = openPhone(base, anna, 1);
    const kept = await phone.logLegDay();
    const dropped = await phone.logLegDay();
    await phone.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.remove(dropped),
      ),
    );
    expect(problemOf(await phone.sync())).toBe("synced");
    await client(base).write(ben, [activity("Ben's own run")]);

    const answer = await send(base, anna, "GET", "/v1/export");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-disposition")).toMatch(
      /^attachment; filename="svett-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const file = Result.getOrThrow(decodeSvettFile(JSON.stringify(answer.body)));
    expect(file.tables.activity?.map((row) => row.id).sort()).toEqual(
      [kept, dropped].sort(),
    );

    const fresh = openTestDatabase(2);
    const imported = await fresh.runtime.runPromise(
      Effect.flatMap(Effect.service(TransferRepository), (transfers) =>
        transfers.applyImport(file, []),
      ),
    );
    expect(Option.getOrThrow(imported).added).toBeGreaterThan(0);
    const before = await syncedRows(phone.runtime);
    const after = await syncedRows(fresh.runtime);
    for (const table of Object.keys(before)) {
      if (table === "import_batch" || table === "import_change") continue;
      expect({ table, rows: after[table] }).toEqual({ table, rows: before[table] });
    }
  });
});

describe("deleting an account", { timeout: 60_000 }, () => {
  it("covers every table in the schema", async () => {
    const tables = await schemaTables(await freshDatabase());
    expect(tables).toEqual(
      [...Object.keys(ACCOUNT_TABLES), ...Object.keys(KEPT_TABLES)].sort(),
    );
  });

  it("deletes every row the account owns in every table, and leaves other accounts' rows", async () => {
    const url = await freshDatabase();
    const { base } = await start(url);
    const api = client(base);
    const [anna, ben, cara, dan, eve] = ["anna", "ben", "cara", "dan", "eve"].map(account) as [
      string,
      string,
      string,
      string,
      string,
    ];
    for (const [who, username] of [
      [anna, "anna"],
      [ben, "ben"],
      [cara, "cara"],
      [dan, "dan"],
      [eve, "eve"],
    ] as const) {
      await api.name(who, username);
    }
    const annasRun = activity("Anna's run");
    const bensRun = activity("Ben's run");
    await api.write(anna, [annasRun]);
    await api.write(ben, [bensRun]);
    await api.ok(anna, "PUT", "/v1/profiles/ben/follow");
    await api.ok(cara, "PUT", "/v1/profiles/anna/follow");
    await api.ok(anna, "PUT", "/v1/profiles/dan/block");
    await api.ok(eve, "PUT", "/v1/profiles/anna/block");
    const annasPost = await api.postId(cara, "anna", annasRun.title);
    const bensPost = await api.postId(anna, "ben", bensRun.title);
    await api.ok(cara, "PUT", `/v1/posts/${annasPost}/like`);
    await api.ok(anna, "PUT", `/v1/posts/${bensPost}/like`);
    await api.ok(cara, "POST", `/v1/posts/${annasPost}/comments`, { body: "Fast" });
    await api.ok(anna, "POST", `/v1/posts/${bensPost}/comments`, { body: "Nice" });
    await api.ok(anna, "PUT", "/v1/inbox/read", { until: Date.now() });

    const before = await rowsNaming(url, anna);
    const missing = Object.keys(ACCOUNT_TABLES).filter((table) => !(before[table]! > 0));
    expect(missing, "the test must give the account a row in every table").toEqual([]);
    const othersBefore = await rowsNaming(url, ben);

    expect(await api.ok(anna, "DELETE", "/v1/me")).toEqual({ deleted: true });

    const after = await rowsNaming(url, anna);
    expect(Object.values(after).every((count) => count === 0), JSON.stringify(after)).toBe(true);
    const othersAfter = await rowsNaming(url, ben);
    expect(othersAfter).toMatchObject({
      account: 1,
      account_row: othersBefore["account_row"],
      profile: 1,
    });
    // Ben's post keeps his own row, and loses only Anna's like and comment.
    expect(othersAfter["activity_like"]).toBe(othersBefore["activity_like"]! - 1);
    expect(othersAfter["activity_comment"]).toBe(othersBefore["activity_comment"]! - 1);
    expect(await query(url, `select id from deleted_account`)).toEqual([{ id: anna }]);
    expect(await api.ok(ben, "GET", "/v1/profiles/ben")).toMatchObject({ followers: 0 });
  });

  it("ends every session through Clerk and refuses the account's still-valid tokens", async () => {
    const url = await freshDatabase();
    const { base } = await start(url);
    const anna = account("anna");
    const api = client(base);
    await api.name(anna, "anna");
    const held = { token: await issuer.sessionToken(anna) };

    await api.ok(anna, "DELETE", "/v1/me");

    expect(issuer.deletedUsers()).toContain(anna);
    await expect(issuer.sessionToken(anna)).rejects.toThrow("ended every session");
    for (const [method, path] of [
      ["GET", "/v1/me"],
      ["GET", "/v1/feed"],
      ["GET", "/v1/export"],
      ["PUT", "/v1/profile"],
    ] as const) {
      const body = method === "PUT" ? { username: "anna", private: false } : undefined;
      const answer = await api.call(held, method, path, body);
      expect({ path, status: answer.status, error: answer.body.error }).toEqual({
        path,
        status: 410,
        error: "account_deleted",
      });
    }
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 0, profile: 0 });
  });

  it("refuses the upload of a second phone that was offline, and recreates nothing", async () => {
    const url = await freshDatabase();
    const { base } = await start(url);
    const anna = account("anna");
    const first = openPhone(base, anna, 1);
    const second = openPhone(base, anna, 2);
    await first.logLegDay();
    expect(problemOf(await first.sync())).toBe("synced");
    expect(problemOf(await second.sync())).toBe("synced");
    // The second phone signed in before, and holds a token that is still valid.
    const held = await issuer.sessionToken(anna);
    await second.logLegDay();

    expect((await send(base, anna, "DELETE", "/v1/me")).body).toEqual({ deleted: true });

    expect(problemOf(await second.sync(async () => held))).toBe("account_deleted");
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 0, account_row: 0 });
    // Nothing is lost on the phone: its change still waits in its queue.
    expect(
      await second.runtime.runPromise(
        Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queuedCount),
      ),
    ).toBeGreaterThan(0);
  });

  it("deletes nothing when the server cannot end sessions", async () => {
    const url = await freshDatabase();
    const { base } = await start(url, { secretKey: null });
    const api = client(base);
    const anna = account("anna");
    await api.write(anna, [activity("Kept")]);

    const refused = await api.call(anna, "DELETE", "/v1/me");

    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe("session_end_failed");
    expect((await api.ok(anna, "GET", "/v1/rows")).rows).toHaveLength(1);
  });

  it("finishes a deletion Clerk failed when it is sent again", async () => {
    const url = await freshDatabase();
    const { base } = await start(url);
    const api = client(base);
    const anna = account("anna");
    await api.write(anna, [activity("Gone")]);

    issuer.failBackendApi(503);
    try {
      expect((await api.call(anna, "DELETE", "/v1/me")).body.error).toBe("session_end_failed");
    } finally {
      issuer.failBackendApi(undefined);
    }
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 0, account_row: 0 });
    expect((await api.call(anna, "GET", "/v1/me")).status).toBe(410);

    expect(await api.ok(anna, "DELETE", "/v1/me")).toEqual({ deleted: true });
    expect(issuer.deletedUsers()).toContain(anna);
  });

  it("waits for a request in flight, so nothing it writes outlives the deletion", async () => {
    const url = await freshDatabase();
    const anna = AccountId.make(account("anna"));
    const services = servicesOf(url);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const safety = yield* Safety;
        const rows = yield* AccountRows;
        const deletion = yield* AccountDeletion;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const request = yield* Effect.forkChild(
          safety.asAccount(
            anna,
            undefined,
            Effect.gen(function* () {
              yield* rows.ensureAccount(anna);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }),
          ),
        );
        yield* Deferred.await(started);
        const deleting = yield* Effect.forkChild(deletion.remove(anna));
        yield* Effect.sleep("300 millis");
        const waited = deleting.pollUnsafe() === undefined;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(request);
        yield* Fiber.join(deleting);
        return { waited };
      }).pipe(Effect.provide(services)),
    );
    expect(result).toEqual({ waited: true });
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 0 });
  });
});

describe("the safety proof script", { timeout: 60_000 }, () => {
  it("passes against a running server with the stand-in issuer, twice", async () => {
    const { base } = await start(await freshDatabase());
    const owner = account("proof_owner");
    const blocked = account("proof_blocked");
    const lines: Array<string> = [];
    for (const run of [1, 2]) {
      const leaver = account(`proof_leaver_${run}`);
      const names = { owner, blocked, leaver };
      await safetyProof({
        server: base,
        token: (who) => issuer.sessionToken(names[who]),
        usernames: { owner: "safety_a", blocked: "safety_b" },
        log: (line) => lines.push(line),
      });
    }
    expect(lines.slice(0, 4)).toEqual([
      "safety_b follows safety_a and sees the everyone activity",
      "Blocked: safety_b finds no profile, search result, feed post or post of safety_a, and cannot follow, like or comment",
      "Ended the block and deleted the proof's activity",
      "Deleted: Clerk ends every session, and the offline phone's upload is refused as account_deleted",
    ]);
    expect(lines.slice(4)).toEqual(lines.slice(0, 4));
  });

  it("fails when the deleted account still gets a session", async () => {
    const { base } = await start(await freshDatabase());
    const names = {
      owner: account("leak_owner"),
      blocked: account("leak_blocked"),
      leaver: account("leak_leaver"),
    };
    // A Clerk that kept the sessions would go on handing out this token.
    const kept = await issuer.sessionToken(names.leaver);
    const failure = await safetyProof({
      server: base,
      token: (who) => (who === "leaver" ? Promise.resolve(kept) : issuer.sessionToken(names[who])),
      usernames: { owner: "leak_a", blocked: "leak_b" },
      log: () => undefined,
    }).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toBe("Clerk still gives the deleted account a session token");
  });
});
