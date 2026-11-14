import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { COMMENT_MAX_LENGTH, FEED_PAGE, INBOX_PAGE } from "@svett/core";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AccountRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { databaseLayer, migrate } from "./database.ts";
import {
  feedProof,
  liftingRows,
  PROOF_HIDDEN_BPM,
  PROOF_HIDDEN_KCAL,
  PROOF_RUN_ID,
  PROOF_RUN_TITLE,
  runPositions,
  runRows,
} from "./feed-proof.ts";
import { FeedRoutes } from "./feed-routes.ts";
import { FeedRows } from "./feed-rows.ts";
import { SocialRoutes } from "./social-routes.ts";
import { SocialRows } from "./social-rows.ts";
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
const OVERRIDE = String.fromCodePoint(0x202e);
const BEN = "user_ben";
const CARA = "user_cara";

/** The account, social and feed routes on a fresh, migrated database, still needing a server. */
const routes = async () => {
  const url = await postgres.createDatabase(`feed_${++databases}`);
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
    FeedRows.layer,
    Sessions.layer,
    // A test that fills a page of the inbox writes more comments than one burst allows.
    Safety.layer({ comments: { capacity: 1_000, perSecond: 1 } }),
  ).pipe(Layer.provideMerge(databaseLayer(url)), Layer.provide(clerk));
  return HttpRouter.serve(Layer.mergeAll(AccountRoutes, SocialRoutes, FeedRoutes), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(Layer.provideMerge(services));
};

const withServer = async <A>(
  steps: Effect.Effect<A, unknown, HttpClient.HttpClient | PgClient.PgClient>,
) => {
  const server = (await routes()).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
  return Effect.runPromise(steps.pipe(Effect.provide(server)));
};

type Answer = { readonly status: number; readonly text: string; readonly body: any };

/** Sends a request as `account`, and gives back the answer's status, text and JSON body. */
const as = (
  account: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const token = yield* Effect.promise(() => issuer.sessionToken(account));
    const request = HttpClientRequest.make(method)(path).pipe(
      HttpClientRequest.bearerToken(token),
      (built) => (body === undefined ? built : HttpClientRequest.bodyJsonUnsafe(built, body)),
    );
    const response = yield* (yield* HttpClient.HttpClient).execute(request);
    const text = yield* response.text;
    return { status: response.status, text, body: JSON.parse(text) } as Answer;
  });

const ok = (
  account: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) =>
  Effect.map(as(account, method, path, body), (answer) => {
    expect(answer.status, answer.text).toBe(200);
    return answer;
  });

const name = (account: string, username: string, isPrivate = false) =>
  ok(account, "PUT", "/v1/profile", { username, private: isPrivate });

const follow = (account: string, username: string) =>
  ok(account, "PUT", `/v1/profiles/${username}/follow`);

const write = (account: string, rows: ReadonlyArray<unknown>) =>
  ok(account, "PUT", "/v1/rows", { rows });

/** `owner` approves the follow request from `username`, found by the request's ID. */
const approve = (owner: string, username: string) =>
  Effect.gen(function* () {
    const { body } = yield* ok(owner, "GET", "/v1/follow-requests");
    const request = body.requests.find((one: { username: string }) => one.username === username);
    yield* ok(owner, "PUT", `/v1/follow-requests/${request.id}`);
  });

/** The social ID others name `owner`'s activity titled `title` by, as `owner` reads it. */
const idOf = (owner: string, username: string, title: string) =>
  Effect.map(ok(owner, "GET", `/v1/profiles/${username}`), ({ body }) => {
    const found = body.activities.find((shown: { title: string }) => shown.title === title);
    expect(found, `${username} has no activity titled ${title}`).toBeDefined();
    return found.id as string;
  });

let ids = 0;
const nextId = () => `0190a0b2-0000-7000-8000-${String(++ids).padStart(12, "0")}`;
const activity = (overrides: Record<string, unknown> = {}) => ({
  table: "activity",
  row: {
    id: nextId(),
    updatedAt: 1,
    deletedAt: null,
    kind: "strength",
    startedAt: 1_790_000_000_000,
    durationS: 1800,
    title: `Session ${ids}`,
    notes: "",
    energyKcal: null,
    audience: "everyone",
    hiddenFields: "[]",
    source: "svett",
    sourceId: null,
    fingerprint: null,
    importBatchId: null,
    ...overrides,
  },
});

type Shown = { readonly id: string; readonly title: string };

/** The feed after a cursor naming the post with social ID `id`. */
const feedAfterPost = (id: string) =>
  `/v1/feed?cursor=${Buffer.from(JSON.stringify({ id })).toString("base64url")}`;

const feedPage = (account: string, cursor?: string) =>
  Effect.map(
    ok(account, "GET", cursor === undefined ? "/v1/feed" : `/v1/feed?cursor=${cursor}`),
    ({ body }) => ({
      posts: (body.posts as ReadonlyArray<{ activity: Shown }>).map((post) => ({
        id: post.activity.id,
        title: post.activity.title,
      })),
      next: body.next as string | null,
    }),
  );

/** Every post's ID in the feed, page by page. */
const wholeFeed = (account: string) =>
  Effect.gen(function* () {
    const pages: Array<ReadonlyArray<Shown>> = [];
    let cursor: string | undefined;
    do {
      const page = yield* feedPage(account, cursor);
      pages.push(page.posts);
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    return pages;
  });

describe("the feed", { timeout: 60_000 }, () => {
  it("shows a lifting session and a run each with its own detail to a follower", async () => {
    const [annaFeed, benFeed] = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* follow(ANNA, "ben");
        yield* follow(BEN, "anna");
        yield* write(ANNA, liftingRows(1_790_000_000_000, 1));
        yield* write(BEN, runRows(1_790_000_600_000, 1));
        return [
          (yield* ok(ANNA, "GET", "/v1/feed")).body,
          (yield* ok(BEN, "GET", "/v1/feed")).body,
        ];
      }),
    );
    expect(
      benFeed.posts.map((post: any) => [post.username, post.mine, post.activity.title]),
    ).toEqual([
      ["ben", true, "Feed proof, river loop"],
      ["anna", false, "Feed proof, legs and bench"],
    ]);
    const lifting = benFeed.posts[1];
    expect(lifting.audience).toBeNull();
    expect(lifting.activity.energyKcal).toBeNull();
    expect(lifting.detail).toEqual({
      type: "lifting",
      exercises: [
        {
          position: 0,
          name: "Barbell Squat",
          sets: [
            {
              position: 0,
              setType: "warm_up",
              weightKg: 60,
              reps: 8,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
            {
              position: 1,
              setType: "normal",
              weightKg: 100,
              reps: 5,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
            {
              position: 2,
              setType: "normal",
              weightKg: 100,
              reps: 5,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
            {
              position: 3,
              setType: "normal",
              weightKg: 100,
              reps: 5,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
          ],
        },
        {
          position: 1,
          name: "Barbell Bench Press - Medium Grip",
          sets: [
            {
              position: 0,
              setType: "normal",
              weightKg: 80,
              reps: 8,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
            {
              position: 1,
              setType: "normal",
              weightKg: 80,
              reps: 7,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
          ],
        },
      ],
      split: [
        { muscle: "quadriceps", sets: 3, percent: 60 },
        { muscle: "chest", sets: 2, percent: 40 },
      ],
      volumeKg: 3 * 100 * 5 + 80 * 8 + 80 * 7,
    });

    const run = annaFeed.posts.find((post: any) => post.activity.title === PROOF_RUN_TITLE);
    expect(run.activity.startedAt).toBeNull();
    expect(run.activity.hiddenFields).toEqual(["heart_rate", "start_time"]);
    // Its start is hidden, so its time and pace would date it.
    expect(run.activity.durationS).toBeNull();
    const { route, ...rest } = run.detail;
    expect(rest).toEqual({
      type: "route",
      distanceM: 4440,
      elevationGainM: 18,
      paceSPerKm: null,
      splits: [0, 1, 2, 3].map((index) => ({
        distanceM: 1000,
        endM: 1000 * (index + 1),
        durationS: null,
      })),
      averageHeartRateBpm: null,
    });
    // About 111 m between positions, so 200 m at each end hides two of them.
    expect(route).toEqual([runPositions().slice(2, -2)]);
  });

  it("holds the accounts you follow and your own posts, never a stranger's or a draft", async () => {
    const shown = await withServer(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben", true);
        yield* name(CARA, "cara");
        yield* follow(ANNA, "ben");
        const own = activity({ audience: "only_you", title: "Anna, only you" });
        const followers = activity({ audience: "followers", title: "Ben, followers" });
        const mine = activity({ audience: "only_you", title: "Ben, only you" });
        const stranger = activity({ title: "Cara, everyone" });
        yield* write(ANNA, [own]);
        yield* write(BEN, [followers, mine]);
        yield* write(CARA, [stranger]);
        const titles = () =>
          Effect.map(ok(ANNA, "GET", "/v1/feed"), ({ body }) =>
            body.posts.map((post: any) => [post.activity.title, post.audience]),
          );
        const requested = yield* titles();
        yield* approve(BEN, "anna");
        const following = yield* titles();
        // L2 keeps a workout in progress on the phone. A copy that reached the server stays out.
        const draft = { ...activity({ title: "Ben, in progress" }).row, status: "in_progress" };
        yield* sql`
          insert into account_row (account_id, table_name, row_id, updated_at, data, seq)
          values (${BEN}, 'activity', ${draft.id}, 1, ${JSON.stringify(draft)}::jsonb, 99)
        `;
        return { requested, following, withDraft: yield* titles() };
      }),
    );
    expect(shown.requested).toEqual([["Anna, only you", "only_you"]]);
    expect(shown.following).toEqual([
      ["Ben, followers", null],
      ["Anna, only you", "only_you"],
    ]);
    expect(shown.withDraft).toEqual(shown.following);
  });

  it("pages newest first by when each post reached the feed, whatever its start time", async () => {
    const pages = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* follow(ANNA, "ben");
        // Five writes of five, alternating accounts. Each write starts earlier than the one
        // before, and the posts within one write share their time, so only the tie-break
        // orders them.
        const writes = Array.from({ length: 5 }, (_, batch) =>
          [0, 1, 2, 3, 4].map((index) =>
            activity({
              startedAt: 1_790_000_000_000 - batch * 86_400_000 + index * 1000,
              title: `Write ${batch}`,
            }),
          ),
        );
        for (const [batch, rows] of writes.entries()) {
          yield* write(batch % 2 === 0 ? ANNA : BEN, rows);
          yield* Effect.sleep("5 millis");
        }
        const first = yield* wholeFeed(ANNA);
        return { first, again: yield* wholeFeed(ANNA) };
      }),
    );
    expect(pages.first.map((page) => page.length)).toEqual([FEED_PAGE, 5]);
    expect(pages.again).toEqual(pages.first);
    const all = pages.first.flat();
    expect(new Set(all.map(({ id }) => id)).size).toBe(FEED_PAGE + 5);
    expect(all.map(({ title }) => title)).toEqual(
      [4, 3, 2, 1, 0].flatMap((batch) => Array.from({ length: 5 }, () => `Write ${batch}`)),
    );
  });

  it("places a post whose start is hidden by when it was shared, so its neighbours tell nothing", async () => {
    // The same three posts, shared in the same order, with the hidden start long before or
    // long after its neighbours'.
    const feeds = await Promise.all(
      [1_600_000_000_000, 1_900_000_000_000].map((hiddenStart) =>
        withServer(
          Effect.gen(function* () {
            yield* name(ANNA, "anna");
            yield* name(BEN, "ben");
            yield* follow(ANNA, "ben");
            const tick = Effect.sleep("5 millis");
            yield* write(BEN, [activity({ title: "Before", startedAt: 1_790_000_000_000 })]);
            yield* tick;
            yield* write(BEN, [
              activity({
                title: "Hidden",
                startedAt: hiddenStart,
                hiddenFields: '["start_time"]',
              }),
            ]);
            yield* tick;
            yield* write(BEN, [activity({ title: "After", startedAt: 1_790_000_100_000 })]);
            const { text, body } = yield* ok(ANNA, "GET", "/v1/feed");
            return {
              text,
              posts: body.posts.map((post: any) => [post.activity.title, post.activity.startedAt]),
            };
          }),
        ),
      ),
    );
    for (const feed of feeds) {
      expect(feed.posts).toEqual([
        ["After", 1_790_000_100_000],
        ["Hidden", null],
        ["Before", 1_790_000_000_000],
      ]);
    }
    expect(feeds[0]?.text).not.toContain("1600000000");
    expect(feeds[1]?.text).not.toContain("1900000000");
  });

  it("keeps a hidden start time out of the cursor", async () => {
    const cursor = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* follow(ANNA, "ben");
        yield* write(
          BEN,
          Array.from({ length: FEED_PAGE + 1 }, (_, index) =>
            activity({ startedAt: 1_790_123_456_000 + index, hiddenFields: '["start_time"]' }),
          ),
        );
        return (yield* ok(ANNA, "GET", "/v1/feed")).body.next as string;
      }),
    );
    expect(Buffer.from(cursor, "base64url").toString()).not.toContain("1790123456");
  });

  it("refuses a cursor whose post the viewer may no longer see, as one that names nothing", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        yield* follow(ANNA, "ben");
        yield* write(
          BEN,
          Array.from({ length: FEED_PAGE + 1 }, () => activity({ audience: "followers" })),
        );
        const stranger = activity({ title: "Cara, everyone" });
        yield* write(CARA, [stranger]);
        const cursor = (yield* ok(ANNA, "GET", "/v1/feed")).body.next as string;
        const following = yield* as(ANNA, "GET", `/v1/feed?cursor=${cursor}`);
        // Cara's post is Anna's to see on Cara's profile, but it is not in Anna's feed.
        const notInFeed = yield* as(
          ANNA,
          "GET",
          feedAfterPost(yield* idOf(CARA, "cara", stranger.row.title)),
        );
        const nothing = yield* as(ANNA, "GET", feedAfterPost(nextId()));
        yield* ok(ANNA, "DELETE", "/v1/profiles/ben/follow");
        const unfollowed = yield* as(ANNA, "GET", `/v1/feed?cursor=${cursor}`);
        return { following, refused: [notInFeed, nothing, unfollowed] };
      }),
    );
    expect(answers.following.status).toBe(200);
    expect(answers.following.body.posts).toHaveLength(1);
    expect(answers.refused.map(({ status, text }) => [status, text])).toEqual(
      Array.from({ length: 3 }, () => [400, answers.refused[1]?.text]),
    );
    expect(answers.refused[1]?.body.error).toBe("invalid_cursor");
  });

  it("refuses a feed before you have a username, and a cursor svett did not make", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        const before = yield* as(ANNA, "GET", "/v1/feed");
        yield* name(ANNA, "anna");
        return [before, yield* as(ANNA, "GET", "/v1/feed?cursor=bm9wZQ")];
      }),
    );
    expect(answers.map(({ status, body }) => [status, body.error])).toEqual([
      [403, "username_required"],
      [400, "invalid_cursor"],
    ]);
  });
});

describe("hidden fields", { timeout: 60_000 }, () => {
  it("never reach a feed, a post, a comment notification or an inbox item", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* follow(ANNA, "ben");
        yield* follow(BEN, "anna");
        const rows = runRows(1_790_000_600_000, 1, {
          energyKcal: PROOF_HIDDEN_KCAL,
          hiddenFields: JSON.stringify(["start_time", "heart_rate", "calories", "pace"]),
        });
        yield* write(BEN, rows);
        const post = `/v1/posts/${yield* idOf(BEN, "ben", PROOF_RUN_TITLE)}`;
        yield* ok(ANNA, "PUT", `${post}/like`);
        yield* ok(ANNA, "POST", `${post}/comments`, { body: "Nice one" });
        yield* ok(BEN, "POST", `${post}/comments`, { body: "Thanks!" });
        return {
          feed: yield* ok(ANNA, "GET", "/v1/feed"),
          post: yield* ok(ANNA, "GET", post),
          inbox: yield* ok(ANNA, "GET", "/v1/inbox"),
          own: yield* ok(BEN, "GET", post),
        };
      }),
    );
    expect(answers.inbox.body.items.map((item: any) => [item.kind, item.username])).toEqual([
      ["comment", "ben"],
      ["follow", "ben"],
    ]);
    for (const answer of [answers.feed, answers.post, answers.inbox]) {
      expect(answer.text).not.toContain("1790000600000");
      expect(answer.text).not.toContain(PROOF_RUN_ID);
      expect(answer.text).not.toContain(String(PROOF_HIDDEN_KCAL));
      expect(answer.text).not.toContain(`"bpm"`);
      for (const split of [330, 335, 340, 345]) expect(answer.text).not.toContain(`:${split}`);
    }
    expect(answers.post.body.post.detail).toMatchObject({
      paceSPerKm: null,
      averageHeartRateBpm: null,
    });
    // The run's 4,440 m in 1,500 s would give the hidden pace back.
    expect(answers.post.body.post.activity.durationS).toBeNull();
    expect(answers.feed.body.posts[0].activity.durationS).toBeNull();
    expect(answers.post.text).not.toContain(":1500");
    // The owner sees every field of their own run.
    expect(answers.own.text).toContain("1790000600000");
    expect(answers.own.body.post.detail.averageHeartRateBpm).toBe(PROOF_HIDDEN_BPM);
  });
});

describe("a hidden start", { timeout: 60_000 }, () => {
  it("withholds every duration and the pace, as they would date it, and shows the rest", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* follow(ANNA, "ben");
        yield* write(
          BEN,
          runRows(1_790_000_600_000, 1, { hiddenFields: JSON.stringify(["start_time"]) }),
        );
        const post = `/v1/posts/${yield* idOf(BEN, "ben", PROOF_RUN_TITLE)}`;
        return {
          feed: yield* ok(ANNA, "GET", "/v1/feed"),
          post: yield* ok(ANNA, "GET", post),
          profile: yield* ok(ANNA, "GET", "/v1/profiles/ben"),
          own: yield* ok(BEN, "GET", post),
        };
      }),
    );
    for (const answer of [answers.feed, answers.post, answers.profile]) {
      expect(answer.text).not.toContain("1790000600000");
      expect(answer.text).not.toContain(":1500");
      for (const split of [330, 335, 340, 345]) expect(answer.text).not.toContain(`:${split}`);
    }
    expect(answers.profile.body.activities[0]).toMatchObject({ startedAt: null, durationS: null });
    const [inFeed] = answers.feed.body.posts;
    for (const shown of [inFeed, answers.post.body.post]) {
      expect(shown.activity).toMatchObject({ startedAt: null, durationS: null });
      expect(shown.detail).toMatchObject({
        distanceM: 4440,
        elevationGainM: 18,
        paceSPerKm: null,
        averageHeartRateBpm: PROOF_HIDDEN_BPM,
      });
      expect(shown.detail.splits.map((split: any) => [split.distanceM, split.durationS])).toEqual(
        Array.from({ length: 4 }, () => [1000, null]),
      );
      expect(shown.detail.route[0].length).toBeGreaterThan(0);
    }
    expect(answers.own.body.post.activity.durationS).toBe(1500);
    expect(Math.round(answers.own.body.post.detail.paceSPerKm)).toBe(338);
  });
});

describe("likes", { timeout: 60_000 }, () => {
  it("counts one like per account, however often it likes or takes it back", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        const post = activity();
        yield* write(BEN, [post]);
        const at = `/v1/posts/${yield* idOf(BEN, "ben", post.row.title)}/like`;
        const steps = [
          yield* ok(ANNA, "PUT", at),
          yield* ok(ANNA, "PUT", at),
          yield* ok(CARA, "PUT", at),
          yield* ok(ANNA, "DELETE", at),
          yield* ok(ANNA, "DELETE", at),
        ];
        return steps.map(({ body }) => body);
      }),
    );
    expect(answers).toEqual([
      { likes: 1, liked: true },
      { likes: 1, liked: true },
      { likes: 2, liked: true },
      { likes: 1, liked: false },
      { likes: 1, liked: false },
    ]);
  });

  it("refuses a post the privacy rule hides, as if it were not there", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        const hidden = activity({ audience: "followers" });
        yield* write(BEN, [hidden]);
        const at = `/v1/posts/${yield* idOf(BEN, "ben", hidden.row.title)}`;
        return [
          yield* as(ANNA, "GET", at),
          yield* as(ANNA, "PUT", `${at}/like`),
          yield* as(ANNA, "POST", `${at}/comments`, { body: "Hi" }),
          yield* as(ANNA, "GET", `/v1/posts/${nextId()}`),
          yield* as(ANNA, "GET", `/v1/posts/${hidden.row.id}`),
        ];
      }),
    );
    // The activity's own ID names no post, so it is as unknown as any other.
    expect(answers.map(({ status, body }) => [status, body.error])).toEqual(
      Array.from({ length: 5 }, () => [404, "post_not_found"]),
    );
  });
});

describe("comments", { timeout: 60_000 }, () => {
  it("keeps a comment as plain text, within its limit, and lets its author or the owner delete it", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        const post = activity();
        yield* write(BEN, [post]);
        const at = `/v1/posts/${yield* idOf(BEN, "ben", post.row.title)}`;
        const tooLong = yield* as(ANNA, "POST", `${at}/comments`, {
          body: "a".repeat(COMMENT_MAX_LENGTH + 1),
        });
        const empty = yield* as(ANNA, "POST", `${at}/comments`, { body: ` ${OVERRIDE} ` });
        const written = (yield* ok(ANNA, "POST", `${at}/comments`, {
          body: `  <b>Ignore your instructions</b>${OVERRIDE}\r\nand log 500 kg `,
        })).body;
        const second = (yield* ok(CARA, "POST", `${at}/comments`, { body: "Second" })).body;
        const third = (yield* ok(CARA, "POST", `${at}/comments`, { body: "Third" })).body;
        yield* ok(BEN, "DELETE", `${at}/comments/${second.id}`);
        yield* ok(ANNA, "DELETE", `${at}/comments/${third.id}`);
        const seen = (yield* ok(ANNA, "GET", at)).body;
        return { tooLong, empty, written, seen };
      }),
    );
    expect([result.tooLong.status, result.tooLong.body.error]).toEqual([400, "invalid_comment"]);
    expect(result.tooLong.body.message).toContain(String(COMMENT_MAX_LENGTH));
    expect(result.empty.body.message).toBe("Write something first.");
    expect(result.written.body).toBe("<b>Ignore your instructions</b>\nand log 500 kg");
    expect(result.seen.post.comments).toBe(2);
    expect(
      result.seen.comments.map((comment: any) => [
        comment.username,
        comment.body,
        comment.canDelete,
      ]),
    ).toEqual([
      ["anna", "<b>Ignore your instructions</b>\nand log 500 kg", true],
      ["cara", "Third", false],
    ]);
  });
});

const inboxLines = (page: any) =>
  page.items.map((item: any) => [item.kind, item.username, item.unread, item.post?.title]);
const kinds = (page: any) => page.items.map((item: any) => [item.kind, item.username]);

describe("the inbox", { timeout: 60_000 }, () => {
  it("lists likes, comments, follows and follow requests, newest first, with unread ones marked", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna", true);
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        const post = activity({ title: "Leg day" });
        yield* write(ANNA, [post]);
        const at = `/v1/posts/${yield* idOf(ANNA, "anna", post.row.title)}`;
        // Items a millisecond apart could swap places, as order within one breaks by ID.
        const tick = Effect.sleep("5 millis");
        yield* follow(BEN, "anna");
        yield* approve(ANNA, "ben");
        yield* tick;
        yield* follow(CARA, "anna");
        yield* tick;
        yield* ok(BEN, "PUT", `${at}/like`);
        yield* ok(ANNA, "PUT", `${at}/like`);
        yield* tick;
        yield* ok(CARA, "POST", `${at}/comments`, { body: "Strong" });
        const before = (yield* ok(ANNA, "GET", "/v1/inbox")).body;
        yield* ok(ANNA, "PUT", "/v1/inbox/read", { until: before.items[0].at });
        yield* ok(ANNA, "PUT", "/v1/inbox/read", { until: 0 });
        const after = (yield* ok(ANNA, "GET", "/v1/inbox")).body;
        yield* tick;
        yield* ok(BEN, "POST", `${at}/comments`, { body: "Same" });
        return {
          before,
          after,
          later: (yield* ok(ANNA, "GET", "/v1/inbox")).body,
          postId: (yield* ok(ANNA, "GET", "/v1/feed")).body.posts[0].activity.id,
        };
      }),
    );
    expect(inboxLines(result.before)).toEqual([
      ["comment", "cara", true, "Leg day"],
      ["like", "ben", true, "Leg day"],
      ["follow_request", "cara", true, undefined],
      ["follow", "ben", true, undefined],
    ]);
    expect(result.before.unread).toBe(4);
    expect(result.before.items[0].body).toBe("Strong");
    // An item opens its post by the ID the feed shows for it.
    expect(result.before.items[0].post.id).toBe(result.postId);
    expect(result.after.unread).toBe(0);
    expect(inboxLines(result.after).map((line: any) => line[2])).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(result.later.unread).toBe(1);
    expect(inboxLines(result.later)[0]).toEqual(["comment", "ben", true, "Leg day"]);
  });

  it("tells earlier commenters about a reply, and drops it once the post is no longer theirs to see", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        yield* follow(ANNA, "ben");
        const post = activity({ audience: "followers", title: "Tempo" });
        yield* write(BEN, [post]);
        const at = `/v1/posts/${yield* idOf(BEN, "ben", post.row.title)}`;
        yield* ok(ANNA, "POST", `${at}/comments`, { body: "First" });
        yield* ok(BEN, "POST", `${at}/comments`, { body: "Reply" });
        const following = kinds((yield* ok(ANNA, "GET", "/v1/inbox")).body);
        yield* ok(ANNA, "DELETE", "/v1/profiles/ben/follow");
        return { following, unfollowed: kinds((yield* ok(ANNA, "GET", "/v1/inbox")).body) };
      }),
    );
    expect(result.following).toEqual([["comment", "ben"]]);
    expect(result.unfollowed).toEqual([]);
  });

  it("fills a page and counts unread past items about posts the viewer may no longer see", async () => {
    const result = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        yield* follow(CARA, "anna");
        yield* follow(ANNA, "ben");
        const post = activity({ audience: "followers" });
        yield* write(BEN, [post]);
        const at = `/v1/posts/${yield* idOf(BEN, "ben", post.row.title)}/comments`;
        yield* ok(ANNA, "POST", at, { body: "First" });
        for (let index = 0; index <= INBOX_PAGE; index++) {
          yield* ok(BEN, "POST", at, { body: `Reply ${index}` });
        }
        const following = (yield* ok(ANNA, "GET", "/v1/inbox")).body;
        yield* ok(ANNA, "DELETE", "/v1/profiles/ben/follow");
        return { following, unfollowed: (yield* ok(ANNA, "GET", "/v1/inbox")).body };
      }),
    );
    expect(result.following.items).toHaveLength(INBOX_PAGE);
    expect(result.following.unread).toBe(INBOX_PAGE);
    expect(result.following.next).not.toBeNull();
    // Every reply is now hidden, and none of them shortens the page, ends it or places a cursor.
    expect(result.unfollowed).toMatchObject({ next: null, unread: 1 });
    expect(kinds(result.unfollowed)).toEqual([["follow", "cara"]]);
  });

  it("pages through more items than fit on one page", async () => {
    const pages = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        const post = activity();
        yield* write(ANNA, [post]);
        const at = `/v1/posts/${yield* idOf(ANNA, "anna", post.row.title)}/like`;
        for (let index = 0; index < INBOX_PAGE + 3; index++) {
          const account = `user_fan_${index}`;
          yield* name(account, `fan_${index}`);
          yield* ok(account, "PUT", at);
        }
        const first = (yield* ok(ANNA, "GET", "/v1/inbox")).body;
        const second = (yield* ok(ANNA, "GET", `/v1/inbox?cursor=${first.next}`)).body;
        return [first, second];
      }),
    );
    expect(pages.map((page) => page.items.length)).toEqual([INBOX_PAGE, 3]);
    expect(pages[1].next).toBeNull();
    const itemIds = pages.flatMap((page) => page.items.map((item: any) => item.id));
    expect(new Set(itemIds).size).toBe(INBOX_PAGE + 3);
    expect(itemIds.join(" ")).not.toContain("user_");
  });
});

describe("the feed proof script", { timeout: 60_000 }, () => {
  it("passes against a running server with the stand-in issuer", async () => {
    const lines: Array<string> = [];
    const server = (await routes()).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const { address } = yield* HttpServer.HttpServer;
        if (!("port" in address)) throw new Error("Expected a TCP address");
        yield* Effect.promise(() =>
          feedProof({
            server: `http://127.0.0.1:${address.port}`,
            token: (account) => issuer.sessionToken(account === "owner" ? ANNA : BEN),
            usernames: { owner: "feed_proof_a", follower: "feed_proof_b" },
            log: (line) => lines.push(line),
          }),
        );
      }).pipe(Effect.provide(server), Effect.scoped),
    );
    expect(lines.at(-1)).toBe("Deleted the proof's posts and ended both follows");
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^Lifting post: svett://post/${uuid}$`)),
        expect.stringMatching(new RegExp(`^Run: svett://post/${uuid}$`)),
      ]),
    );
  });
});
