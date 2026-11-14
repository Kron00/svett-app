import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AccountRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { databaseLayer, migrate } from "./database.ts";
import { socialProof } from "./social-proof.ts";
import { SocialRoutes } from "./social-routes.ts";
import { SocialRows } from "./social-rows.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { startTestPostgres, type TestPostgres } from "./test-postgres.ts";

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
  const services = Layer.mergeAll(AccountRows.layer, SocialRows.layer, Sessions.layer).pipe(
    Layer.provide(databaseLayer(url)),
    Layer.provide(clerk),
  );
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

const write = (account: string, rows: ReadonlyArray<ReturnType<typeof activity>>) =>
  body(as(account, "PUT", "/v1/rows", { rows: rows.map((row) => ({ table: "activity", row })) }));

type Seen = { readonly activities: ReadonlyArray<{ readonly title: string }> };
const titles = (viewer: string, username: string) =>
  Effect.map(body<Seen>(as(viewer, "GET", `/v1/profiles/${username}`)), (profile) =>
    profile.activities.map(({ title }) => title),
  );

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
    const own = (username: string | null, isPrivate: boolean) => ({
      status: 200,
      body: { username, private: isPrivate, followers: 0, following: 0, requests: 0 },
    });
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
        yield* body(as(BEN, "PUT", "/v1/follow-requests/cara"));
        const benAfter = yield* body(as(CARA, "GET", "/v1/profiles/ben"));
        const followers = yield* body(as(ANNA, "GET", "/v1/profiles/ben/followers"));
        const following = yield* body(as(ANNA, "GET", "/v1/profiles/cara/following"));
        const own = yield* body(as(BEN, "GET", "/v1/profile"));
        return {
          publicFollow,
          privateFollow,
          again,
          requests,
          benBefore,
          benAfter,
          followers,
          following,
          own,
        };
      }),
    );
    expect(result).toMatchObject({
      publicFollow: { follow: "following" },
      privateFollow: { follow: "requested" },
      again: { follow: "requested" },
      requests: { profiles: [{ username: "cara", private: true, follow: "none" }] },
      benBefore: { followers: 0, follow: "requested" },
      benAfter: { followers: 1, follow: "following", self: false, followsYou: false },
      followers: { profiles: [{ username: "cara", private: true, follow: "none" }] },
      following: {
        profiles: [
          { username: "anna", private: false, follow: "none" },
          { username: "ben", private: true, follow: "none" },
        ],
      },
      own: { username: "ben", followers: 1, following: 0, requests: 0 },
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
        yield* body(as(ANNA, "DELETE", "/v1/follow-requests/ben"));
        const declinedAgain = yield* as(ANNA, "DELETE", "/v1/follow-requests/ben");
        const approveDeclined = yield* as(ANNA, "PUT", "/v1/follow-requests/ben");
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
      declinedAgain: { status: 404, body: { error: "not_found" } },
      approveDeclined: { status: 404, body: { error: "not_found" } },
      withdrawn: { follow: "none" },
      left: { profiles: [] },
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

describe("a profile's activities", { timeout: 60_000 }, () => {
  it("shows each viewer what the privacy rule allows, newest first", async () => {
    const seen = await withServer(
      Effect.gen(function* () {
        yield* name(ANNA, "anna");
        yield* name(BEN, "ben");
        yield* name(CARA, "cara");
        yield* write(ANNA, [
          activity("everyone"),
          activity("followers"),
          activity("only_you"),
          activity("followers", [], { deletedAt: 5, updatedAt: 5 }),
        ]);
        yield* body(as(BEN, "PUT", "/v1/profiles/anna/follow"));
        yield* body(as(CARA, "PUT", "/v1/profiles/anna/follow"));
        const requested = yield* titles(BEN, "anna");
        yield* body(as(ANNA, "PUT", "/v1/follow-requests/ben"));
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
        id: hidden.id,
        kind: "run",
        startedAt: null,
        durationS: 1800,
        title: hidden.title,
        notes: "",
        energyKcal: null,
        hiddenFields: ["start_time", "calories"],
      },
    ]);
    const sent = JSON.stringify(other);
    expect(sent).not.toContain(String(hidden.startedAt));
    expect(sent).not.toContain("410");
    expect(sent).not.toContain("audience");
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
