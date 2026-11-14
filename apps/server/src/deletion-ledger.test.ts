import { spawn } from "node:child_process";
import { access, appendFile, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  DeletionLedger,
  LEDGER_FILE,
  LEDGER_LOCK_STALE_MS,
  type LedgerEntry,
  type LedgerOptions,
  type LedgerWrite,
  readLedger,
} from "./deletion-ledger.ts";

const newDir = () => mkdtemp(join(tmpdir(), "svett-ledger-"));

const run = <A, E>(
  dir: string,
  effect: (ledger: typeof DeletionLedger.Service) => Effect.Effect<A, E>,
  options?: LedgerOptions,
) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(DeletionLedger), effect).pipe(
      Effect.provide(DeletionLedger.layer(dir, options)),
    ),
  );

const failure = <A, E>(
  dir: string,
  effect: (ledger: typeof DeletionLedger.Service) => Effect.Effect<A, E>,
  options?: LedgerOptions,
) => run(dir, (ledger) => Effect.flip(effect(ledger)), options);

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

  it("writes the whole line when each write stores only a few bytes of it", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    const pieces: Array<number> = [];
    const fewBytes: LedgerWrite = async (file, bytes, offset, length) => {
      const stored = await file.write(bytes, offset, Math.min(length, 4));
      pieces.push(stored.bytesWritten);
      return stored;
    };

    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 1)), { write: fewBytes });
    await run(dir, (ledger) => ledger.record(id, entry("user_ben", 2)), { write: fewBytes });

    expect(pieces.length).toBeGreaterThan(20);
    expect(await entriesIn(dir)).toEqual(["user_anna", "user_ben"]);
    expect(await readFile(join(dir, LEDGER_FILE), "utf8")).toBe(
      `{"ledger":"${id}"}\n{"account":"user_anna","at":1,"receipt":null}\n{"account":"user_ben","at":2,"receipt":null}\n`,
    );
  });

  it("fails a deletion whose write stalls, and the next append cuts off the half line", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    let calls = 0;
    const stalls: LedgerWrite = (file, bytes, offset, length) =>
      ++calls === 1
        ? file.write(bytes, offset, Math.min(length, 10))
        : Promise.resolve({ bytesWritten: 0 });

    const stalled = await failure(dir, (ledger) => ledger.record(id, entry("user_anna", 1)), {
      write: stalls,
    });

    expect(stalled.message).toContain("A write stored nothing after 10 of");
    expect(await entriesIn(dir)).toEqual([]);
    await run(dir, (ledger) => ledger.record(id, entry("user_ben", 2)));
    expect(await entriesIn(dir)).toEqual(["user_ben"]);
    expect(await readFile(join(dir, LEDGER_FILE), "utf8")).not.toContain("user_anna");
  });

  it("waits for the lock file another append holds", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    const lock = join(dir, `${LEDGER_FILE}.lock`);
    await writeFile(lock, "another process");

    let done = false;
    const appending = run(dir, (ledger) => ledger.record(id, entry("user_anna", 1))).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    expect(await entriesIn(dir)).toEqual([]);

    await rm(lock);
    await appending;
    expect(await entriesIn(dir)).toEqual(["user_anna"]);
    await expect(access(lock)).rejects.toThrow("ENOENT");
  });

  it("takes a lock file a crash left behind once it is older than the stale limit", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    const lock = join(dir, `${LEDGER_FILE}.lock`);
    await writeFile(lock, "a process that crashed");
    const old = new Date(Date.now() - LEDGER_LOCK_STALE_MS - 5_000);
    await utimes(lock, old, old);

    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 1)));

    expect(await entriesIn(dir)).toEqual(["user_anna"]);
    await expect(access(lock)).rejects.toThrow("ENOENT");
  });

  it("keeps every entry whole when two processes append at once", { timeout: 60_000 }, async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    const appender = fileURLToPath(new URL("./test-ledger-appender.ts", import.meta.url));
    const append = (prefix: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [appender, dir, id, prefix, "40"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve(output) : reject(new Error(`exit ${code}: ${output}`)),
        );
      });

    const outputs = await Promise.all([append("user_first"), append("user_second")]);

    expect(outputs.join("")).not.toContain("half-written");
    const accounts = await entriesIn(dir);
    const expected = ["user_first", "user_second"].flatMap((prefix) =>
      Array.from({ length: 40 }, (_, n) => `${prefix}_${n}`),
    );
    expect(accounts.toSorted()).toEqual(expected.toSorted());
    expect((await readFile(join(dir, LEDGER_FILE), "utf8")).endsWith("}\n")).toBe(true);
  });
});
