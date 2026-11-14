import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { ServerConfig } from "./config.ts";

export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly message: string;
}> {}

/** The ledger's name in BACKUP_DIR, the volume that outlives every deploy and every restore. */
export const LEDGER_FILE = "deleted-accounts.jsonl";

/** The ledger's first line, with the random ID the database records when the ledger is made. */
export const LedgerHeader = Schema.Struct({ ledger: Schema.String });

/** One deleted account, with the hash of the receipt the phone sent with the deletion. */
export const LedgerEntry = Schema.Struct({
  account: Schema.String,
  at: Schema.Int,
  receipt: Schema.NullOr(Schema.String),
});
export type LedgerEntry = typeof LedgerEntry.Type;

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerHeader));
const encodeHeader = Schema.encodeSync(Schema.fromJsonString(LedgerHeader));
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerEntry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(LedgerEntry));

export interface Ledger {
  readonly id: string;
  /** Every deletion, oldest first. */
  readonly entries: ReadonlyArray<LedgerEntry>;
  /**
   * The bytes of the complete lines. Anything after them is the start of a line a crash cut
   * short, a deletion that never committed, because a deletion is on disk before it commits.
   */
  readonly complete: number;
}

/**
 * Reads a ledger's text. Gives back a description of the damage instead when a complete line
 * is not what the server wrote, as no reader can then tell which accounts were deleted.
 */
export const readLedger = (text: string): Ledger | { readonly damaged: string } => {
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  const header = lines.length === 0 ? Option.none() : decodeHeader(lines[0]);
  if (Option.isNone(header)) return { damaged: "Line 1 is not the ledger's header." };
  const entries: Array<LedgerEntry> = [];
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    const entry = decodeEntry(line);
    if (Option.isNone(entry)) return { damaged: `Line ${index + 1} is damaged.` };
    entries.push(entry.value);
  }
  return {
    id: header.value.ledger,
    entries,
    complete: Buffer.byteLength(text) - Buffer.byteLength(tail),
  };
};

/** Writes up to `length` bytes of `bytes` from `offset` at the ledger's end. */
export type LedgerWrite = (
  file: FileHandle,
  bytes: Uint8Array,
  offset: number,
  length: number,
) => Promise<{ readonly bytesWritten: number }>;

export interface LedgerOptions {
  /**
   * NEW_DELETION_LEDGER. Lets a database that holds accounts and names no ledger make a new
   * one when the file is missing, which says every account it holds should exist.
   */
  readonly newLedgerOverAccounts?: boolean;
  /** How a line reaches the file. Tests pass one that stores less than it is asked to. */
  readonly write?: LedgerWrite;
}

/**
 * How long a lock file must be untouched before an append takes it as left by a crash. An
 * append holds it only to write and sync one line.
 */
export const LEDGER_LOCK_STALE_MS = 60_000;

const LOCK_RETRY_MS = 10;

export interface DeletionLedgerShape {
  /** Where the ledger lives, for messages. */
  readonly path: string;
  /** Whether NEW_DELETION_LEDGER is set. */
  readonly newLedgerOverAccounts: boolean;
  /**
   * The ledger, or None when the file does not exist. Fails when it is damaged. A line a crash
   * cut short at the end is left out.
   */
  readonly read: Effect.Effect<Option.Option<Ledger>, LedgerError>;
  /**
   * Makes a ledger with a new random ID, unless a ledger exists already, and gives back the ID
   * of the ledger the file holds then.
   */
  readonly create: Effect.Effect<string, LedgerError>;
  /**
   * Appends `entry` to ledger `id` and waits until it is on disk. A deletion records itself
   * here before it commits, so no deletion the database holds is missing from the ledger. It
   * first cuts off a line a crash cut short, so the new line never joins it. It holds the
   * lock file beside the ledger throughout, so no append by any process on the volume is part
   * way through. Fails when the file is missing, damaged, or another ledger, or when a write
   * stores nothing.
   */
  readonly record: (id: string, entry: LedgerEntry) => Effect.Effect<void, LedgerError>;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const defaultWrite: LedgerWrite = (file, bytes, offset, length) =>
  file.write(bytes, offset, length);

/** Writes all of `bytes` from `offset`, as a write may store fewer bytes than it was given. */
const writeWhole = async (
  write: LedgerWrite,
  file: FileHandle,
  bytes: Uint8Array,
  offset = 0,
): Promise<void> => {
  if (offset >= bytes.length) return;
  const { bytesWritten } = await write(file, bytes, offset, bytes.length - offset);
  if (bytesWritten <= 0) {
    throw new Error(`A write stored nothing after ${offset} of ${bytes.length} bytes.`);
  }
  return writeWhole(write, file, bytes, offset + bytesWritten);
};

const isTaken = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "EEXIST";

/** Makes the lock file holding `token`, or gives back false when it exists. */
const tryLock = (lockPath: string, token: string) =>
  open(lockPath, "wx").then(
    async (handle) => {
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      return true;
    },
    (error: unknown) => {
      if (isTaken(error)) return false;
      throw error;
    },
  );

/**
 * Moves aside the lock file when it is untouched for LEDGER_LOCK_STALE_MS, as a crash left it.
 * Renaming it lets only one waiter take it. A waiter that finds it moved a live lock made in
 * the meantime puts that one back.
 */
const breakStaleLock = async (lockPath: string, token: string) => {
  const held = await stat(lockPath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (held === undefined || Date.now() - held.mtimeMs <= LEDGER_LOCK_STALE_MS) return false;
  const aside = `${lockPath}.${token}.stale`;
  const moved = await rename(lockPath, aside).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
  if (!moved) return true;
  const taken = await stat(aside);
  if (taken.ino !== held.ino || taken.mtimeMs !== held.mtimeMs) {
    await link(aside, lockPath).catch((error: unknown) => {
      if (!isTaken(error)) throw error;
    });
  }
  await rm(aside, { force: true });
  return true;
};

/** Waits until this process makes the lock file holding `token`. */
const takeLock = async (lockPath: string, token: string): Promise<void> => {
  if (await tryLock(lockPath, token)) return;
  if (!(await breakStaleLock(lockPath, token))) await sleep(LOCK_RETRY_MS);
  return takeLock(lockPath, token);
};

/**
 * Holds the lock file `lockPath` while `task` runs. Making it is atomic for every process that
 * shares the volume, which the database's advisory lock is not across two databases.
 */
const holdingLock = async <A>(lockPath: string, task: () => Promise<A>): Promise<A> => {
  const token = randomUUID();
  await takeLock(lockPath, token);
  try {
    return await task();
  } finally {
    const still = await readFile(lockPath, "utf8").catch(() => undefined);
    if (still === token) await rm(lockPath, { force: true });
  }
};

const syncDirectory = async (dir: string) => {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * The record of deleted accounts that outlives a restore. The database keeps its own record in
 * `deleted_account`, but a backup from before a deletion brings the account back without it,
 * so the server applies the ledger again after every restore and on every start.
 */
export class DeletionLedger extends Context.Service<DeletionLedger, DeletionLedgerShape>()(
  "svett/server/DeletionLedger",
) {
  /** The ledger in `dir`. */
  static readonly layer = (
    dir: string,
    options: LedgerOptions = {},
  ): Layer.Layer<DeletionLedger> => {
    const path = join(dir, LEDGER_FILE);
    const write = options.write ?? defaultWrite;
    const damaged = (problem: string) =>
      new LedgerError({
        message: `The deletion ledger ${path} is damaged. ${problem} The server refuses to start, restore or delete an account until the file is mended, as it cannot tell which accounts were deleted.`,
      });
    const failed = (doing: string) => (error: unknown) =>
      error instanceof LedgerError
        ? error
        : new LedgerError({
            message: `Could not ${doing} the deletion ledger ${path}. ${String(error)}`,
          });

    const read = Effect.tryPromise({
      try: () =>
        readFile(path, "utf8").then(Option.some, (error: unknown) => {
          if (isMissing(error)) return Option.none<string>();
          throw error;
        }),
      catch: failed("read"),
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<Ledger>()),
          onSome: (text) => {
            const ledger = readLedger(text);
            if ("damaged" in ledger) return Effect.fail(damaged(ledger.damaged));
            const cut = Buffer.byteLength(text) > ledger.complete;
            return Effect.as(
              cut
                ? Effect.logWarning(
                    `Left out the half-written last line of ${path}, a deletion that never committed`,
                  )
                : Effect.void,
              Option.some(ledger),
            );
          },
        }),
      ),
    );

    const create = Effect.tryPromise({
      try: async () => {
        await mkdir(dir, { recursive: true });
        // The header goes in under its final name whole or not at all, and never over a ledger.
        const id = randomUUID();
        const temporary = join(dir, `.${LEDGER_FILE}.${id}`);
        const file = await open(temporary, "wx");
        try {
          await file.writeFile(`${encodeHeader({ ledger: id })}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        } finally {
          await rm(temporary, { force: true });
        }
        await syncDirectory(dir);
      },
      catch: failed("create"),
    }).pipe(
      Effect.andThen(read),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failed("create")(new Error("It is gone again."))),
          onSome: ({ id }) => Effect.succeed(id),
        }),
      ),
    );

    const record = (id: string, entry: LedgerEntry) =>
      Effect.tryPromise({
        try: () =>
          holdingLock(`${path}.lock`, async () => {
            // Appending only, so each write lands at the end whatever another process did.
            const file = await open(path, constants.O_RDWR | constants.O_APPEND).catch(
              (error: unknown) => {
                if (isMissing(error)) {
                  throw new LedgerError({
                    message: `The deletion ledger ${path} is missing. Check that BACKUP_DIR is the backup volume and that it is mounted.`,
                  });
                }
                throw error;
              },
            );
            try {
              const text = (await file.readFile()).toString("utf8");
              const ledger = readLedger(text);
              if ("damaged" in ledger) throw damaged(ledger.damaged);
              if (ledger.id !== id) {
                throw new LedgerError({
                  message: `The database names deletion ledger ${id}, but ${path} is ledger ${ledger.id}. Check that BACKUP_DIR is this server's backup volume.`,
                });
              }
              const cut = Buffer.byteLength(text) > ledger.complete;
              if (cut) await file.truncate(ledger.complete);
              await writeWhole(write, file, Buffer.from(`${encodeEntry(entry)}\n`));
              await file.sync();
              return cut;
            } finally {
              await file.close();
            }
          }),
        catch: failed("write"),
      }).pipe(
        Effect.flatMap((cut) =>
          cut
            ? Effect.logWarning(
                `Cut off the half-written last line of ${path}, a deletion that never committed`,
              )
            : Effect.void,
        ),
      );

    return Layer.succeed(
      DeletionLedger,
      DeletionLedger.of({
        path,
        newLedgerOverAccounts: options.newLedgerOverAccounts ?? false,
        read,
        create,
        record,
      }),
    );
  };

  /** The ledger in BACKUP_DIR. */
  static readonly fromConfig: Layer.Layer<DeletionLedger, never, ServerConfig> = Layer.unwrap(
    Effect.map(Effect.service(ServerConfig), ({ backupDir, newDeletionLedger }) =>
      DeletionLedger.layer(backupDir, { newLedgerOverAccounts: newDeletionLedger }),
    ),
  );
}
