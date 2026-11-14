import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Redacted } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { connectionFor, PgTools } from "./pg-tools.ts";

describe("connectionFor", () => {
  it("keeps the password out of the address the tools see on their command line", () => {
    expect(
      connectionFor(
        Redacted.make("postgres://svett:p%40ss%2Fw%3Ard@db:5432/svett?sslmode=disable"),
      ),
    ).toEqual({ dbname: "postgres://svett@db:5432/svett?sslmode=disable", password: "p@ss/w:rd" });
  });

  it("leaves the password unset when the address has none", () => {
    expect(connectionFor(Redacted.make("postgres://svett@db/svett"))).toEqual({
      dbname: "postgres://svett@db/svett",
      password: undefined,
    });
  });
});

describe("PgTools.dump", () => {
  const url = Redacted.make("postgres://svett@db/svett");
  const dumpWith = (script: string, file: string) =>
    Effect.runPromiseExit(
      Effect.flatMap(Effect.service(PgTools), (tools) => tools.dump(url, file)).pipe(
        Effect.provide(PgTools.layer({ pgDump: ["sh", "-c", script, "sh"], pgRestore: [] })),
      ),
    );

  it("removes the file it made when the dump fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svett-pg-tools-"));
    const exit = await dumpWith("echo half a dump; exit 3", join(dir, "out.partial"));
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("exited with 3");
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a file that exists and leaves it as it was", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svett-pg-tools-"));
    const file = join(dir, "out.partial");
    await writeFile(file, "another run's dump");
    const exit = await dumpWith("echo a dump", file);
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("could not open its file");
    expect(await readFile(file, "utf8")).toBe("another run's dump");
  });
});
