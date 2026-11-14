import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  SocialActivityId,
  SyncFailed,
  syncOnce,
  SyncRepository,
  TransferRepository,
} from "@svett/core";
import { legDay, openTestDatabase, syncedRows } from "@svett/core/node";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  Schedule,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  ACCOUNT_TABLES,
  AccountDeletion,
  KEPT_TABLES,
  prepareDatabase,
} from "./account-deletion.ts";
import { AccountRoutes, DeletionRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { ClerkUsers } from "./clerk-users.ts";
import { databaseLayer } from "./database.ts";
import { DeletionLedger } from "./deletion-ledger.ts";
import { FeedRoutes } from "./feed-routes.ts";
import { FeedRows } from "./feed-rows.ts";
import { Safety } from "./safety.ts";
import { safetyProof } from "./safety-proof.ts";
import { SocialRoutes } from "./social-routes.ts";
import { SocialRows } from "./social-rows.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { query, rowsNaming, startTestPostgres, type TestPostgres } from "./test-postgres.ts";

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

/** The deletion ledger of each database, by its address. */
const ledgerDirs = new Map<string, string>();

/** A new database, readied the way the server readies it on start, with a ledger of its own. */
const freshDatabase = async () => {
  const url = await postgres.createDatabase(`safety_${++databases}`);
  const dir = mkdtempSync(join(tmpdir(), "svett-ledger-"));
  ledgerDirs.set(Redacted.value(url), dir);
  await Effect.runPromise(
    prepareDatabase.pipe(
      Effect.provide(Layer.merge(databaseLayer(url), DeletionLedger.layer(dir))),
    ),
  );
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
      options.secretKey === null ? undefined : Redacted.make(options.secretKey ?? issuer.secretKey),
  });
  return Layer.mergeAll(
    AccountRows.layer,
    SocialRows.layer,
    FeedRows.layer,
    Sessions.layer,
    AccountDeletion.layer,
  ).pipe(
    Layer.provideMerge(Safety.layer(options.limits)),
    Layer.provideMerge(DeletionLedger.layer(ledgerDirs.get(Redacted.value(url))!)),
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
  const call = (
    who: string | { readonly token: string },
    method: string,
    path: string,
    body?: unknown,
  ) => send(base, who, method, path, body);
  const ok = async (who: string, method: string, path: string, body?: unknown) => {
    const answer = await call(who, method, path, body);
    if (answer.status !== 200) {
      throw new Error(
        `${method} ${path} answered ${answer.status}: ${JSON.stringify(answer.body)}`,
      );
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
    expect(
      (await api.ok(ben, "GET", "/v1/feed")).posts.map((each: any) => each.username),
    ).toContain("anna");

    await api.ok(anna, "PUT", "/v1/profiles/ben/block");

    // Ben, the blocked account.
    expect((await api.call(ben, "GET", "/v1/profiles/anna")).status).toBe(404);
    expect((await api.ok(ben, "GET", "/v1/profiles?prefix=an")).profiles).toEqual([]);
    expect(
      (await api.ok(ben, "GET", "/v1/profiles/cara/followers")).profiles.map(
        (each: any) => each.username,
      ),
    ).toEqual([]);
    expect((await api.ok(ben, "GET", "/v1/feed")).posts.map((each: any) => each.username)).toEqual([
      "ben",
    ]);
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
    expect(
      (await api.ok(ben, "GET", "/v1/blocks")).blocks.map((each: any) => each.username),
    ).toEqual(["anna"]);
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

/** The likes and comments `viewer` sees on a post, in its thread and on its feed card. */
const seenCounts = async (api: ReturnType<typeof client>, viewer: string, post: string) => {
  const thread = await api.ok(viewer, "GET", `/v1/posts/${post}`);
  const card = (await api.ok(viewer, "GET", "/v1/feed")).posts.find(
    (each: any) => each.activity.id === post,
  );
  return {
    likes: thread.post.likes,
    comments: thread.post.comments,
    shownComments: thread.comments.length,
    card: card === undefined ? undefined : { likes: card.likes, comments: card.comments },
  };
};

describe("counts", { timeout: 60_000 }, () => {
  it("never move for a viewer when an account in a block with them likes or comments", async () => {
    const { base } = await start(await freshDatabase());
    const api = client(base);
    const [anna, ben, cara] = [account("anna"), account("ben"), account("cara")];
    await api.name(anna, "anna");
    await api.name(ben, "ben");
    await api.name(cara, "cara");
    const run = activity("Anna's run");
    await api.write(anna, [run]);
    await api.ok(cara, "PUT", "/v1/profiles/anna/follow");
    await api.ok(ben, "PUT", "/v1/profiles/anna/follow");
    const post = await api.postId(cara, "anna", run.title);
    await api.ok(anna, "PUT", `/v1/posts/${post}/like`);
    await api.ok(anna, "POST", `/v1/posts/${post}/comments`, { body: "Mine" });
    await api.ok(cara, "PUT", "/v1/profiles/ben/block");
    const before = await seenCounts(api, cara, post);
    expect(before).toEqual({
      likes: 1,
      comments: 1,
      shownComments: 1,
      card: { likes: 1, comments: 1 },
    });

    await api.ok(ben, "PUT", `/v1/posts/${post}/like`);
    await api.ok(ben, "POST", `/v1/posts/${post}/comments`, { body: "Hidden" });

    expect(await seenCounts(api, cara, post)).toEqual(before);
    // The block works both ways, so Ben's counts leave out what Cara does.
    const bensBefore = await seenCounts(api, ben, post);
    await api.ok(cara, "PUT", `/v1/posts/${post}/like`);
    await api.ok(cara, "POST", `/v1/posts/${post}/comments`, { body: "Not for Ben" });
    expect(await seenCounts(api, ben, post)).toEqual(bensBefore);
    // Anna is in no block, and sees every like and comment.
    expect(await seenCounts(api, anna, post)).toMatchObject({ likes: 3, comments: 3 });
    expect((await api.ok(ben, "DELETE", `/v1/posts/${post}/like`)).likes).toBe(1);
  });

  it("show each viewer as many followers and followings as the lists they can open", async () => {
    const { base } = await start(await freshDatabase());
    const api = client(base);
    const names = ["anna", "ben", "cara", "dan", "eve"] as const;
    const who = Object.fromEntries(names.map((name) => [name, account(name)])) as Record<
      (typeof names)[number],
      string
    >;
    await Promise.all(names.map((name) => api.name(who[name], name)));
    await Promise.all([
      ...(["anna", "ben", "cara"] as const).map((follower) =>
        api.ok(who[follower], "PUT", "/v1/profiles/dan/follow"),
      ),
      ...(["ben", "cara", "eve"] as const).map((followee) =>
        api.ok(who.dan, "PUT", `/v1/profiles/${followee}/follow`),
      ),
    ]);
    await api.ok(who.cara, "PUT", "/v1/profiles/eve/block");
    await api.ok(who.ben, "PUT", "/v1/profiles/cara/block");

    const seen = async (viewer: (typeof names)[number]) => {
      const profile = await api.ok(who[viewer], "GET", "/v1/profiles/dan");
      const followers = await api.ok(who[viewer], "GET", "/v1/profiles/dan/followers");
      const following = await api.ok(who[viewer], "GET", "/v1/profiles/dan/following");
      return {
        followers: [profile.followers, followers.profiles.length],
        following: [profile.following, following.profiles.length],
      };
    };
    // Each pair is the count beside the length of the list it counts.
    expect(await seen("anna")).toEqual({ followers: [3, 3], following: [3, 3] });
    expect(await seen("ben")).toEqual({ followers: [2, 2], following: [2, 2] });
    expect(await seen("cara")).toEqual({ followers: [2, 2], following: [1, 1] });
    expect(await seen("eve")).toEqual({ followers: [2, 2], following: [2, 2] });
    expect(await seen("dan")).toEqual({ followers: [3, 3], following: [3, 3] });
    expect(await api.ok(who.dan, "GET", "/v1/profile")).toMatchObject({
      followers: 3,
      following: 3,
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
    expect(
      (await api.call(ben, "POST", `/v1/posts/${post}/comments`, { body: "Nice" })).status,
    ).toBe(200);
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
    expect(file.tables.activity?.map((row) => row.id).toSorted()).toEqual(
      [kept, dropped].toSorted(),
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
      [...Object.keys(ACCOUNT_TABLES), ...Object.keys(KEPT_TABLES)].toSorted(),
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
    await Promise.all(
      (
        [
          [anna, "anna"],
          [ben, "ben"],
          [cara, "cara"],
          [dan, "dan"],
          [eve, "eve"],
        ] as const
      ).map(([who, username]) => api.name(who, username)),
    );
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
    expect(
      Object.values(after).every((count) => count === 0),
      JSON.stringify(after),
    ).toBe(true);
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
    const paths = [
      ["GET", "/v1/me"],
      ["GET", "/v1/feed"],
      ["GET", "/v1/export"],
      ["PUT", "/v1/profile"],
    ] as const;
    const answers = await Promise.all(
      paths.map(async ([method, path]) => {
        const body = method === "PUT" ? { username: "anna", private: false } : undefined;
        const answer = await api.call(held, method, path, body);
        return { path, status: answer.status, error: answer.body.error };
      }),
    );
    expect(answers).toEqual(
      paths.map(([, path]) => ({ path, status: 410, error: "account_deleted" })),
    );
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

  it("refuses a deletion that names another account than the session's, and deletes nothing", async () => {
    const url = await freshDatabase();
    const { base } = await start(url);
    const api = client(base);
    const anna = account("anna");
    const ben = account("ben");
    await api.write(ben, [activity("Kept")]);

    const refused = await api.call(ben, "DELETE", "/v1/me", { account: anna });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("wrong_account");
    expect((await api.ok(ben, "GET", "/v1/rows")).rows).toHaveLength(1);
    expect(issuer.deletedUsers()).not.toContain(ben);
    expect(await api.ok(ben, "DELETE", "/v1/me", { account: ben })).toEqual({ deleted: true });
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

/** A write of `writer` that names `other`, ready to race `other`'s deletion. */
interface NamingWrite {
  readonly name: string;
  readonly group: RateLimitGroup;
  /** What the write answers when `other` is gone first. */
  readonly refused: string;
  readonly run: (
    writer: AccountId,
    post: SocialActivityId,
  ) => Effect.Effect<unknown, unknown, SocialRows | FeedRows>;
}

const NAMING_WRITES: ReadonlyArray<NamingWrite> = [
  {
    name: "block",
    group: "follows",
    refused: "NotFound",
    run: (writer) =>
      Effect.flatMap(Effect.service(SocialRows), (rows) => rows.block(writer, "other")),
  },
  {
    name: "follow",
    group: "follows",
    refused: "NotFound",
    run: (writer) =>
      Effect.flatMap(Effect.service(SocialRows), (rows) => rows.follow(writer, "other")),
  },
  {
    name: "like",
    group: "likes",
    refused: "PostNotFound",
    run: (writer, post) =>
      Effect.flatMap(Effect.service(FeedRows), (feed) => feed.like(writer, post)),
  },
  {
    name: "comment",
    group: "comments",
    refused: "PostNotFound",
    run: (writer, post) =>
      Effect.flatMap(Effect.service(FeedRows), (feed) => feed.comment(writer, post, "Strong")),
  },
];

/**
 * A writer and the account `other` its write names, each with a profile, and a post of
 * `other` the writer sees. `otherFirst` gives `other` the lower account ID, which the writer
 * must lock out of order.
 */
const namingPair = async (otherFirst: boolean) => {
  const url = await freshDatabase();
  const { base } = await start(url);
  const api = client(base);
  const n = ++accounts;
  const [low, high] = [`user_a${n}`, `user_z${n}`];
  const [writer, other] = otherFirst ? [high, low] : [low, high];
  await api.name(writer, "writer");
  await api.name(other, "other");
  const run = activity("Other's run");
  await api.write(other, [run]);
  const post = SocialActivityId.make(await api.postId(writer, "other", run.title));
  return { url, writer: AccountId.make(writer), other: AccountId.make(other), post };
};

/** "written", or the name of the error the write failed with. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? "written"
    : String(
        (Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as object | undefined)
          ?.constructor.name,
      );

/** Waits until the deletion holds the account's lock and waits for the held table. */
const untilDeletionWaits = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const [waiting] = yield* sql<{ readonly n: number }>`
    select count(*)::int as n from pg_stat_activity
    where wait_event_type = 'Lock' and query like '%"inbox_read"%'
  `;
  if ((waiting?.n ?? 0) === 0) return yield* Effect.fail("not yet");
}).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 1000 }));

describe(
  "a write that names an account racing that account's deletion",
  { timeout: 60_000 },
  () => {
    describe.each(NAMING_WRITES)("$name", (write) => {
      it.each([false, true])(
        "commits first and the deletion then deletes what it wrote, other account first: %s",
        async (otherFirst) => {
          const { url, writer, other, post } = await namingPair(otherFirst);
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const safety = yield* Safety;
              const deletion = yield* AccountDeletion;
              const wrote = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const request = yield* Effect.forkChild(
                safety.asAccount(
                  writer,
                  write.group,
                  Effect.gen(function* () {
                    yield* write.run(writer, post);
                    yield* Deferred.succeed(wrote, undefined);
                    yield* Deferred.await(release);
                  }).pipe(Effect.onError(() => Deferred.succeed(wrote, undefined))),
                ),
              );
              yield* Deferred.await(wrote);
              const deleting = yield* Effect.forkChild(deletion.remove(other));
              yield* Effect.sleep("300 millis");
              const waited = deleting.pollUnsafe() === undefined;
              yield* Deferred.succeed(release, undefined);
              const written = outcomeOf(yield* Effect.exit(Fiber.join(request)));
              yield* Fiber.join(deleting);
              return { waited, written };
            }).pipe(Effect.provide(servicesOf(url))),
          );
          expect(result).toEqual({ waited: true, written: "written" });
          expect(Object.values(await rowsNaming(url, other)).every((count) => count === 0)).toBe(
            true,
          );
        },
      );

      it.each([false, true])(
        "is refused when the deletion started first, and leaves nothing, other account first: %s",
        async (otherFirst) => {
          const { url, writer, other, post } = await namingPair(otherFirst);
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              const safety = yield* Safety;
              const deletion = yield* AccountDeletion;
              // A transaction on a table the deletion reaches late holds the deletion open,
              // with the account's lock taken.
              const locked = yield* Deferred.make<void>();
              const unlock = yield* Deferred.make<void>();
              const holder = yield* Effect.forkChild(
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`lock table inbox_read in access exclusive mode`;
                    yield* Deferred.succeed(locked, undefined);
                    yield* Deferred.await(unlock);
                  }),
                ),
              );
              yield* Deferred.await(locked);
              const deleting = yield* Effect.forkChild(deletion.remove(other));
              yield* untilDeletionWaits;
              const request = yield* Effect.forkChild(
                Effect.exit(safety.asAccount(writer, write.group, write.run(writer, post))),
              );
              yield* Effect.sleep("300 millis");
              // In order, the write waits for the deletion. Out of order it never waits.
              const waited = request.pollUnsafe() === undefined;
              yield* Deferred.succeed(unlock, undefined);
              yield* Fiber.join(holder);
              yield* Fiber.join(deleting);
              return { waited, written: outcomeOf(yield* Fiber.join(request)) };
            }).pipe(Effect.provide(servicesOf(url))),
          );
          expect(result).toEqual({ waited: !otherFirst, written: write.refused });
          expect(Object.values(await rowsNaming(url, other)).every((count) => count === 0)).toBe(
            true,
          );
        },
      );
    });

    it("lets two accounts block each other at once, many times over", async () => {
      const { base } = await start(await freshDatabase());
      const api = client(base);
      const [anna, ben] = [account("anna"), account("ben")];
      await api.name(anna, "anna");
      await api.name(ben, "ben");
      const rounds = async (left: number): Promise<void> => {
        await Promise.all([
          api.ok(anna, "PUT", "/v1/profiles/ben/follow"),
          api.ok(ben, "PUT", "/v1/profiles/anna/follow"),
        ]);
        const answers = await Promise.all([
          api.call(anna, "PUT", "/v1/profiles/ben/block"),
          api.call(ben, "PUT", "/v1/profiles/anna/block"),
        ]);
        expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
        const blocks = await Promise.all([
          api.ok(anna, "GET", "/v1/blocks"),
          api.ok(ben, "GET", "/v1/blocks"),
        ]);
        await Promise.all([
          api.ok(anna, "DELETE", `/v1/blocks/${blocks[0].blocks[0].id}`),
          api.ok(ben, "DELETE", `/v1/blocks/${blocks[1].blocks[0].id}`),
        ]);
        if (left > 1) return rounds(left - 1);
      };
      await rounds(10);
    });
  },
);

describe("the safety proof script", { timeout: 60_000 }, () => {
  it("passes against a running server with the stand-in issuer, twice", async () => {
    const { base } = await start(await freshDatabase());
    const owner = account("proof_owner");
    const blocked = account("proof_blocked");
    const lines: Array<string> = [];
    const proof = (run: number) => {
      const names = { owner, blocked, leaver: account(`proof_leaver_${run}`) };
      return safetyProof({
        server: base,
        token: (who) => issuer.sessionToken(names[who]),
        usernames: { owner: "safety_a", blocked: "safety_b" },
        log: (line) => lines.push(line),
      });
    };
    await proof(1);
    // A second run starts from where the first one left both accounts.
    await proof(2);
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
