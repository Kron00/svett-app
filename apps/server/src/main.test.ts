import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Redacted } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { startTestPostgres, type TestPostgres } from "./test-postgres.ts";

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

  const call = async (method: string, path: string, token?: string) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(method === "PUT" ? { body: JSON.stringify({ rows: [] }) } : {}),
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new Error(`${method} ${path} got no answer: ${String(error)}\n${output}`);
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  return { call, output: () => output };
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
