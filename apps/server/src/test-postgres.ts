import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import { Redacted } from "effect";

import type { PgToolCommands } from "./pg-tools.ts";

const exec = promisify(execFile);

/**
 * The tests pair the versions the deployment runs: Coolify's PostgreSQL 16, and the
 * client tools the Dockerfile installs. Change all three together.
 */
export const TEST_POSTGRES_IMAGE = process.env.SVETT_TEST_POSTGRES_IMAGE ?? "postgres:16-alpine";
export const TEST_PG_TOOLS_IMAGE = process.env.SVETT_TEST_PG_TOOLS_IMAGE ?? "postgres:16-alpine";

export interface TestPostgres {
  /** The address of database `name` on the test server, password included. */
  readonly url: (name: string) => Redacted.Redacted;
  readonly createDatabase: (name: string) => Promise<Redacted.Redacted>;
  /** pg_dump and pg_restore run from an image, so no PostgreSQL install is needed. */
  readonly tools: PgToolCommands;
  readonly stop: () => Promise<void>;
}

const docker = async (...args: Array<string>) => (await exec("docker", args)).stdout.trim();

/** Starts a throwaway PostgreSQL in Docker on a free local port. */
export const startTestPostgres = async (): Promise<TestPostgres> => {
  // Characters that must be escaped in a URL prove the password reaches the tools intact.
  const password = `pw/${randomBytes(6).toString("hex")}:@%`;
  const container = await docker(
    "run",
    "--detach",
    "--rm",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--publish",
    "127.0.0.1::5432",
    TEST_POSTGRES_IMAGE,
  );
  const stop = async () => {
    await docker("rm", "--force", container).catch(() => undefined);
  };
  try {
    const port = (await docker("port", container, "5432/tcp")).split(":").pop();
    const url = (name: string) =>
      Redacted.make(
        `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${name}`,
      );
    const psql = (sql: string) =>
      docker("exec", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql);

    const deadline = Date.now() + 60_000;
    // The image restarts PostgreSQL once after its first setup, so wait for a
    // query to work rather than for the first sign of life.
    const waitUntilReady = async (): Promise<void> => {
      const ready = await docker(
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      )
        .then(() => psql("select 1"))
        .then(() => true)
        .catch(() => false);
      if (ready) return;
      if (Date.now() > deadline) throw new Error("PostgreSQL did not start within a minute");
      await new Promise((resolve) => setTimeout(resolve, 250));
      return waitUntilReady();
    };
    await waitUntilReady();

    const tool = (name: string) => [
      "docker",
      "run",
      "--rm",
      "--interactive",
      "--network",
      "host",
      "--env",
      "PGPASSWORD",
      TEST_PG_TOOLS_IMAGE,
      name,
    ];

    return {
      url,
      createDatabase: async (name) => {
        await psql(`create database "${name}"`);
        return url(name);
      },
      tools: { pgDump: tool("pg_dump"), pgRestore: tool("pg_restore") },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
