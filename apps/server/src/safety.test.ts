import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
  SYNC_PROTOCOL_VERSION,
  SYNC_VERSION_HEADER,
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
  readyToServe,
  receiptHash,
} from "./account-deletion.ts";
import { AccountRoutes, DeletionRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { ClerkUsers } from "./clerk-users.ts";
import { databaseLayer } from "./database.ts";
import {
  DeletionLedger,
  LEDGER_DIR,
  LEDGER_ID_FILE,
  LEFTOVER_AGE_MS,
  type LedgerOptions,
  type LedgerWrite,
  TEMPORARY_PREFIX,
} from "./deletion-ledger.ts";
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
  readonly ledger?: LedgerOptions;
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
    Layer.provideMerge(DeletionLedger.layer(ledgerDirs.get(Redacted.value(url))!, options.ledger)),
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
      // As on the server, the start finishes every deletion the ledger accepted before serving.
      Layer.provide(Layer.effectDiscard(readyToServe)),
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
      [SYNC_VERSION_HEADER]: String(SYNC_PROTOCOL_VERSION),
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
  status: "finished",
  routineId: null,
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

const nothingLeft = (rows: Record<string, number>) =>
  Object.values(rows).every((count) => count === 0);

/** A receipt the phone would send with a deletion, unique to the test. */
const receiptFor = (name: string) => `receipt_${name}_${accounts}`.padEnd(43, "0");

/** A directory sync that fails the first time, after `count` counts it. */
const failsOnce = (count: () => number) => async () => {
  if (count() === 1) throw new Error("The disk did not sync the directory.");
};

/** The receipt hashes the database's ledger holds a final file for. */
const ledgerReceipts = async (url: Redacted.Redacted) =>
  (await readdir(join(ledgerDirs.get(Redacted.value(url))!, LEDGER_DIR)))
    .filter((name) => name !== LEDGER_ID_FILE && !name.startsWith(TEMPORARY_PREFIX))
    .map((name) => name.split(".")[1]);

const sessionsEnded = async (url: Redacted.Redacted, id: string) =>
  (
    await query<{ sessions_ended: boolean }>(
      url,
      `select sessions_ended from deleted_account where id = '${id}'`,
    )
  )[0]?.sessions_ended;

/** Makes every commit that marks `id` deleted fail, as a database that fails at the commit. */
const failCommits = async (url: Redacted.Redacted, id: string) => {
  await query(
    url,
    `create or replace function fail_commit() returns trigger language plpgsql as $$
     begin raise exception 'The commit failed.'; end $$`,
  );
  await query(
    url,
    `create constraint trigger fail_commit after insert on deleted_account
     deferrable initially deferred for each row when (new.id = '${id}')
     execute function fail_commit()`,
  );
};

const commitAgain = (url: Redacted.Redacted) =>
  query(url, "drop trigger fail_commit on deleted_account");

/** Makes deleting the rows of `id` fail, as a database that fails part way through a deletion. */
const failErasing = async (url: Redacted.Redacted, id: string) => {
  await query(
    url,
    `create or replace function fail_erase() returns trigger language plpgsql as $$
     begin raise exception 'The rows could not be deleted.'; end $$`,
  );
  await query(
    url,
    `create trigger fail_erase before delete on account
     for each row when (old.id = '${id}') execute function fail_erase()`,
  );
};

const eraseAgain = (url: Redacted.Redacted) => query(url, "drop trigger fail_erase on account");

const usernames = (list: ReadonlyArray<{ readonly username: string }>) =>
  list.map(({ username }) => username);

/**
 * What Ben, Cara and Dan read of Anna and of what she did: search, her profile, her
 * activities, her post, Ben's followers and following and their counts, Ben's feed, the likes
 * and comments on Ben's post, Ben's inbox, Cara's follow requests and Dan's blocks.
 */
const readsOfAnna = async (
  api: ReturnType<typeof client>,
  who: { readonly ben: string; readonly cara: string; readonly dan: string },
  posts: { readonly annas: string; readonly bens: string },
) => {
  const { ben, cara, dan } = who;
  const profile = await api.ok(ben, "GET", "/v1/profiles/ben");
  const thread = await api.ok(ben, "GET", `/v1/posts/${posts.bens}`);
  return {
    search: usernames((await api.ok(ben, "GET", "/v1/profiles?prefix=an")).profiles),
    profile: (await api.call(ben, "GET", "/v1/profiles/anna")).status,
    activities: (await api.call(ben, "GET", "/v1/profiles/anna/activities")).status,
    activity: (await api.call(ben, "GET", `/v1/activities/${posts.annas}`)).status,
    post: (await api.call(ben, "GET", `/v1/posts/${posts.annas}`)).status,
    followers: usernames((await api.ok(ben, "GET", "/v1/profiles/ben/followers")).profiles),
    following: usernames((await api.ok(ben, "GET", "/v1/profiles/ben/following")).profiles),
    counts: [profile.followers, profile.following],
    feed: usernames((await api.ok(ben, "GET", "/v1/feed")).posts),
    likes: thread.post.likes,
    comments: [thread.post.comments, usernames(thread.comments)],
    inbox: (await api.ok(ben, "GET", "/v1/inbox")).items.map(
      (item: { kind: string; username: string }) => `${item.kind} ${item.username}`,
    ),
    requests: usernames((await api.ok(cara, "GET", "/v1/follow-requests")).requests),
    blocks: usernames((await api.ok(dan, "GET", "/v1/blocks")).blocks),
  };
};

/** Waits up to 30 seconds for `check` to hold, asking four times a second. */
const eventually = async (
  check: () => Promise<boolean>,
  deadline = Date.now() + 30_000,
): Promise<void> => {
  if (await check()) return;
  if (Date.now() > deadline) throw new Error("It never happened.");
  await new Promise((resolve) => setTimeout(resolve, 250));
  return eventually(check, deadline);
};

/** Checks the account's still-valid token reads and writes nothing, and changes no row. */
const expectRefused = async (
  api: ReturnType<typeof client>,
  held: { readonly token: string },
  url: Redacted.Redacted,
  id: string,
) => {
  const before = await rowsNaming(url, id);
  const answers = await Promise.all([
    api.call(held, "GET", "/v1/me"),
    api.call(held, "GET", "/v1/rows"),
    api.call(held, "PUT", "/v1/rows", { rows: [{ table: "activity", row: activity("New") }] }),
    api.call(held, "PUT", "/v1/profile", { username: `p${accounts}`, private: false }),
  ]);
  expect(answers.map(({ status, body }) => [status, body.error])).toEqual(
    answers.map(() => [410, "account_deleted"]),
  );
  expect(await rowsNaming(url, id)).toEqual(before);
};

/** Checks the receipt lookup and a deletion sent again both say the account is deleted. */
const expectDeleted = async (
  api: ReturnType<typeof client>,
  held: { readonly token: string },
  receipt: string,
) => {
  expect((await api.call(held, "GET", `/v1/deletions/${receipt}`)).body).toEqual({
    deleted: true,
  });
  expect((await api.call(held, "DELETE", "/v1/me", { receipt })).body).toEqual({ deleted: true });
  expect((await api.call(held, "GET", "/v1/me")).status).toBe(410);
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
    // A connected app's code, connection, logged read and waiting proposal.
    await query(
      url,
      `insert into oauth_code values ('code-hash', 'client', '${anna}', 'https://chatgpt.com/cb',
         'challenge', 'svett.read', 0);
       insert into assistant_connection (id, account_id, client_id, name, host, scopes,
         created_ms, access_hash, access_expires_ms, refresh_hash, refresh_expires_ms)
       values ('connection', '${anna}', 'client', 'ChatGPT', 'chatgpt.com', 'svett.read', 0,
         'access-hash', 0, 'refresh-hash', 0);
       insert into assistant_access values ('access', '${anna}', 'connection', 'list_workouts', 0);
       insert into assistant_proposal values ('proposal', '${anna}', 'connection', 'ChatGPT',
         '{}', 0);`,
    );

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

  it("finishes a deletion whose directory sync failed after the rename, on the next start once Clerk answers", async () => {
    const url = await freshDatabase();
    const anna = account("anna");
    const receipt = receiptFor("sync");
    let syncs = 0;
    const server = await start(url, { ledger: { syncDirectory: failsOnce(() => ++syncs) } });
    const api = client(server.base);
    await api.write(anna, [activity("Gone")]);
    const held = { token: await issuer.sessionToken(anna) };

    issuer.failBackendApi(503);
    const answer = await api.call(held, "DELETE", "/v1/me", { receipt });
    await server.stop();
    issuer.failBackendApi(undefined);

    expect(syncs).toBe(1);
    expect(answer.body.error).toBe("session_end_failed");
    expect(nothingLeft(await rowsNaming(url, anna))).toBe(true);
    expect(issuer.deletedUsers()).not.toContain(anna);
    expect(await ledgerReceipts(url)).toEqual([receiptHash(receipt)]);

    const again = await start(url);
    const restarted = client(again.base);

    expect(issuer.deletedUsers()).toContain(anna);
    expect(await sessionsEnded(url, anna)).toBe(true);
    await expectDeleted(restarted, held, receipt);
    await again.stop();
  });

  it("refuses the account at once when marking it fails after the rename, and finishes the deletion in the background", async () => {
    const url = await freshDatabase();
    const anna = account("anna");
    const receipt = receiptFor("commit");
    const server = await start(url);
    const api = client(server.base);
    await api.write(anna, [activity("Gone")]);
    const held = { token: await issuer.sessionToken(anna) };
    await failCommits(url, anna);

    const answer = await api.call(held, "DELETE", "/v1/me", { receipt });

    expect(answer.status).toBe(500);
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 1, account_row: 1 });
    expect(await query(url, "select id from deleted_account")).toEqual([]);
    expect(await ledgerReceipts(url)).toEqual([receiptHash(receipt)]);
    await expectRefused(api, held, url, anna);
    expect((await api.call(held, "GET", `/v1/deletions/${receipt}`)).body).toEqual({
      deleted: true,
    });

    await commitAgain(url);
    await eventually(async () => (await sessionsEnded(url, anna)) === true);

    expect(nothingLeft(await rowsNaming(url, anna))).toBe(true);
    expect(issuer.deletedUsers()).toContain(anna);
    await expectDeleted(api, held, receipt);
    await server.stop();
  });

  it("keeps trying Clerk for an accepted deletion, and refuses the account meanwhile", async () => {
    const url = await freshDatabase();
    const anna = account("anna");
    const receipt = receiptFor("clerk");
    const server = await start(url);
    const api = client(server.base);
    await api.write(anna, [activity("Gone")]);
    const held = { token: await issuer.sessionToken(anna) };
    await failCommits(url, anna);
    issuer.failBackendApi(503);

    try {
      expect((await api.call(held, "DELETE", "/v1/me", { receipt })).status).toBe(500);
      await commitAgain(url);
      // The background finishes the database's part, and Clerk keeps failing.
      await eventually(async () => (await sessionsEnded(url, anna)) === false);
      expect(nothingLeft(await rowsNaming(url, anna))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(await sessionsEnded(url, anna)).toBe(false);
      await expectRefused(api, held, url, anna);
      expect((await api.call(held, "GET", `/v1/deletions/${receipt}`)).body).toEqual({
        deleted: true,
      });
    } finally {
      issuer.failBackendApi(undefined);
    }
    await eventually(async () => (await sessionsEnded(url, anna)) === true);

    expect(issuer.deletedUsers()).toContain(anna);
    await expectDeleted(api, held, receipt);
    await server.stop();
  });

  it("keeps the account when the ledger's write stalls, and leaves nothing in the ledger", async () => {
    const url = await freshDatabase();
    let calls = 0;
    const stalls: LedgerWrite = (file, bytes, offset, length) =>
      ++calls === 1
        ? file.write(bytes, offset, Math.min(length, 10))
        : Promise.resolve({ bytesWritten: 0 });
    const { base } = await start(url, { ledger: { write: stalls } });
    const api = client(base);
    const anna = account("anna");
    await api.write(anna, [activity("Kept")]);

    const refused = await api.call(anna, "DELETE", "/v1/me");

    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect((await api.ok(anna, "GET", "/v1/rows")).rows).toHaveLength(1);
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 1, account_row: 1 });
    expect(await query(url, "select id from deleted_account")).toEqual([]);
    expect(issuer.deletedUsers()).not.toContain(anna);
    expect(await readdir(join(ledgerDirs.get(Redacted.value(url))!, LEDGER_DIR))).toEqual([
      LEDGER_ID_FILE,
    ]);
  });

  it("commits nothing when the server dies after the ledger's temporary write and before its rename", async () => {
    const url = await freshDatabase();
    const ledgerDir = join(ledgerDirs.get(Redacted.value(url))!, LEDGER_DIR);
    const anna = AccountId.make(account("anna"));
    let written!: () => void;
    const wrote = new Promise<void>((resolve) => (written = resolve));
    const open: Array<FileHandle> = [];
    // Stores the whole entry, then never returns, as a server that dies there.
    const dies: LedgerWrite = async (file, bytes, offset, length) => {
      await file.write(bytes, offset, length);
      open.push(file);
      written();
      return new Promise(() => {});
    };
    const server = await start(url);
    await client(server.base).write(anna, [activity("Kept")]);
    await server.stop();
    const runtime = ManagedRuntime.make(servicesOf(url, { ledger: { write: dies } }));

    const deleting = runtime.runFork(
      Effect.flatMap(Effect.service(AccountDeletion), (deletion) => deletion.remove(anna)),
    );
    await wrote;
    const [temporary] = await readdir(ledgerDir).then((names) =>
      names.filter((name) => name.startsWith(TEMPORARY_PREFIX)),
    );
    expect(await readFile(join(ledgerDir, temporary!), "utf8")).toContain(anna);
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 1, account_row: 1 });
    // The server dies: its connections drop and the transaction is gone.
    await runtime.runPromise(Fiber.interrupt(deleting));
    await runtime.dispose();
    await Promise.all(open.map((file) => file.close()));

    expect(await rowsNaming(url, anna)).toMatchObject({ account: 1, account_row: 1 });
    expect(await query(url, "select id from deleted_account")).toEqual([]);
    expect(issuer.deletedUsers()).not.toContain(anna);

    // The next start reads no entry from it, and once it is a day old removes it.
    const ledger = DeletionLedger.layer(ledgerDirs.get(Redacted.value(url))!);
    const startUp = () =>
      Effect.runPromise(
        prepareDatabase.pipe(Effect.provide(Layer.merge(databaseLayer(url), ledger))),
      );
    expect(await startUp()).toBe(0);
    expect(await readdir(ledgerDir)).toContain(temporary);
    const old = new Date(Date.now() - LEFTOVER_AGE_MS - 60_000);
    await utimes(join(ledgerDir, temporary!), old, old);
    expect(await startUp()).toBe(0);
    expect(await readdir(ledgerDir)).toEqual([LEDGER_ID_FILE]);
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 1, account_row: 1 });
  });

  it("hides the account from every read of other accounts once it is marked, while its rows wait to be deleted", async () => {
    const url = await freshDatabase();
    const server = await start(url);
    const api = client(server.base);
    const [anna, ben, cara, dan] = ["anna", "ben", "cara", "dan"].map(account) as [
      string,
      string,
      string,
      string,
    ];
    const receipt = receiptFor("marked");
    await api.name(anna, "anna");
    await api.name(ben, "ben");
    await api.name(cara, "cara", true);
    await api.name(dan, "dan");
    const annasRun = activity("Anna's run");
    const bensRun = activity("Ben's run");
    await api.write(anna, [annasRun]);
    await api.write(ben, [bensRun]);
    await api.ok(ben, "PUT", "/v1/profiles/anna/follow");
    await api.ok(anna, "PUT", "/v1/profiles/ben/follow");
    await api.ok(anna, "PUT", "/v1/profiles/cara/follow");
    await api.ok(dan, "PUT", "/v1/profiles/anna/block");
    const posts = {
      annas: await api.postId(ben, "anna", annasRun.title),
      bens: await api.postId(anna, "ben", bensRun.title),
    };
    await api.ok(anna, "PUT", `/v1/posts/${posts.bens}/like`);
    await api.ok(anna, "POST", `/v1/posts/${posts.bens}/comments`, { body: "Nice" });
    const held = { token: await issuer.sessionToken(anna) };
    const who = { ben, cara, dan };

    expect(await readsOfAnna(api, who, posts)).toEqual({
      search: ["anna"],
      profile: 200,
      activities: 200,
      activity: 200,
      post: 200,
      followers: ["anna"],
      following: ["anna"],
      counts: [1, 1],
      feed: ["ben", "anna"],
      likes: 1,
      comments: [1, ["anna"]],
      inbox: ["comment anna", "like anna", "follow anna"],
      requests: ["anna"],
      blocks: ["anna"],
    });

    await failErasing(url, anna);
    expect((await api.call(held, "DELETE", "/v1/me", { receipt })).status).toBe(500);

    expect(await query(url, "select id, rows_deleted from deleted_account")).toEqual([
      { id: anna, rows_deleted: false },
    ]);
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 1, profile: 1, account_row: 1 });
    expect(await readsOfAnna(api, who, posts)).toEqual({
      search: [],
      profile: 404,
      activities: 404,
      activity: 404,
      post: 404,
      followers: [],
      following: [],
      counts: [0, 0],
      feed: ["ben"],
      likes: 0,
      comments: [0, []],
      inbox: [],
      requests: [],
      blocks: [],
    });
    expect((await api.call(ben, "PUT", "/v1/profiles/anna/follow")).body).toEqual({
      error: "not_found",
    });
    expect((await api.call(ben, "PUT", `/v1/posts/${posts.annas}/like`)).body).toEqual({
      error: "post_not_found",
    });
    await expectRefused(api, held, url, anna);

    await eraseAgain(url);
    await eventually(async () => (await sessionsEnded(url, anna)) === true);

    expect(nothingLeft(await rowsNaming(url, anna))).toBe(true);
    expect(issuer.deletedUsers()).toContain(anna);
    await expectDeleted(api, held, receipt);
    await server.stop();
  });

  it("lets another server on the same database refuse, answer for and finish a deletion whose server died before marking it", async () => {
    const url = await freshDatabase();
    const anna = AccountId.make(account("anna"));
    const receipt = receiptFor("peer");
    const other = await start(url);
    const api = client(other.base);
    await api.write(anna, [activity("Gone")]);
    const held = { token: await issuer.sessionToken(anna) };
    expect((await api.call(held, "GET", "/v1/me")).status).toBe(200);
    expect((await api.call(held, "GET", `/v1/deletions/${receipt}`)).body).toEqual({
      deleted: false,
    });

    // The first server renames the entry into place, then hangs in the directory's sync until
    // it dies, so it never marks the account in the database.
    const dying = ManagedRuntime.make(
      servicesOf(url, { ledger: { syncDirectory: () => new Promise(() => {}) } }),
    );
    const deleting = dying.runFork(
      Effect.flatMap(Effect.service(AccountDeletion), (deletion) => deletion.remove(anna, receipt)),
    );
    await eventually(async () => (await ledgerReceipts(url)).includes(receiptHash(receipt)));
    await dying.runPromise(Fiber.interrupt(deleting));
    await dying.dispose();
    expect(await query(url, "select id from deleted_account")).toEqual([]);
    expect(await rowsNaming(url, anna)).toMatchObject({ account: 1, account_row: 1 });

    expect((await api.call(held, "GET", `/v1/deletions/${receipt}`)).body).toEqual({
      deleted: true,
    });
    await expectRefused(api, held, url, anna);
    await eventually(async () => (await sessionsEnded(url, anna)) === true);

    expect(nothingLeft(await rowsNaming(url, anna))).toBe(true);
    expect(issuer.deletedUsers()).toContain(anna);
    expect(
      await query(
        url,
        `select 1 from deletion_receipt where receipt_hash = '${receiptHash(receipt)}'`,
      ),
    ).toHaveLength(1);
    await expectDeleted(api, held, receipt);
    await other.stop();
  });

  it("refuses a receipt that is not well formed before it reads the ledger or the database", async () => {
    const url = await freshDatabase();
    const { base } = await start(url);
    const api = client(base);
    const anyone = account("anyone");
    // A file where the ledger's directory was makes every read of the ledger fail from here.
    const ledger = join(ledgerDirs.get(Redacted.value(url))!, LEDGER_DIR);
    await rm(ledger, { recursive: true });
    await writeFile(ledger, "not a directory");
    const statusOf = async (receipt: string) =>
      (await api.call(anyone, "GET", `/v1/deletions/${receipt}`)).status;
    expect(
      await Promise.all(
        ["short", "a".repeat(42), `${"a".repeat(42)}.`, "a!".repeat(30)].map(statusOf),
      ),
    ).toEqual([400, 400, 400, 400]);
    // The router refuses a path parameter over 100 characters before any route runs.
    expect(await statusOf("a".repeat(101))).toBe(404);
    // A well-formed receipt reads the ledger, which fails now, so the ones above never did.
    expect(await statusOf("a".repeat(100))).toBe(500);
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

/** Waits until the deletion holds the account's lock and waits to mark the account. */
const untilDeletionWaits = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const [waiting] = yield* sql<{ readonly n: number }>`
    select count(*)::int as n from pg_stat_activity
    where wait_event_type = 'Lock' and query like '%insert into deleted_account%'
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
              // A transaction that keeps every insert out of deleted_account holds the deletion
              // open with the account's lock taken, before the database marks the account and
              // while every read still shows it.
              const locked = yield* Deferred.make<void>();
              const unlock = yield* Deferred.make<void>();
              const holder = yield* Effect.forkChild(
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`lock table deleted_account in exclusive mode`;
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

/** A write between a follower and the account it follows, ready to race a block of the two. */
interface PairWrite {
  readonly name: string;
  /** Whether the followed account is private. */
  readonly private: boolean;
  /** Whether the follower has asked to follow already. */
  readonly requested: boolean;
  /** What the write answers when the block committed first. */
  readonly refused: string;
  readonly actor: "follower" | "followed";
  readonly run: (
    follower: AccountId,
    followed: AccountId,
    request: string,
  ) => Effect.Effect<unknown, unknown, SocialRows>;
}

const PAIR_WRITES: ReadonlyArray<PairWrite> = [
  {
    name: "follow",
    private: false,
    requested: false,
    refused: "NotFound",
    actor: "follower",
    run: (follower) =>
      Effect.flatMap(Effect.service(SocialRows), (rows) => rows.follow(follower, "followed")),
  },
  {
    name: "follow request",
    private: true,
    requested: false,
    refused: "NotFound",
    actor: "follower",
    run: (follower) =>
      Effect.flatMap(Effect.service(SocialRows), (rows) => rows.follow(follower, "followed")),
  },
  {
    name: "approval",
    private: true,
    requested: true,
    refused: "RequestNotFound",
    actor: "followed",
    run: (_, followed, request) =>
      Effect.flatMap(Effect.service(SocialRows), (rows) => rows.approve(followed, request)),
  },
];

/** A follower and the account it follows or asks to follow, as `write` needs them. */
const followPair = async (write: PairWrite) => {
  const url = await freshDatabase();
  const { base } = await start(url);
  const api = client(base);
  const [follower, followed] = [account("follower"), account("followed")];
  await api.name(follower, "follower");
  await api.name(followed, "followed", write.private);
  let request = "";
  if (write.requested) {
    await api.ok(follower, "PUT", "/v1/profiles/followed/follow");
    request = (await api.ok(followed, "GET", "/v1/follow-requests")).requests[0].id;
  }
  return {
    url,
    follower: AccountId.make(follower),
    followed: AccountId.make(followed),
    request,
  };
};

/** Every follow or request between the two accounts, either way. */
const followsBetween = (url: Redacted.Redacted, a: string, b: string) =>
  query(
    url,
    `select follower_id, state from follow
     where (follower_id = '${a}' and followee_id = '${b}')
       or (follower_id = '${b}' and followee_id = '${a}')`,
  );

/**
 * Runs `first` as its actor and holds its transaction open once it ran, starts `second` as
 * its actor, and lets `first` commit 300 ms later. Gives back whether `second` was still
 * waiting then, and how each ended.
 */
const race = (
  url: Redacted.Redacted,
  first: {
    readonly actor: AccountId;
    readonly run: Effect.Effect<unknown, unknown, SocialRows>;
  },
  second: {
    readonly actor: AccountId;
    readonly run: Effect.Effect<unknown, unknown, SocialRows>;
  },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const safety = yield* Safety;
      const ran = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const firstFiber = yield* Effect.forkChild(
        Effect.exit(
          safety.asAccount(
            first.actor,
            undefined,
            Effect.gen(function* () {
              yield* first.run;
              yield* Deferred.succeed(ran, undefined);
              yield* Deferred.await(release);
            }).pipe(Effect.onError(() => Deferred.succeed(ran, undefined))),
          ),
        ),
      );
      yield* Deferred.await(ran);
      const secondFiber = yield* Effect.forkChild(
        Effect.exit(safety.asAccount(second.actor, undefined, second.run)),
      );
      yield* Effect.sleep("300 millis");
      const waited = secondFiber.pollUnsafe() === undefined;
      yield* Deferred.succeed(release, undefined);
      return {
        waited,
        first: outcomeOf(yield* Fiber.join(firstFiber)),
        second: outcomeOf(yield* Fiber.join(secondFiber)),
      };
    }).pipe(Effect.provide(servicesOf(url))),
  );

describe("a block racing a follow, a follow request or an approval", { timeout: 60_000 }, () => {
  describe.each(PAIR_WRITES)("$name", (write) => {
    describe.each(["follower", "followed"] as const)("blocked by the %s", (blocker) => {
      const sides = (pair: Awaited<ReturnType<typeof followPair>>) => {
        const [by, other] =
          blocker === "follower" ? [pair.follower, "followed"] : [pair.followed, "follower"];
        return {
          block: {
            actor: by,
            run: Effect.flatMap(Effect.service(SocialRows), (rows) => rows.block(by, other)),
          },
          write: {
            actor: write.actor === "follower" ? pair.follower : pair.followed,
            run: write.run(pair.follower, pair.followed, pair.request),
          },
        };
      };

      it("commits first, and the block waits for it and then removes it", async () => {
        const pair = await followPair(write);
        const { block, write: written } = sides(pair);
        expect(await race(pair.url, written, block)).toEqual({
          waited: true,
          first: "written",
          second: "written",
        });
        expect(await followsBetween(pair.url, pair.follower, pair.followed)).toEqual([]);
      });

      it("waits for a block that started first, then is refused and leaves nothing", async () => {
        const pair = await followPair(write);
        const { block, write: written } = sides(pair);
        expect(await race(pair.url, block, written)).toEqual({
          waited: true,
          first: "written",
          second: write.refused,
        });
        expect(await followsBetween(pair.url, pair.follower, pair.followed)).toEqual([]);
      });
    });
  });
});

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
