import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { type AccountId, importedId, TABLES, Username } from "@svett/core";
import { Data, Deferred, Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AccountRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { databaseLayer, migrate } from "./database.ts";
import { socialProof } from "./social-proof.ts";
import { SocialRoutes } from "./social-routes.ts";
import { PAGE, SocialRows, type SocialRowsShape } from "./social-rows.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { startTestPostgres, type TestPostgres } from "./test-postgres.ts";
import { Safety } from "./safety.ts";

let postgres: TestPostgres;
let issuer: StandInIssuer;
let databases = 0;

beforeAll(async () => {
  [postgres, issuer] = await Promise.all([startTestPostgres(), startStandInIssuer()]);
}, 120_000);

afterAll(async () => {
  await Promise.all([postgres?.stop(), issuer?.stop()]);
});

const ANNA = "user_anna";
const BEN = "user_ben";
const CARA = "user_cara";

/** The account and social routes on a fresh, migrated database, still needing a server. */
const routes = async () => {
  const url = await postgres.createDatabase(`social_${++databases}`);
  await Effect.runPromise(migrate.pipe(Effect.provide(databaseLayer(url))));
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
    SocialRows.layer,
    Sessions.layer,
    Safety.layer(),
  ).pipe(Layer.provide(databaseLayer(url)), Layer.provide(clerk));
  return HttpRouter.serve(Layer.mergeAll(AccountRoutes, SocialRoutes), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(Layer.provide(services));
};

/** Runs `steps` against the routes through an in-process client. */
const withServer = async <A>(steps: Effect.Effect<A, unknown, HttpClient.HttpClient>) => {
  const server = (await routes()).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
  return Effect.runPromise(steps.pipe(Effect.provide(server)));
};

/** The routes on a real local port, as the proof script reaches a deployed server. */
const listening = async () =>
  (await routes()).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
  );

/** Sends a request as `account`, and gives back the answer's status and JSON body. */
const as = (account: string, method: "GET" | "PUT" | "DELETE", path: string, body?: unknown) =>
  Effect.gen(function* () {
    const token = yield* Effect.promise(() => issuer.sessionToken(account));
    const request = HttpClientRequest.make(method)(path).pipe(
      HttpClientRequest.bearerToken(token),
      (built) => (body === undefined ? built : HttpClientRequest.bodyJsonUnsafe(built, body)),
    );
    const response = yield* (yield* HttpClient.HttpClient).execute(request);
    return { status: response.status, body: yield* response.json };
  });

const body = <A = unknown>(
  answer: Effect.Effect<
    { readonly status: number; readonly body: unknown },
    unknown,
    HttpClient.HttpClient
  >,
) =>
  Effect.map(answer, (result) => {
    expect(result.status).toBe(200);
    return result.body as A;
  });

const name = (account: string, username: string, isPrivate = true) =>
  body(as(account, "PUT", "/v1/profile", { username, private: isPrivate }));

type Requests = {
  readonly requests: ReadonlyArray<{ readonly id: string; readonly username: string }>;
};

/** The ID of the request `owner` sees from `username`, as the requests screen holds it. */
const requestFrom = (owner: string, username: string) =>
  Effect.map(body<Requests>(as(owner, "GET", "/v1/follow-requests")), ({ requests }) => {
    const request = requests.find((each) => each.username === username);
    if (request === undefined) throw new Error(`No request from ${username}`);
    return request.id;
  });

let ids = 0;
const activity = (
  audience: string,
  hiddenFields: ReadonlyArray<string> = [],
  overrides: Record<string, unknown> = {},
) => ({
  id: `0190a0b2-0000-7000-8000-${String(++ids).padStart(12, "0")}`,
  updatedAt: 1,
  deletedAt: null,
  kind: "run",
  startedAt: 1_790_000_000_000 + ids,
  durationS: 1800,
  title: `${audience} run ${ids}`,
  notes: "",
  energyKcal: 410,
  audience,
  hiddenFields: JSON.stringify(hiddenFields),
  source: "svett",
  sourceId: null,
  fingerprint: null,
  importBatchId: null,
  ...overrides,
});

const write = (account: string, rows: ReadonlyArray<Record<string, unknown>>) =>
  body(as(account, "PUT", "/v1/rows", { rows: rows.map((row) => ({ table: "activity", row })) }));

type Seen = { readonly activities: ReadonlyArray<{ readonly title: string }> };
const titles = (viewer: string, username: string) =>
  Effect.map(body<Seen>(as(viewer, "GET", `/v1/profiles/${username}`)), (profile) =>
    profile.activities.map(({ title }) => title),
  );

type Shown = {
  readonly id: string;
  readonly title: string;
  readonly startedAt: number | null;
  readonly durationS: number | null;
};

/** A cursor naming the activity with social ID `id`, as the server makes one. */
const cursorFor = (id: string) => Buffer.from(JSON.stringify({ id })).toString("base64url");

/** An account's own profile, as a newly named account reads it. */
const own = (username: string | null, isPrivate: boolean) => ({
  status: 200,
  body: { username, private: isPrivate, followers: 0, following: 0, requests: 0 },
});

describe("usernames", { timeout: 60_000 }, () => {
  it("gives each account one username, unique whatever its case", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        const before = yield* as(ANNA, "GET", "/v1/profile");
        const named = yield* as(ANNA, "PUT", "/v1/profile", { username: "Anna.K", private: true });
        const taken = yield* as(BEN, "PUT", "/v1/profile", { username: "anna.k", private: false });
        const renamed = yield* as(ANNA, "PUT", "/v1/profile", {
          username: "anna_k",
          private: false,
        });
        const freed = yield* as(BEN, "PUT", "/v1/profile", { username: "ANNA.K", private: true });
        return { before, named, taken, renamed, freed };
      }),
    );
    expect(answers).toEqual({
      before: own(null, true),
      named: own("Anna.K", true),
      taken: { status: 409, body: { error: "username_taken" } },
      renamed: own("anna_k", false),
      freed: own("ANNA.K", true),
    });
  });

  it.each([
    ["ab", "A username has at least 3 characters."],
    ["anna k", "Use only letters, digits, periods and underscores."],
    ["svett", "That username is reserved."],
  ])("refuses %j and says why", async (username, message) => {
    const answer = await withServer(as(ANNA, "PUT", "/v1/profile", { username, private: true }));
    expect(answer).toEqual({ status: 400, body: { error: "invalid_username", message } });
  });

  it("finds profiles by the start of their username, whatever its case", async () => {
    const found = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "Anna.K", false);
        yield* name(BEN, "annabel");
        yield* name(CARA, "a_nna");
        yield* body(as(CARA, "PUT", "/v1/profiles/Anna.K/follow"));
        const search = (prefix: string) =>
          Effect.map(
            body<{ readonly profiles: ReadonlyArray<unknown> }>(
              as(CARA, "GET", `/v1/profiles?prefix=${encodeURIComponent(prefix)}`),
            ),
            ({ profiles }) => profiles,
          );
        return {
          ann: yield* search("ANN"),
          underscore: yield* search("a_"),
          nobody: yield* search("zz"),
          invalid: yield* search("a%"),
        };
      }),
    );
    expect(found).toEqual({
      ann: [
        { username: "Anna.K", private: false, follow: "following" },
        { username: "annabel", private: true, follow: "none" },
      ],
      // The underscore is a character here, not LIKE's any-one-character.
      underscore: [{ username: "a_nna", private: true, follow: "none" }],
      nobody: [],
      invalid: [],
    });
  });
});

describe("follows", { timeout: 60_000 }, () => {
  it("follows a public profile at once and asks a private one for approval", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna", false);
        yield* name(BEN, "ben", true);
        yield* name(CARA, "cara");
        const publicFollow = yield* body(as(CARA, "PUT", "/v1/profiles/anna/follow"));
        const privateFollow = yield* body(as(CARA, "PUT", "/v1/profiles/ben/follow"));
        const again = yield* body(as(CARA, "PUT", "/v1/profiles/ben/follow"));
        const requests = yield* body(as(BEN, "GET", "/v1/follow-requests"));
        const benBefore = yield* body(as(CARA, "GET", "/v1/profiles/ben"));
        yield* body(as(BEN, "PUT", `/v1/follow-requests/${yield* requestFrom(BEN, "cara")}`));
        const benAfter = yield* body(as(CARA, "GET", "/v1/profiles/ben"));
        const followers = yield* body(as(ANNA, "GET", "/v1/profiles/ben/followers"));
        const following = yield* body(as(ANNA, "GET", "/v1/profiles/cara/following"));
        const benOwn = yield* body(as(BEN, "GET", "/v1/profile"));
        return {
          publicFollow,
          privateFollow,
          again,
          requests,
          benBefore,
          benAfter,
          followers,
          following,
          benOwn,
        };
      }),
    );
    expect(result).toMatchObject({
      publicFollow: { follow: "following" },
      privateFollow: { follow: "requested" },
      again: { follow: "requested" },
      requests: {
        requests: [{ id: expect.any(String), username: "cara", private: true, follow: "none" }],
      },
      benBefore: { followers: 0, follow: "requested" },
      benAfter: { followers: 1, follow: "following", self: false, followsYou: false },
      followers: { profiles: [{ username: "cara", private: true, follow: "none" }], next: null },
      following: {
        profiles: [
          { username: "anna", private: false, follow: "none" },
          { username: "ben", private: true, follow: "none" },
        ],
      },
      benOwn: { username: "ben", followers: 1, following: 0, requests: 0 },
    });
  });

  it("declines a request, takes one back, and unfollows", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        yield* body(as(CARA, "PUT", "/v1/profiles/anna/follow"));
        const ben = `/v1/follow-requests/${yield* requestFrom(ANNA, "ben")}`;
        yield* body(as(ANNA, "DELETE", ben));
        const declinedAgain = yield* as(ANNA, "DELETE", ben);
        const approveDeclined = yield* as(ANNA, "PUT", ben);
        const withdrawn = yield* body(as(CARA, "DELETE", "/v1/profiles/anna/follow"));
        const left = yield* body(as(ANNA, "GET", "/v1/follow-requests"));
        yield* name(ANNA, "anna", false);
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        const unfollowed = yield* body(as(BEN, "DELETE", "/v1/profiles/anna/follow"));
        const anna = yield* body(as(BEN, "GET", "/v1/profiles/anna"));
        return { declinedAgain, approveDeclined, withdrawn, left, unfollowed, anna };
      }),
    );
    expect(result).toMatchObject({
      declinedAgain: { status: 404, body: { error: "request_not_found" } },
      approveDeclined: { status: 404, body: { error: "request_not_found" } },
      withdrawn: { follow: "none" },
      left: { requests: [] },
      unfollowed: { follow: "none" },
      anna: { followers: 0, follow: "none" },
    });
  });

  it("approves every waiting request when a private profile becomes public", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        yield* body(as(CARA, "PUT", "/v1/profiles/anna/follow"));
        return yield* name(ANNA, "anna", false);
      }),
    );
    expect(result).toMatchObject({ followers: 2, requests: 0 });
  });

  it("approves the request it was shown after its username passes to another account", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        // Anna's requests screen loads Ben's request, then Ben renames and Cara takes "ben".
        const shown = yield* requestFrom(ANNA, "ben");
        yield* name(BEN, "ben_two");
        yield* name(CARA, "ben");
        yield* body(as(CARA, "PUT", "/v1/profiles/anna/follow"));
        const caras = yield* requestFrom(ANNA, "ben");
        const approved = yield* as(ANNA, "PUT", `/v1/follow-requests/${shown}`);
        const again = yield* as(ANNA, "PUT", `/v1/follow-requests/${shown}`);
        const byUsername = yield* as(ANNA, "PUT", "/v1/follow-requests/ben");
        return {
          fresh: caras !== shown,
          approved,
          again,
          byUsername,
          followers: yield* body(as(ANNA, "GET", "/v1/profiles/anna/followers")),
          requests: yield* body(as(ANNA, "GET", "/v1/follow-requests")),
          cara: yield* body(as(CARA, "GET", "/v1/profiles/anna")),
          caraSees: yield* titles(CARA, "anna"),
        };
      }),
    );
    expect(result).toMatchObject({
      fresh: true,
      approved: { status: 200, body: {} },
      again: { status: 404, body: { error: "request_not_found" } },
      byUsername: { status: 404, body: { error: "request_not_found" } },
      followers: { profiles: [{ username: "ben_two" }] },
      requests: { requests: [{ username: "ben" }] },
      cara: { follow: "requested", followers: 1 },
      caraSees: [],
    });
  });

  it("declines only the request it was shown, never a newer one from the same account", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        const shown = yield* requestFrom(ANNA, "ben");
        // Ben takes the request back and asks again, so the one Anna was shown is gone.
        yield* body(as(BEN, "DELETE", "/v1/profiles/anna/follow"));
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        const stale = yield* as(ANNA, "DELETE", `/v1/follow-requests/${shown}`);
        // A request to someone else is not Anna's to answer.
        yield* body(as(BEN, "PUT", "/v1/profiles/cara/follow"));
        const toCara = yield* requestFrom(CARA, "ben");
        const notHers = yield* as(ANNA, "PUT", `/v1/follow-requests/${toCara}`);
        return {
          stale,
          notHers,
          anna: yield* body(as(ANNA, "GET", "/v1/follow-requests")),
          cara: yield* body(as(CARA, "GET", "/v1/follow-requests")),
        };
      }),
    );
    expect(result).toMatchObject({
      stale: { status: 404, body: { error: "request_not_found" } },
      notHers: { status: 404, body: { error: "request_not_found" } },
      anna: { requests: [{ username: "ben" }] },
      cara: { requests: [{ username: "ben" }] },
    });
  });

  it("refuses to follow yourself, before you have a username, or nobody", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        return [
          yield* as(ANNA, "PUT", "/v1/profiles/ANNA/follow"),
          yield* as(BEN, "PUT", "/v1/profiles/anna/follow"),
          yield* as(ANNA, "PUT", "/v1/profiles/nobody/follow"),
          yield* as(ANNA, "GET", "/v1/profiles/nobody"),
        ];
      }),
    );
    expect(result).toEqual([
      { status: 400, body: { error: "cannot_follow_self" } },
      { status: 403, body: { error: "username_required" } },
      { status: 404, body: { error: "not_found" } },
      { status: 404, body: { error: "not_found" } },
    ]);
  });

  it("needs a session", async () => {
    const answer = await withServer(
      Effect.gen(function* () {
        const response = yield* (yield* HttpClient.HttpClient).execute(
          HttpClientRequest.get("/v1/profiles/anna"),
        );
        return { status: response.status, body: yield* response.json };
      }),
    );
    expect(answer).toEqual({ status: 401, body: { error: "unauthorized" } });
  });
});

/** SocialRows on a fresh, migrated database, beside its PostgreSQL client. */
const socialRows = async () => {
  const url = await postgres.createDatabase(`social_${++databases}`);
  await Effect.runPromise(migrate.pipe(Effect.provide(databaseLayer(url))));
  return SocialRows.layer.pipe(Layer.provideMerge(databaseLayer(url)));
};

class Rollback extends Data.TaggedError("Rollback")<{}> {}

/**
 * Runs `hold` in a transaction of its own, and keeps that transaction open until `release`
 * completes, then rolls it back. The effect returned completes once `hold` has run.
 */
const holdOpen = (hold: Effect.Effect<unknown, unknown, PgClient.PgClient>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* hold;
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            return yield* new Rollback();
          }),
        )
        .pipe(Effect.ignore),
    );
    yield* Deferred.await(held);
    return Effect.andThen(Deferred.succeed(release, undefined), Fiber.join(fiber));
  });

/** Waits until `count` sessions on this database wait for a lock. */
const lockWaits = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (let tries = 0; tries < 500; tries++) {
      const [row] = yield* sql<{ readonly waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `;
      if ((row?.waiting ?? 0) >= count) return;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error(`${count} sessions never waited for a lock`));
  });

/** Runs `effect` in the background, and waits until it ends or `waits` sessions wait. */
const startWaiting = <A, E, R>(effect: Effect.Effect<A, E, R>, waits: number) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* Effect.race(Effect.asVoid(Fiber.await(fiber)), lockWaits(waits));
    return fiber;
  });

describe("a follow racing a privacy change", { timeout: 60_000 }, () => {
  const anna = Username.make("anna");
  const annaId = ANNA as AccountId;
  const caraId = CARA as AccountId;

  /** Names Anna private and Ben and Cara, then runs `race` and reads how Cara's follow ended. */
  const racing = async <A, E>(
    race: (rows: SocialRowsShape) => Effect.Effect<A, E, PgClient.PgClient>,
  ) => {
    const layer = await socialRows();
    return Effect.runPromise(
      Effect.gen(function* () {
        const rows = yield* SocialRows;
        yield* rows.saveProfile(annaId, { username: anna, private: true });
        yield* rows.saveProfile(BEN as AccountId, {
          username: Username.make("ben"),
          private: true,
        });
        yield* rows.saveProfile(caraId, { username: Username.make("cara"), private: true });
        const raced = yield* race(rows);
        return {
          raced,
          cara: (yield* rows.profile(caraId, "anna")).follow,
          anna: yield* rows.ownProfile(annaId),
        };
      }).pipe(Effect.provide(layer)),
    );
  };

  it("approves a follow that read the profile as private just before it went public", async () => {
    const result = await racing((rows) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        // An open transaction holds the row Cara's follow inserts, so the follow stops after
        // reading Anna's profile and before its request is written.
        const release = yield* holdOpen(
          sql`insert into follow (follower_id, followee_id, state) values (${CARA}, ${ANNA}, 'held')`,
        );
        const follow = yield* startWaiting(rows.follow(caraId, "anna"), 1);
        const madePublic = yield* startWaiting(
          rows.saveProfile(annaId, { username: anna, private: false }),
          2,
        );
        yield* release;
        return { follow: yield* Fiber.join(follow), madePublic: yield* Fiber.join(madePublic) };
      }),
    );
    expect(result).toEqual({
      raced: {
        follow: "requested",
        madePublic: { username: "anna", private: false, followers: 1, following: 0, requests: 0 },
      },
      cara: "following",
      anna: { username: "anna", private: false, followers: 1, following: 0, requests: 0 },
    });
  });

  it("follows at once when the profile goes public while the follow waits", async () => {
    const result = await racing((rows) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* rows.follow(BEN as AccountId, "anna");
        // An open transaction locks Ben's request, so making Anna public stops while it
        // approves the requests, before it commits.
        const release = yield* holdOpen(
          sql`select 1 from follow where follower_id = ${BEN} and followee_id = ${ANNA} for update`,
        );
        const madePublic = yield* startWaiting(
          rows.saveProfile(annaId, { username: anna, private: false }),
          1,
        );
        const follow = yield* startWaiting(rows.follow(caraId, "anna"), 2);
        yield* release;
        return { madePublic: yield* Fiber.join(madePublic), follow: yield* Fiber.join(follow) };
      }),
    );
    expect(result).toEqual({
      raced: {
        madePublic: { username: "anna", private: false, followers: 1, following: 0, requests: 0 },
        follow: "following",
      },
      cara: "following",
      anna: { username: "anna", private: false, followers: 2, following: 0, requests: 0 },
    });
  });
});

describe("follow lists", { timeout: 60_000 }, () => {
  it("pages followers by username until the last page", async () => {
    const layer = await socialRows();
    const pages = await Effect.runPromise(
      Effect.gen(function* () {
        const rows = yield* SocialRows;
        yield* rows.saveProfile(ANNA as AccountId, {
          username: Username.make("anna"),
          private: false,
        });
        const followers = Array.from(
          { length: PAGE + 1 },
          (_, n) => `f${String(n).padStart(3, "0")}`,
        );
        for (const follower of followers) {
          const account = `user_${follower}` as AccountId;
          yield* rows.saveProfile(account, { username: Username.make(follower), private: true });
          yield* rows.follow(account, "anna");
        }
        const first = yield* rows.followers(BEN as AccountId, "anna");
        const second = yield* rows.followers(BEN as AccountId, "anna", first.next ?? undefined);
        return { followers, first, second };
      }).pipe(Effect.provide(layer)),
    );
    expect(pages.first.profiles.map(({ username }) => username)).toEqual(
      pages.followers.slice(0, PAGE),
    );
    expect(pages.first.next).toBe(pages.followers[PAGE - 1]);
    expect(pages.second).toEqual({
      profiles: [{ username: pages.followers[PAGE], private: true, follow: "none" }],
      next: null,
    });
  });
});

describe("a profile's activities", { timeout: 60_000 }, () => {
  it("shows each viewer what the privacy rule allows, newest first", async () => {
    const seen = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        // Shared one after another, the newest first, whatever their start times.
        for (const each of [
          activity("everyone"),
          activity("followers"),
          activity("only_you"),
          activity("followers", [], { deletedAt: 5, updatedAt: 5 }),
        ]) {
          yield* write(ANNA, [each]);
          yield* Effect.sleep("5 millis");
        }
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        yield* body(as(CARA, "PUT", "/v1/profiles/anna/follow"));
        const requested = yield* titles(BEN, "anna");
        yield* body(as(ANNA, "PUT", `/v1/follow-requests/${yield* requestFrom(ANNA, "ben")}`));
        return {
          owner: yield* titles(ANNA, "anna"),
          follower: yield* titles(BEN, "anna"),
          requested,
          stranger: yield* titles(CARA, "anna"),
        };
      }),
    );
    const [everyone, followers, onlyYou] = ["everyone run", "followers run", "only_you run"].map(
      (prefix) => expect.stringMatching(new RegExp(`^${prefix}`)),
    );
    expect(seen).toEqual({
      owner: [onlyYou, followers, everyone],
      follower: [followers, everyone],
      requested: [everyone],
      stranger: [everyone],
    });
  });

  it("never sends a hidden field's value to anyone but the owner", async () => {
    const hidden = activity("everyone", ["start_time", "calories"]);
    const [owner, other] = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna", false);
        yield* name(BEN, "ben");
        yield* write(ANNA, [hidden]);
        return [
          yield* body<Seen>(as(ANNA, "GET", "/v1/profiles/anna")),
          yield* body<Seen>(as(BEN, "GET", "/v1/profiles/anna")),
        ] as const;
      }),
    );
    expect(owner.activities).toEqual([
      expect.objectContaining({ startedAt: hidden.startedAt, energyKcal: 410, hiddenFields: [] }),
    ]);
    expect(other.activities).toEqual([
      {
        id: expect.any(String),
        kind: "run",
        startedAt: null,
        durationS: null,
        title: hidden.title,
        notes: "",
        energyKcal: null,
        hiddenFields: ["start_time", "calories"],
      },
    ]);
    const sent = JSON.stringify(other);
    expect(sent).not.toContain(hidden.id);
    expect(sent).not.toContain(String(hidden.startedAt));
    expect(sent).not.toContain("410");
    expect(sent).not.toContain("audience");
  });

  it("names an imported workout with a hidden start by an ID that does not reveal the start", async () => {
    // A Hevy workout's own ID is a UUIDv5 of its start as the file writes it, in a public
    // namespace, so anyone holding it could find the start by trying each minute of a day.
    const start = "3 Nov 2026, 18:30";
    const imported = activity("everyone", ["start_time"], {
      id: importedId(TABLES.activity.name, "hevy", start),
      kind: "strength",
      startedAt: Date.UTC(2026, 10, 3, 18, 30),
      source: "hevy",
      sourceId: start,
      fingerprint: "f".repeat(64),
    });
    const sent = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna", false);
        yield* name(BEN, "ben");
        yield* write(ANNA, [imported]);
        const profile = yield* body<{
          readonly activities: ReadonlyArray<{ readonly id: string }>;
        }>(as(BEN, "GET", "/v1/profiles/anna"));
        const id = profile.activities[0]?.id ?? "";
        const one = yield* body(as(BEN, "GET", `/v1/activities/${id}`));
        return { id, text: JSON.stringify([profile, one]) };
      }),
    );
    expect(sent.id).not.toBe(imported.id);
    for (const secret of [imported.id, imported.sourceId, String(imported.startedAt), "18:30"]) {
      expect(sent.text).not.toContain(secret);
    }
    const day = Array.from({ length: 24 * 60 }, (_, minute) => {
      const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      return importedId(TABLES.activity.name, "hevy", `3 Nov 2026, ${time}`);
    });
    expect(day).toContain(imported.id);
    expect(day.filter((guess) => sent.text.includes(guess))).toEqual([]);
  });

  it("keeps each activity's social ID across reads and viewers, and looks it up through privacy", async () => {
    const open = activity("everyone");
    const close = activity("followers");
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna", false);
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        yield* write(ANNA, [open, close]);
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        type Listed = {
          readonly activities: ReadonlyArray<{ readonly id: string; readonly title: string }>;
        };
        const idsFor = (viewer: string) =>
          Effect.map(body<Listed>(as(viewer, "GET", "/v1/profiles/anna")), (profile) =>
            Object.fromEntries(profile.activities.map(({ id, title }) => [title, id])),
          );
        const first = yield* idsFor(BEN);
        const again = yield* idsFor(BEN);
        const stranger = yield* idsFor(CARA);
        const owner = yield* idsFor(ANNA);
        const openId = first[open.title] ?? "";
        const closeId = first[close.title] ?? "";
        const lookups = {
          follower: yield* as(BEN, "GET", `/v1/activities/${closeId}`),
          stranger: yield* as(CARA, "GET", `/v1/activities/${closeId}`),
          strangerOpen: yield* as(CARA, "GET", `/v1/activities/${openId}`),
          ownId: yield* as(BEN, "GET", `/v1/activities/${close.id}`),
          garbage: yield* as(BEN, "GET", "/v1/activities/not-an-id"),
        };
        yield* write(ANNA, [{ ...open, audience: "only_you", updatedAt: 2 }]);
        const madeOnlyYou = yield* as(CARA, "GET", `/v1/activities/${openId}`);
        yield* write(ANNA, [{ ...open, updatedAt: 3 }]);
        const sharedAgain = yield* idsFor(CARA);
        yield* write(ANNA, [{ ...close, updatedAt: 4, deletedAt: 4 }]);
        const deleted = yield* as(BEN, "GET", `/v1/activities/${closeId}`);
        return {
          first,
          again,
          stranger,
          owner,
          lookups,
          madeOnlyYou,
          sharedAgain,
          deleted,
        };
      }),
    );
    const openId = result.first[open.title];
    const closeId = result.first[close.title];
    expect(openId).not.toBe(closeId);
    expect(result).toMatchObject({
      again: result.first,
      stranger: { [open.title]: openId },
      owner: { [open.title]: openId, [close.title]: closeId },
      lookups: {
        follower: { status: 200, body: { id: closeId, title: close.title } },
        stranger: { status: 404, body: { error: "not_found" } },
        strangerOpen: { status: 200, body: { id: openId, title: open.title } },
        ownId: { status: 404, body: { error: "not_found" } },
        garbage: { status: 400, body: { error: "invalid_request" } },
      },
      madeOnlyYou: { status: 404, body: { error: "not_found" } },
      sharedAgain: { [open.title]: openId },
      deleted: { status: 404, body: { error: "not_found" } },
    });
    expect(Object.keys(result.stranger)).toEqual([open.title]);
  });

  it("places an activity whose start is hidden by when it was shared, so its neighbours tell nothing", async () => {
    // The same three activities, shared in the same order, with the hidden start long before
    // or long after its neighbours'.
    const profiles = await Promise.all(
      [1_600_000_000_000, 1_900_000_000_000].map((hiddenStart) =>
        withServer(
          Effect.gen(function* () {
            yield* name(ANNA, "anna", false);
            yield* name(BEN, "ben");
            const tick = Effect.sleep("5 millis");
            yield* write(ANNA, [
              activity("everyone", [], { title: "Before", startedAt: 1_790_000_000_000 }),
            ]);
            yield* tick;
            yield* write(ANNA, [
              activity("everyone", ["start_time"], { title: "Hidden", startedAt: hiddenStart }),
            ]);
            yield* tick;
            yield* write(ANNA, [
              activity("everyone", [], { title: "After", startedAt: 1_790_000_100_000 }),
            ]);
            const first = yield* as(BEN, "GET", "/v1/profiles/anna");
            const listed = (first.body as { activities: ReadonlyArray<{ id: string }> }).activities;
            const answers = [
              first,
              ...(yield* Effect.forEach(listed, ({ id }) =>
                as(BEN, "GET", `/v1/profiles/anna/activities?cursor=${cursorFor(id)}`),
              )),
            ];
            return {
              text: JSON.stringify(answers),
              order: (first.body as { activities: ReadonlyArray<Shown> }).activities.map(
                (shown) => [shown.title, shown.startedAt, shown.durationS],
              ),
              after: answers
                .slice(1)
                .map((answer) =>
                  (answer.body as { activities: ReadonlyArray<Shown> }).activities.map(
                    ({ title }) => title,
                  ),
                ),
            };
          }),
        ),
      ),
    );
    for (const profile of profiles) {
      expect(profile.order).toEqual([
        ["After", 1_790_000_100_000, 1800],
        ["Hidden", null, null],
        ["Before", 1_790_000_000_000, 1800],
      ]);
      expect(profile.after).toEqual([["Hidden", "Before"], ["Before"], []]);
    }
    expect(profiles[0]?.text).not.toContain("1600000000");
    expect(profiles[1]?.text).not.toContain("1900000000");
  });

  it("pages by a cursor that names only the social ID, and refuses one the viewer may no longer see", async () => {
    // Each write starts earlier than the one before, so an order by start would differ.
    const writes = [0, 1, 2].map((batch) =>
      Array.from({ length: batch === 2 ? 5 : PAGE / 2 }, (_, index) =>
        activity("everyone", ["start_time"], {
          startedAt: 1_790_123_456_000 - batch * 86_400_000 + index,
          title: `Write ${batch} #${index}`,
        }),
      ),
    );
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna", false);
        yield* name(BEN, "ben");
        for (const rows of writes) {
          yield* write(ANNA, rows);
          yield* Effect.sleep("5 millis");
        }
        type Page = { readonly activities: ReadonlyArray<Shown>; readonly next: string | null };
        const first = yield* body<Page>(as(BEN, "GET", "/v1/profiles/anna"));
        const firstAgain = yield* body<Page>(as(BEN, "GET", "/v1/profiles/anna/activities"));
        const second = yield* body<Page>(
          as(BEN, "GET", `/v1/profiles/anna/activities?cursor=${first.next}`),
        );
        const anchor = first.activities.at(-1)?.title;
        const hidden = writes.flat().find((row) => row.title === anchor);
        if (hidden === undefined) throw new Error("No activity named by the cursor");
        yield* write(ANNA, [{ ...hidden, audience: "only_you", updatedAt: 2 }]);
        const pageAfter = (account: string, cursor: string) =>
          as(account, "GET", `/v1/profiles/anna/activities?cursor=${cursor}`);
        return {
          first,
          firstAgain,
          second,
          cursor: Buffer.from(first.next ?? "", "base64url").toString(),
          owner: yield* pageAfter(ANNA, first.next ?? ""),
          madeOnlyYou: yield* pageAfter(BEN, first.next ?? ""),
          nothing: yield* pageAfter(BEN, cursorFor("6f1c2a4e-93b0-4d5e-8a71-0c9e4b2d7f13")),
          garbage: yield* pageAfter(BEN, "bm9wZQ"),
        };
      }),
    );
    expect(result.first.activities).toHaveLength(PAGE);
    expect({ ...result.firstAgain, activities: result.firstAgain.activities.length }).toEqual({
      activities: PAGE,
      next: result.first.next,
    });
    expect(result.second.next).toBeNull();
    const all = [...result.first.activities, ...result.second.activities];
    expect(new Set(all.map(({ id }) => id)).size).toBe(PAGE + 5);
    expect(all.map(({ title }) => title.split(" #")[0])).toEqual(
      [2, 1, 0].flatMap((batch) =>
        Array.from({ length: batch === 2 ? 5 : PAGE / 2 }, () => `Write ${batch}`),
      ),
    );
    expect(JSON.parse(result.cursor)).toEqual({ id: result.first.activities.at(-1)?.id });
    expect(result.cursor).not.toContain("1790123");
    expect(result.owner.status).toBe(200);
    expect(
      [result.madeOnlyYou, result.nothing, result.garbage].map((answer) => [
        answer.status,
        answer.body,
      ]),
    ).toEqual(Array.from({ length: 3 }, () => [400, { error: "invalid_cursor" }]));
  });

  it("shows nothing from another account that holds the same activity ID", async () => {
    const shared = activity("everyone");
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna", false);
        yield* name(BEN, "ben", false);
        yield* write(BEN, [{ ...shared, title: "Ben's copy", audience: "only_you" }]);
        yield* write(ANNA, [shared]);
        return {
          ben: yield* titles(ANNA, "ben"),
          anna: yield* titles(BEN, "anna"),
        };
      }),
    );
    expect(result).toEqual({ ben: [], anna: [shared.title] });
  });
});

describe("the social proof script", { timeout: 60_000 }, () => {
  it("passes against a running server with the stand-in issuer", async () => {
    const lines: Array<string> = [];
    const accounts = { owner: "user_proof_owner", follower: "user_proof_follower" };
    const layer = await listening();
    await Effect.runPromise(
      Effect.gen(function* () {
        const { address } = yield* HttpServer.HttpServer;
        if (!("port" in address)) throw new Error("Expected a TCP address");
        const proof = () =>
          socialProof({
            server: `http://127.0.0.1:${address.port}`,
            token: (account) => issuer.sessionToken(accounts[account]),
            usernames: { owner: "proof_owner", follower: "proof_follower" },
            log: (line) => lines.push(line),
          });
        yield* Effect.promise(proof);
        // A second run starts from where the first one left both accounts.
        yield* Effect.promise(proof);
      }).pipe(Effect.provide(layer)),
    );
    expect(lines.slice(0, 6)).toEqual([
      "proof_owner has a private profile, and proof_follower does not follow it",
      "proof_owner wrote a followers-only, an everyone and an only-you activity",
      "Stranger: the followers-only activity is absent, the everyone one present",
      "Requested: the followers-only activity stays absent until proof_owner approves",
      "Follower: the followers-only activity is present, without its hidden start time, and the only-you one absent",
      "Deleted the proof's activities and ended the follow",
    ]);
    expect(lines.slice(6)).toEqual(lines.slice(0, 6));
  });

  it("fails when a stranger sees a followers-only activity", async () => {
    const accounts = { owner: "user_leak_owner", follower: "user_leak_owner" };
    const layer = await listening();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const { address } = yield* HttpServer.HttpServer;
        if (!("port" in address)) throw new Error("Expected a TCP address");
        // Both tokens name one account, so the "stranger" is the owner and sees everything.
        return yield* Effect.promise(() =>
          socialProof({
            server: `http://127.0.0.1:${address.port}`,
            token: (account) => issuer.sessionToken(accounts[account]),
            usernames: { owner: "leak_owner", follower: "leak_owner" },
            log: () => undefined,
          }).then(
            () => undefined,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          ),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(failure).toBe("A stranger saw the followers-only activity");
  });
});
