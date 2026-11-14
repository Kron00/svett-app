import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  DeletionLedger,
  entryFileName,
  LEDGER_DIR,
  LEDGER_ID_FILE,
  LEFTOVER_AGE_MS,
  type LedgerEntry,
  type LedgerOptions,
  type LedgerWrite,
  TEMPORARY_PREFIX,
} from "./deletion-ledger.ts";
import { writer } from "./test-ledger.ts";

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

const entry = (account: string, at: number, receipt: string | null = null): LedgerEntry => ({
  account,
  at,
  receipt,
});

const entriesIn = async (dir: string) =>
  Option.getOrThrow(await run(dir, (ledger) => ledger.read)).entries.map(({ account }) => account);

/** The names of the files in the ledger's directory. */
const filesIn = async (dir: string) => (await readdir(join(dir, LEDGER_DIR))).toSorted();

const temporaryFiles = async (dir: string) =>
  (await filesIn(dir)).filter((name) => name.startsWith(TEMPORARY_PREFIX));

const syncFails = async () => {
  throw new Error("The disk did not sync the directory.");
};

describe("the deletion ledger", () => {
  it("keeps its ID in a file written once, and makes only one ledger", async () => {
    const dir = await newDir();
    expect(await run(dir, (ledger) => ledger.read)).toEqual(Option.none());
    const [first, second] = await Promise.all([
      run(dir, (ledger) => ledger.create),
      run(dir, (ledger) => ledger.create),
    ]);
    expect(second).toBe(first);
    expect(await readFile(join(dir, LEDGER_DIR, LEDGER_ID_FILE), "utf8")).toBe(
      `{"ledger":"${first}"}\n`,
    );
    expect(await filesIn(dir)).toEqual([LEDGER_ID_FILE]);
  });

  it("keeps each deletion in its own file, and every receipt a deletion was sent with", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    const [first, again] = ["a".repeat(64), "b".repeat(64)];

    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 1, first)));
    await run(dir, (ledger) => ledger.record(id, entry("user_ben", 2)));
    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 3, again)));
    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 4, again)));

    const found = Option.getOrThrow(await run(dir, (ledger) => ledger.read));
    expect(found.entries).toEqual([
      entry("user_anna", 1, first),
      entry("user_ben", 2),
      entry("user_anna", 4, again),
    ]);
    expect(await filesIn(dir)).toEqual(
      [
        LEDGER_ID_FILE,
        entryFileName(entry("user_anna", 1, first)),
        entryFileName(entry("user_anna", 1, again)),
        entryFileName(entry("user_ben", 2)),
      ].toSorted(),
    );
  });

  it("keeps every deletion when two processes record at once", { timeout: 60_000 }, async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);

    const runs = await Promise.all([
      writer(["record", dir, id, "user_first", "40"]),
      writer(["record", dir, id, "user_second", "40"]),
    ]);

    expect(runs).toEqual([
      { code: 0, output: "" },
      { code: 0, output: "" },
    ]);
    const expected = ["user_first", "user_second"].flatMap((prefix) =>
      Array.from({ length: 40 }, (_, n) => `${prefix}_${n}`),
    );
    expect((await entriesIn(dir)).toSorted()).toEqual(expected.toSorted());
    expect(await temporaryFiles(dir)).toEqual([]);
  });

  it("leaves no entry when a process dies before the rename, and a start a day later removes what it left", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);

    const crashed = await writer(["crash", dir, id, "user_anna"]);

    expect(crashed.code).toBe(9);
    const [leftover] = await temporaryFiles(dir);
    expect(await readFile(join(dir, LEDGER_DIR, leftover!), "utf8")).toContain("user_anna");
    expect(await entriesIn(dir)).toEqual([]);

    // A temporary file this young may be a deletion still being written in another process.
    expect(await run(dir, (ledger) => ledger.removeLeftovers)).toBe(0);
    expect(await temporaryFiles(dir)).toEqual([leftover]);
    const old = new Date(Date.now() - LEFTOVER_AGE_MS - 60_000);
    await utimes(join(dir, LEDGER_DIR, leftover!), old, old);
    expect(await run(dir, (ledger) => ledger.removeLeftovers)).toBe(1);
    expect(await filesIn(dir)).toEqual([LEDGER_ID_FILE]);
  });

  it("holds a deletion once its entry is renamed into place, even when the directory's sync then fails", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    const receipt = "d".repeat(64);

    const held = await run(
      dir,
      (ledger) =>
        Effect.gen(function* () {
          const failed = yield* Effect.flip(ledger.record(id, entry("user_anna", 1, receipt)));
          return {
            failed: failed.message,
            anna: yield* ledger.deletionsOf("user_anna"),
            ben: yield* ledger.deletionsOf("user_ben"),
            receipt: yield* ledger.holdsReceipt(receipt),
          };
        }),
      { syncDirectory: syncFails },
    );

    expect(held).toEqual({
      failed: expect.stringContaining("The disk did not sync the directory."),
      anna: [entry("user_anna", 1, receipt)],
      ben: [],
      receipt: true,
    });
    // A new server reads it from the directory.
    expect(
      await run(dir, (ledger) =>
        Effect.all([ledger.deletionsOf("user_anna"), ledger.holdsReceipt(receipt)]),
      ),
    ).toEqual([[entry("user_anna", 1, receipt)], true]);
  });

  it("holds no deletion that died before its rename", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);

    expect((await writer(["crash", dir, id, "user_anna"])).code).toBe(9);

    expect(await run(dir, (ledger) => ledger.deletionsOf("user_anna"))).toEqual([]);
  });

  it("holds a deletion whose process died after its rename", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    const receipt = "e".repeat(64);

    expect((await writer(["renamed", dir, id, "user_anna", receipt])).code).toBe(9);

    expect(await run(dir, (ledger) => ledger.deletionsOf("user_anna"))).toEqual([
      entry("user_anna", 0, receipt),
    ]);
    expect(await temporaryFiles(dir)).toEqual([]);
  });

  it("writes the whole entry when each write stores only a few bytes of it", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    const pieces: Array<number> = [];
    const fewBytes: LedgerWrite = async (file, bytes, offset, length) => {
      const stored = await file.write(bytes, offset, Math.min(length, 4));
      pieces.push(stored.bytesWritten);
      return stored;
    };

    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 1)), { write: fewBytes });

    expect(pieces.length).toBeGreaterThan(10);
    expect(await entriesIn(dir)).toEqual(["user_anna"]);
    expect(
      await readFile(join(dir, LEDGER_DIR, entryFileName(entry("user_anna", 1))), "utf8"),
    ).toBe(`{"account":"user_anna","at":1,"receipt":null}\n`);
  });

  it("fails a deletion whose write stalls, and leaves nothing behind", async () => {
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
    expect(await filesIn(dir)).toEqual([LEDGER_ID_FILE]);
  });

  it("holds up no other deletion while one write hangs", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const hangs: LedgerWrite = (file, bytes, offset, length) =>
      released.then(() => file.write(bytes, offset, length));

    const hanging = run(dir, (ledger) => ledger.record(id, entry("user_anna", 1)), {
      write: hangs,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await run(dir, (ledger) => ledger.record(id, entry("user_ben", 2)));

    expect(await entriesIn(dir)).toEqual(["user_ben"]);
    expect(await temporaryFiles(dir)).toHaveLength(1);
    release();
    await hanging;
    expect(await entriesIn(dir)).toEqual(["user_anna", "user_ben"]);
    expect(await temporaryFiles(dir)).toEqual([]);
  });

  it("refuses a damaged file under a final name, and an entry without the ledger's ID", async () => {
    const dir = await newDir();
    const id = await run(dir, (ledger) => ledger.create);
    await run(dir, (ledger) => ledger.record(id, entry("user_anna", 1)));
    const refusal = async () => (await failure(dir, (ledger) => ledger.read)).message;

    const ben = join(dir, LEDGER_DIR, entryFileName(entry("user_ben", 2)));
    await writeFile(ben, '{"account":"user_ben","at');
    expect(await refusal()).toBe(
      `The deletion ledger ${join(dir, LEDGER_DIR)} is damaged. user_ben.none.json is damaged. The server refuses to start or restore until it is mended, as it cannot tell which accounts were deleted.`,
    );

    // An entry under another account's name would hide the account it names.
    await writeFile(ben, '{"account":"user_cleo","at":2,"receipt":null}\n');
    expect(await refusal()).toContain("user_ben.none.json is damaged.");
    await rm(ben);
    expect(await entriesIn(dir)).toEqual(["user_anna"]);

    await writeFile(join(dir, LEDGER_DIR, LEDGER_ID_FILE), "{");
    expect(await refusal()).toContain(`${LEDGER_ID_FILE} is not the ledger's ID.`);
    await rm(join(dir, LEDGER_DIR, LEDGER_ID_FILE));
    expect(await refusal()).toContain(`It holds 1 deletions but no ${LEDGER_ID_FILE}.`);
  });

  it("records only in the ledger the database names, and never makes one by recording", async () => {
    const dir = await newDir();
    expect(
      (await failure(dir, (ledger) => ledger.record("some-ledger", entry("user_anna", 1)))).message,
    ).toContain("is missing. Check that BACKUP_DIR is the backup volume");
    await mkdir(join(dir, LEDGER_DIR));
    expect(
      (await failure(dir, (ledger) => ledger.record("some-ledger", entry("user_anna", 1)))).message,
    ).toContain("is missing. Check that BACKUP_DIR is the backup volume");
    expect(await run(dir, (ledger) => ledger.read)).toEqual(Option.none());

    const id = await run(dir, (ledger) => ledger.create);
    expect(
      (await failure(dir, (ledger) => ledger.record("another-ledger", entry("user_anna", 1))))
        .message,
    ).toContain(
      `names deletion ledger another-ledger, but ${join(dir, LEDGER_DIR)} is ledger ${id}`,
    );
    expect(await filesIn(dir)).toEqual([LEDGER_ID_FILE]);
  });
});
