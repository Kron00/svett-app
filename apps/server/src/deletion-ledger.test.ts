import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DeletionLedger, LEDGER_FILE, type LedgerEntry, readLedger } from "./deletion-ledger.ts";

const newDir = () => mkdtemp(join(tmpdir(), "svett-ledger-"));

const run = <A, E>(
  dir: string,
  effect: (ledger: typeof DeletionLedger.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(DeletionLedger), effect).pipe(
      Effect.provide(DeletionLedger.layer(dir)),
    ),
  );

const failure = <A, E>(
  dir: string,
  effect: (ledger: typeof DeletionLedger.Service) => Effect.Effect<A, E>,
) => run(dir, (ledger) => Effect.flip(effect(ledger)));

const entry = (account: string, at: number): LedgerEntry => ({ account, at, receipt: null });

const entriesIn = async (dir: string) =>
  Option.getOrThrow(await run(dir, (ledger) => ledger.read)).entries.map(({ account }) => account);

describe("the deletion ledger", () => {
  it("starts with a header that holds its ID, and makes only one ledger", async () => {
    const dir = await newDir();
    expect(await run(dir, (ledger) => ledger.read)).toEqual(Option.none());
    const [first, second] = await Promise.all([
      run(dir, (ledger) => ledger.create),
      run(dir, (ledger) => ledger.create),
    ]);
    expect(second).toBe(first);
    expect(await readFile(join(dir, LEDGER_FILE), "utf8")).toBe(`{"ledger":"${first}"}\n`);
  });

  it("cuts off a half-written last line before the next deletion, and keeps both deletions around it", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 1)));
    // A crash part way through an append leaves the start of a line, a deletion that never committed.
    await appendFile(join(dir, LEDGER_FILE), '{"account":"user_ben","at":2,"rec');
    expect(await entriesIn(dir)).toEqual(["user_anna"]);

    await run(dir, (ledger) => ledger.record(id, entry("user_cleo", 3)));

    expect(await entriesIn(dir)).toEqual(["user_anna", "user_cleo"]);
    const lines = (await readFile(join(dir, LEDGER_FILE), "utf8")).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toBe("");
    expect(lines.join("\n")).not.toContain("user_ben");
  });

  it("refuses a damaged line that is not the last, when it reads and when it appends", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 1)));
    await appendFile(
      join(dir, LEDGER_FILE),
      '{"account":"user_ben","at\n{"account":"user_cleo","at":3,"receipt":null}\n',
    );
    const text = await readFile(join(dir, LEDGER_FILE), "utf8");
    expect(readLedger(text)).toEqual({ damaged: "Line 3 is damaged." });

    expect((await failure(dir, (ledger) => ledger.read)).message).toContain(
      "is damaged. Line 3 is damaged. The server refuses to start, restore or delete an account",
    );
    expect(
      (await failure(dir, (ledger) => ledger.record(id, entry("user_dan", 4)))).message,
    ).toContain("Line 3 is damaged.");
    expect(await readFile(join(dir, LEDGER_FILE), "utf8")).toBe(text);
  });

  it("refuses a file without its header", async () => {
    const dir = await newDir();
    await writeFile(join(dir, LEDGER_FILE), '{"account":"user_anna","at":1,"receipt":null}\n');
    expect((await failure(dir, (ledger) => ledger.read)).message).toContain(
      "Line 1 is not the ledger's header.",
    );
  });

  it("appends only to the ledger the database names, and never makes one by appending", async () => {
    const dir = await newDir();
    expect(
      (await failure(dir, (ledger) => ledger.record("some-ledger", entry("user_anna", 1)))).message,
    ).toContain("is missing. Check that BACKUP_DIR is the backup volume");
    expect(await run(dir, (ledger) => ledger.read)).toEqual(Option.none());

    const id = await run(dir, (ledger) => ledger.create);
    expect(
      (await failure(dir, (ledger) => ledger.record("another-ledger", entry("user_anna", 1))))
        .message,
    ).toContain(
      `names deletion ledger another-ledger, but ${join(dir, LEDGER_FILE)} is ledger ${id}`,
    );
    expect(await entriesIn(dir)).toEqual([]);
  });
});
