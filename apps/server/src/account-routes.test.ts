import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AccountRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig, type ClerkConfigShape } from "./clerk-config.ts";
import { databaseLayer, migrate } from "./database.ts";
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

const ALICE = "user_alice";
const BOB = "user_bob";

/** An imported Hevy workout. Two people who import the same file get the same ID. */
const workout = (title: string, updatedAt: number) => ({
  id: "0190a0b2-0000-5000-8000-000000000001",
  updatedAt,
  deletedAt: null,
  kind: "strength",
  startedAt: 1_700_000_000_000,
  durationS: 3600,
  title,
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: "[]",
  source: "hevy",
  sourceId: "2026-01-05T18:00:00Z",
  fingerprint: "a".repeat(64),
  importBatchId: null,
});

const call = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    return { status: response.status, body: yield* response.json };
  });

/** Runs `steps` against a server on a fresh, migrated database. */
const withServer = async <A>(
  steps: Effect.Effect<A, unknown, HttpClient.HttpClient>,
  config?: ClerkConfigShape,
) => {
  const url = await postgres.createDatabase(`rows_${++databases}`);
  await Effect.runPromise(migrate.pipe(Effect.provide(databaseLayer(url))));
  const clerk = Layer.succeed(
    ClerkConfig,
    ClerkConfig.of(
      config ?? {
        signIn: "configured",
        issuer: issuer.issuer,
        jwksUrl: issuer.jwksUrl,
        authorizedParties: [],
        audience: undefined,
      },
    ),
  );
  const services = Layer.mergeAll(AccountRows.layer, Sessions.layer).pipe(
    Layer.provide(databaseLayer(url)),
    Layer.provide(clerk),
  );
  const server = HttpRouter.serve(AccountRoutes, {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(services));
  return Effect.runPromise(steps.pipe(Effect.provide(server)));
};

const as = (account: string, request: HttpClientRequest.HttpClientRequest) =>
  Effect.map(
    Effect.promise(() => issuer.sessionToken(account)),
    (token) => HttpClientRequest.bearerToken(request, token),
  );

const write = (account: string, body: unknown) =>
  as(account, HttpClientRequest.put("/v1/rows").pipe(HttpClientRequest.bodyJsonUnsafe(body)));

const read = (account: string) => as(account, HttpClientRequest.get("/v1/rows"));

describe("account ownership", { timeout: 60_000 }, () => {
  it("shows a second account none of the first account's history", async () => {
    const [alice, bob] = await withServer(
      Effect.gen(function* () {
        const stored = yield* call(
          yield* write(ALICE, { rows: [{ table: "activity", row: workout("Push", 1) }] }),
        );
        expect(stored).toEqual({ status: 200, body: { stored: 1 } });
        return [yield* call(yield* read(ALICE)), yield* call(yield* read(BOB))] as const;
      }),
    );
    expect(alice).toEqual({
      status: 200,
      body: { rows: [{ table: "activity", row: workout("Push", 1) }] },
    });
    expect(bob).toEqual({ status: 200, body: { rows: [] } });
  });

  it("changes only the writer's own row when another account holds the same ID", async () => {
    const [alice, bob] = await withServer(
      Effect.gen(function* () {
        yield* call(
          yield* write(ALICE, { rows: [{ table: "activity", row: workout("Alice's push", 1) }] }),
        );
        yield* call(
          yield* write(BOB, { rows: [{ table: "activity", row: workout("Bob's push", 1) }] }),
        );
        const edit = yield* call(
          yield* write(BOB, { rows: [{ table: "activity", row: workout("Bob renamed it", 2) }] }),
        );
        expect(edit).toEqual({ status: 200, body: { stored: 1 } });
        return [yield* call(yield* read(ALICE)), yield* call(yield* read(BOB))] as const;
      }),
    );
    expect(alice.body).toEqual({ rows: [{ table: "activity", row: workout("Alice's push", 1) }] });
    expect(bob.body).toEqual({ rows: [{ table: "activity", row: workout("Bob renamed it", 2) }] });
  });

  it("stores a write that names a different owner under the signed-in account", async () => {
    const [alice, bob] = await withServer(
      Effect.gen(function* () {
        const forged = {
          accountId: BOB,
          owner: BOB,
          rows: [
            {
              table: "activity",
              accountId: BOB,
              owner: BOB,
              row: { ...workout("Forged", 1), accountId: BOB, ownerId: BOB },
            },
          ],
        };
        expect(yield* call(yield* write(ALICE, forged))).toEqual({
          status: 200,
          body: { stored: 1 },
        });
        return [yield* call(yield* read(ALICE)), yield* call(yield* read(BOB))] as const;
      }),
    );
    expect(alice.body).toEqual({ rows: [{ table: "activity", row: workout("Forged", 1) }] });
    expect(bob.body).toEqual({ rows: [] });
  });

  it("keeps the newer copy when an older one arrives later", async () => {
    const rows = await withServer(
      Effect.gen(function* () {
        yield* call(
          yield* write(ALICE, { rows: [{ table: "activity", row: workout("Newer", 5) }] }),
        );
        yield* call(
          yield* write(ALICE, { rows: [{ table: "activity", row: workout("Older", 4) }] }),
        );
        return yield* call(yield* read(ALICE));
      }),
    );
    expect(rows.body).toEqual({ rows: [{ table: "activity", row: workout("Newer", 5) }] });
  });

  it("refuses a request without a valid session", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        const forged = yield* Effect.promise(() =>
          issuer.sessionToken(ALICE, { key: "unpublished" }),
        );
        return [
          yield* call(HttpClientRequest.get("/v1/rows")),
          yield* call(HttpClientRequest.get("/v1/me")),
          yield* call(HttpClientRequest.bearerToken(HttpClientRequest.get("/v1/rows"), forged)),
          yield* call(
            HttpClientRequest.put("/v1/rows").pipe(
              HttpClientRequest.bodyJsonUnsafe({
                rows: [{ table: "activity", row: workout("x", 1) }],
              }),
            ),
          ),
        ];
      }),
    );
    for (const answer of answers) {
      expect(answer).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
  });

  it("refuses a session token from an origin the server does not trust", async () => {
    const answer = await withServer(
      Effect.gen(function* () {
        const token = yield* Effect.promise(() =>
          issuer.sessionToken(ALICE, { claims: { azp: "https://evil.example" } }),
        );
        return yield* call(HttpClientRequest.bearerToken(HttpClientRequest.get("/v1/me"), token));
      }),
    );
    expect(answer).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("answers that sign-in is unavailable on every account route while it is off", async () => {
    const answers = await withServer(
      Effect.gen(function* () {
        const token = yield* Effect.promise(() => issuer.sessionToken(ALICE));
        const signed = (request: HttpClientRequest.HttpClientRequest) =>
          call(HttpClientRequest.bearerToken(request, token));
        return [
          yield* call(HttpClientRequest.get("/v1/me")),
          yield* signed(HttpClientRequest.get("/v1/me")),
          yield* signed(HttpClientRequest.get("/v1/rows")),
          yield* signed(
            HttpClientRequest.put("/v1/rows").pipe(
              HttpClientRequest.bodyJsonUnsafe({
                rows: [{ table: "activity", row: workout("x", 1) }],
              }),
            ),
          ),
        ];
      }),
      { signIn: "unconfigured", reason: "CLERK_PUBLISHABLE_KEY is not set." },
    );
    expect(answers).toEqual(
      answers.map(() => ({
        status: 503,
        body: { error: "sign_in_unavailable", message: expect.stringContaining("not set up") },
      })),
    );
  });

  it("refuses rows that break their table's schema, and stores none of the request", async () => {
    const [answer, rows] = await withServer(
      Effect.gen(function* () {
        const refused = yield* call(
          yield* write(ALICE, {
            rows: [
              { table: "activity", row: workout("Fine", 1) },
              { table: "activity", row: { ...workout("Bad", 1), kind: "swim" } },
            ],
          }),
        );
        return [refused, yield* call(yield* read(ALICE))] as const;
      }),
    );
    expect(answer).toEqual({
      status: 400,
      body: { error: "invalid_row", table: "activity", index: 1, message: expect.any(String) },
    });
    expect(rows.body).toEqual({ rows: [] });
  });

  it("refuses a table svett does not have", async () => {
    const answer = await withServer(
      Effect.flatMap(write(ALICE, { rows: [{ table: "account", row: {} }] }), call),
    );
    expect(answer).toEqual({
      status: 400,
      body: { error: "invalid_request", message: expect.any(String) },
    });
  });

  it("names the signed-in account", async () => {
    const answer = await withServer(
      Effect.flatMap(as(ALICE, HttpClientRequest.get("/v1/me")), call),
    );
    expect(answer).toEqual({ status: 200, body: { accountId: ALICE } });
  });
});
