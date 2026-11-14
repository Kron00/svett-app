import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Layer, Redacted } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { DeletionLedger } from "./deletion-ledger.ts";
import { PgTools } from "./pg-tools.ts";
import { restoreBackup, restoreForUse } from "./restore.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { rowsNaming, startTestPostgres, type TestPostgres } from "./test-postgres.ts";

let postgres: TestPostgres;
let issuer: StandInIssuer;
let databases = 0;
const running: Array<ChildProcess> = [];

beforeAll(async () => {
  [postgres, issuer] = await Promise.all([startTestPostgres(), startStandInIssuer()]);
}, 120_000);

afterEach(() => {
  for (const server of running.splice(0)) server.kill("SIGKILL");
});

afterAll(async () => {
  await Promise.all([postgres?.stop(), issuer?.stop()]);
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

/** Starts `main.ts` the way the container does, with `env` on top of a database and a port. */
const startServer = async (env: Record<string, string>) => {
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DATABASE_URL: Redacted.value(await postgres.createDatabase(`main_${++databases}`)),
      BACKUP_DIR: await mkdtemp(join(tmpdir(), "svett-main-")),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(server);
  let output = "";
  server.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  server.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  const waitUntilUp = async (): Promise<void> => {
    if (server.exitCode !== null) {
      throw new Error(`The server exited with ${server.exitCode}:\n${output}`);
    }
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) }).catch(
      () => undefined,
    );
    if (health !== undefined) return;
    if (Date.now() > deadline) throw new Error(`The server did not answer:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return waitUntilUp();
  };
  await waitUntilUp();

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const sent = body ?? (method === "PUT" ? { rows: [] } : undefined);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(sent === undefined ? {} : { body: JSON.stringify(sent) }),
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new Error(`${method} ${path} got no answer: ${String(error)}\n${output}`);
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  return { call, output: () => output, stop: () => server.kill("SIGKILL") };
};

const SIGN_IN_UNAVAILABLE = {
  status: 503,
  body: { error: "sign_in_unavailable", message: expect.stringContaining("not set up") },
};

describe("the production server", { timeout: 90_000 }, () => {
  it("starts with sign-in off when the Clerk keys are missing", async () => {
    const server = await startServer({ NODE_ENV: "production" });
    const token = await issuer.sessionToken("user_alice");

    const health = await server.call("GET", "/health");
    expect(health).toEqual({
      status: 200,
      body: expect.objectContaining({ status: "ok", database: "ok", signIn: "unconfigured" }),
    });
    expect([
      await server.call("GET", "/v1/me"),
      await server.call("GET", "/v1/me", token),
      await server.call("GET", "/v1/rows", token),
      await server.call("PUT", "/v1/rows", token),
    ]).toEqual([
      SIGN_IN_UNAVAILABLE,
      SIGN_IN_UNAVAILABLE,
      SIGN_IN_UNAVAILABLE,
      SIGN_IN_UNAVAILABLE,
    ]);
    expect(server.output()).toContain("Sign-in is off. CLERK_PUBLISHABLE_KEY is not set");
  });

  it("never accepts a token from the stand-in issuer", async () => {
    const server = await startServer({
      NODE_ENV: "production",
      CLERK_ISSUER: issuer.issuer,
      CLERK_JWKS_URL: issuer.jwksUrl,
    });
    const token = await issuer.sessionToken("user_alice");

    expect((await server.call("GET", "/health")).body).toEqual(
      expect.objectContaining({ signIn: "unconfigured" }),
    );
    expect(await server.call("GET", "/v1/me", token)).toEqual(SIGN_IN_UNAVAILABLE);
  });

  it("accepts the stand-in issuer outside production", async () => {
    const server = await startServer({
      NODE_ENV: "development",
      CLERK_ISSUER: issuer.issuer,
      CLERK_JWKS_URL: issuer.jwksUrl,
    });
    const token = await issuer.sessionToken("user_alice");

    expect((await server.call("GET", "/health")).body).toEqual(
      expect.objectContaining({ signIn: "configured" }),
    );
    expect(await server.call("GET", "/v1/me", token)).toEqual({
      status: 200,
      body: { accountId: "user_alice" },
    });
  });
});

const nothingLeft = (rows: Record<string, number>) =>
  Object.values(rows).every((count) => count === 0);

describe("the deletion ledger", { timeout: 120_000 }, () => {
  it("deletes an account again after a restore from a backup taken before its deletion", async () => {
    const n = ++databases;
    const live = await postgres.createDatabase(`main_${n}`);
    const backupDir = await mkdtemp(join(tmpdir(), "svett-main-"));
    const env = {
      NODE_ENV: "development",
      CLERK_ISSUER: issuer.issuer,
      CLERK_JWKS_URL: issuer.jwksUrl,
      CLERK_SECRET_KEY: issuer.secretKey,
      CLERK_API_URL: issuer.apiUrl,
      DATABASE_URL: Redacted.value(live),
      BACKUP_DIR: backupDir,
    };
    const [anna, ben] = [`user_ledger_anna_${n}`, `user_ledger_ben_${n}`];
    const [held, bens] = await Promise.all([issuer.sessionToken(anna), issuer.sessionToken(ben)]);
    const first = await startServer(env);
    await first.call("PUT", "/v1/profile", held, { username: `anna${n}`, private: false });
    await first.call("PUT", "/v1/profile", bens, { username: `ben${n}`, private: false });
    await first.call("PUT", "/v1/rows", held, {
      rows: [
        {
          table: "activity",
          row: {
            id: "0190a0b2-0000-7000-8000-000000000001",
            updatedAt: 1,
            deletedAt: null,
            kind: "run",
            startedAt: 1_790_000_000_000,
            durationS: 1800,
            title: "Anna's run",
            notes: "",
            energyKcal: null,
            audience: "everyone",
            hiddenFields: "[]",
            source: "svett",
            sourceId: null,
            fingerprint: null,
            importBatchId: null,
          },
        },
      ],
    });
    await first.call("PUT", `/v1/profiles/anna${n}/follow`, bens, {});
    await first.call("PUT", `/v1/profiles/ben${n}/follow`, held, {});
    const before = await rowsNaming(live, anna);
    expect(before).toMatchObject({ account: 1, account_row: 1, profile: 1, follow: 2 });

    const backup = join(backupDir, "before-the-deletion.dump");
    const tools = PgTools.layer(postgres.tools);
    await Effect.runPromise(
      Effect.flatMap(Effect.service(PgTools), (pg) => pg.dump(live, backup)).pipe(
        Effect.provide(tools),
      ),
    );
    const receipt = "c".repeat(64);
    expect(await first.call("DELETE", "/v1/me", held, { receipt })).toEqual({
      status: 200,
      body: { deleted: true },
    });
    first.stop();

    // `cli.ts restore` deletes the account again as it restores.
    const restored = await postgres.createDatabase(`main_${++databases}`);
    const again = await Effect.runPromise(
      restoreForUse(backup, restored).pipe(
        Effect.provide(Layer.merge(tools, DeletionLedger.layer(backupDir))),
      ),
    );
    expect(again).toBe(1);
    expect(nothingLeft(await rowsNaming(restored, anna))).toBe(true);

    // A restore by hand brings the account back, until the server starts on it.
    const byHand = await postgres.createDatabase(`main_${++databases}`);
    await Effect.runPromise(restoreBackup(backup, byHand).pipe(Effect.provide(tools)));
    expect(await rowsNaming(byHand, anna)).toEqual(before);
    const restarted = await startServer({ ...env, DATABASE_URL: Redacted.value(byHand) });

    expect(nothingLeft(await rowsNaming(byHand, anna))).toBe(true);
    expect(await restarted.call("GET", "/v1/me", held)).toEqual({
      status: 410,
      body: { error: "account_deleted", message: expect.any(String) },
    });
    expect(await restarted.call("GET", `/v1/deletions/${receipt}`)).toEqual({
      status: 200,
      body: { deleted: true },
    });
    expect((await restarted.call("GET", `/v1/profiles/ben${n}`, bens)).body).toMatchObject({
      followers: 0,
      following: 0,
    });
    expect(restarted.output()).toContain("Deleted 1 accounts again from the deletion ledger");
  });
});
