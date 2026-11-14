import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Layer, Redacted } from "effect";
import * as Migrator from "effect/sql/Migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { prepareDatabase } from "./account-deletion.ts";
import { databaseLayer } from "./database.ts";
import { DeletionLedger, LEDGER_FILE, readLedger } from "./deletion-ledger.ts";
import { MIGRATIONS } from "./migrations.ts";
import { PgTools } from "./pg-tools.ts";
import { restoreBackup, restoreForUse } from "./restore.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { query, rowsNaming, startTestPostgres, type TestPostgres } from "./test-postgres.ts";

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

const pgTools = () => PgTools.layer(postgres.tools);

/** Readies `url` the way the server does on start, with the ledger in `dir`. */
const start = (url: Redacted.Redacted, dir: string) =>
  Effect.runPromise(
    prepareDatabase.pipe(
      Effect.provide(Layer.merge(databaseLayer(url), DeletionLedger.layer(dir))),
    ),
  );

const restore = async (backup: string, dir: string) =>
  Effect.runPromise(
    restoreForUse(backup, await postgres.createDatabase(`main_${++databases}`)).pipe(
      Effect.provide(Layer.merge(pgTools(), DeletionLedger.layer(dir))),
    ),
  );

const backUp = async (url: Redacted.Redacted, dir: string) => {
  const backup = join(dir, `backup-${++databases}.dump`);
  await Effect.runPromise(
    Effect.flatMap(Effect.service(PgTools), (pg) => pg.dump(url, backup)).pipe(
      Effect.provide(pgTools()),
    ),
  );
  return backup;
};
/** Records the deletion of `account` in the ledger in `dir`, as a deletion does. */
const recordDeletion = (url: Redacted.Redacted, dir: string, account: string) =>
  query<{ id: string }>(url, "select id from deletion_ledger").then(([named]) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(DeletionLedger), (ledger) =>
        ledger.record(named!.id, { account, at: 1, receipt: null }),
      ).pipe(Effect.provide(DeletionLedger.layer(dir))),
    ),
  );

const ledgerId = async (dir: string) => {
  const ledger = readLedger(await readFile(join(dir, LEDGER_FILE), "utf8"));
  return "id" in ledger ? ledger.id : undefined;
};

const nothingLeft = (rows: Record<string, number>) =>
  Object.values(rows).every((count) => count === 0);

describe("the deletion ledger", { timeout: 120_000 }, () => {
  it("deletes an account again after a restore from a backup taken before its deletion, past a line a crash cut short", async () => {
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
    // A crash part way through an earlier append left the start of a line that never committed.
    const ledgerFile = join(backupDir, LEDGER_FILE);
    await appendFile(ledgerFile, '{"account":"user_never_deleted","at":1,"rec');
    const receipt = "c".repeat(64);
    expect(await first.call("DELETE", "/v1/me", held, { receipt })).toEqual({
      status: 200,
      body: { deleted: true },
    });
    first.stop();
    expect(first.output()).toContain("Cut off the half-written last line");
    const ledger = readLedger(await readFile(ledgerFile, "utf8"));
    expect("entries" in ledger && ledger.entries.map(({ account }) => account)).toEqual([anna]);

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

  it("makes a ledger for a new server, and records its ID in the database", async () => {
    const url = await postgres.createDatabase(`main_${++databases}`);
    const dir = await mkdtemp(join(tmpdir(), "svett-main-"));
    expect(await start(url, dir)).toBe(0);
    const id = await ledgerId(dir);
    expect(id).toEqual(expect.any(String));
    expect(await query(url, "select id from deletion_ledger")).toEqual([{ id }]);
    expect(await start(url, dir)).toBe(0);
    expect(await ledgerId(dir)).toBe(id);
  });

  it("makes a ledger on the deployed server's first start after the ledger had an ID", async () => {
    const url = await postgres.createDatabase(`main_${++databases}`);
    const dir = await mkdtemp(join(tmpdir(), "svett-main-"));
    // The deployed server has only main's migrations, and no ledger.
    await Effect.runPromise(
      Migrator.make({})({
        loader: Migrator.fromRecord({ "1_accounts": MIGRATIONS["1_accounts"]! }),
      }).pipe(Effect.provide(databaseLayer(url))),
    );
    await query(url, "insert into account (id) values ('user_deployed')");

    expect(await start(url, dir)).toBe(0);

    const id = await ledgerId(dir);
    expect(await query(url, "select id from deletion_ledger")).toEqual([{ id }]);
    expect(await query(url, "select id from account")).toEqual([{ id: "user_deployed" }]);
  });

  it("refuses a start and a restore without the ledger the database names", async () => {
    const url = await postgres.createDatabase(`main_${++databases}`);
    const dir = await mkdtemp(join(tmpdir(), "svett-main-"));
    await start(url, dir);
    await query(url, "insert into account (id) values ('user_gone')");
    const backup = await backUp(url, dir);
    await recordDeletion(url, dir, "user_gone");
    const id = await ledgerId(dir);

    const empty = await mkdtemp(join(tmpdir(), "svett-main-"));
    const missing = `The database names deletion ledger ${id}, but ${join(empty, LEDGER_FILE)} is missing. Check that BACKUP_DIR is the backup volume and that it is mounted.`;
    await expect(start(url, empty)).rejects.toThrow(missing);
    await expect(restore(backup, empty)).rejects.toThrow(missing);
    await expect(
      startServer({ DATABASE_URL: Redacted.value(url), BACKUP_DIR: empty }),
    ).rejects.toThrow(missing);

    const other = await mkdtemp(join(tmpdir(), "svett-main-"));
    await start(await postgres.createDatabase(`main_${++databases}`), other);
    const another = `but ${join(other, LEDGER_FILE)} is ledger ${await ledgerId(other)}. Check that BACKUP_DIR is this server's backup volume.`;
    await expect(start(url, other)).rejects.toThrow(another);
    await expect(restore(backup, other)).rejects.toThrow(another);

    expect(await restore(backup, dir)).toBe(1);
    expect(await start(url, dir)).toBe(1);
    expect(await query(url, "select id from account")).toEqual([]);
  });

  it("refuses a start and a restore when a line before the last is damaged", async () => {
    const url = await postgres.createDatabase(`main_${++databases}`);
    const dir = await mkdtemp(join(tmpdir(), "svett-main-"));
    await start(url, dir);
    const backup = await backUp(url, dir);
    await appendFile(
      join(dir, LEDGER_FILE),
      '{"account":"user_a\n{"account":"user_b","at":2,"receipt":null}\n',
    );

    const damaged = "is damaged. Line 2 is damaged. The server refuses to start, restore";
    await expect(start(url, dir)).rejects.toThrow(damaged);
    await expect(restore(backup, dir)).rejects.toThrow(damaged);
  });
});
