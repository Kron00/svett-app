import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { Backups } from "./backups.ts";
import { ClerkConfig, type ClerkConfigShape } from "./clerk-config.ts";
import { ServerConfig } from "./config.ts";
import { databaseLayer, migrate } from "./database.ts";
import { Routes } from "./http.ts";
import { PgTools } from "./pg-tools.ts";
import { startTestPostgres, type TestPostgres } from "./test-postgres.ts";

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startTestPostgres();
}, 120_000);

afterAll(async () => {
  await postgres?.stop();
});

const getHealth = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("/health");
  return { status: response.status, body: yield* response.json };
});

const SIGN_IN_ON: ClerkConfigShape = {
  signIn: "configured",
  issuer: "https://clerk.svett.example",
  jwksUrl: "https://clerk.svett.example/.well-known/jwks.json",
  authorizedParties: [],
  audience: undefined,
};

const serve = (url: Redacted.Redacted, backupDir: string, clerk: ClerkConfigShape = SIGN_IN_ON) => {
  const config = Layer.succeed(
    ServerConfig,
    ServerConfig.of({
      port: 0,
      databaseUrl: url,
      backupDir,
      backupKeep: 14,
      backupCron: "0 3 * * *",
    }),
  );
  const services = Layer.mergeAll(
    databaseLayer(url),
    Backups.layer.pipe(Layer.provide(PgTools.layer(postgres.tools))),
    Layer.succeed(ClerkConfig, clerk),
  ).pipe(Layer.provide(config));
  return HttpRouter.serve(Routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(services),
  );
};

describe("GET /health", { timeout: 60_000 }, () => {
  it("answers ok with the time of the newest backup", async () => {
    const url = await postgres.createDatabase("health_ok");
    await Effect.runPromise(migrate.pipe(Effect.provide(databaseLayer(url))));
    const dir = await mkdtemp(join(tmpdir(), "svett-health-"));

    const [before, backup, after] = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* getHealth;
        const backups = yield* Effect.service(Backups);
        const taken = yield* backups.takeNow;
        yield* backups.checkRestore(taken);
        return [first, taken, yield* getHealth] as const;
      }).pipe(Effect.provide(serve(url, dir))),
    );

    expect(before).toEqual({
      status: 200,
      body: {
        status: "ok",
        database: "ok",
        signIn: "configured",
        latestBackup: null,
        restoreCheck: null,
      },
    });
    expect(after).toEqual({
      status: 200,
      body: {
        status: "ok",
        database: "ok",
        signIn: "configured",
        latestBackup: new Date(backup.takenAt).toISOString(),
        restoreCheck: {
          backup: new Date(backup.takenAt).toISOString(),
          checkedAt: expect.any(String),
          restored: true,
          tables: 9,
        },
      },
    });
  });

  it("answers 503 when the database cannot be reached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svett-health-"));
    const unreachable = Redacted.make("postgres://postgres:x@127.0.0.1:1/none");
    const health = await Effect.runPromise(getHealth.pipe(Effect.provide(serve(unreachable, dir))));
    expect(health).toEqual({
      status: 503,
      body: {
        status: "error",
        database: "unreachable",
        signIn: "configured",
        latestBackup: null,
        restoreCheck: null,
      },
    });
  });

  it("says when sign-in is off, and stays healthy", async () => {
    const url = await postgres.createDatabase("health_sign_in_off");
    const dir = await mkdtemp(join(tmpdir(), "svett-health-"));
    const health = await Effect.runPromise(
      getHealth.pipe(
        Effect.provide(
          serve(url, dir, { signIn: "unconfigured", reason: "CLERK_PUBLISHABLE_KEY is not set." }),
        ),
      ),
    );
    expect(health).toEqual({
      status: 200,
      body: expect.objectContaining({ status: "ok", signIn: "unconfigured" }),
    });
  });
});
