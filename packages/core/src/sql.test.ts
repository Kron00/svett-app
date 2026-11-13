import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { nodeSqliteDriver } from "./node-sqlite.ts";
import { Sql } from "./sql.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const run = <A, E>(database: DatabaseSync, effect: Effect.Effect<A, E, Sql>) =>
  Effect.runPromiseExit(Effect.provide(effect, Sql.layer(nodeSqliteDriver(database))));

const insert = (body: string) =>
  Effect.flatMap(Effect.service(Sql), (sql) =>
    sql.transaction(sql.run("INSERT INTO note (body) VALUES (?)", [body])),
  );

describe("Sql.transaction", () => {
  it("rolls back a transaction whose COMMIT fails and keeps working", async () => {
    const directory = mkdtempSync(join(tmpdir(), "svett-sql-"));
    directories.push(directory);
    const path = join(directory, "locked.db");
    const writer = new DatabaseSync(path);
    const reader = new DatabaseSync(path);
    writer.exec("CREATE TABLE note (body TEXT NOT NULL)");

    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM note").all();
    expect(await run(writer, Effect.flip(insert("lost")))).toEqual(
      Exit.succeed(expect.objectContaining({ _tag: "SqlError", sql: "COMMIT" })),
    );
    reader.exec("COMMIT");

    expect(await run(writer, insert("kept"))).toEqual(Exit.void);
    expect(reader.prepare("SELECT body FROM note").all()).toEqual([{ body: "kept" }]);
    expect(writer.prepare("SELECT body FROM note").all()).toEqual([{ body: "kept" }]);
  });
});
