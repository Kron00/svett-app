import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { Clock, Context, Data, Effect, Layer, Option, Queue, Schema } from "effect";

import { ServerConfig } from "./config.ts";

export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly message: string;
}> {}

/** The ledger's directory in BACKUP_DIR, the volume that outlives every deploy and every restore. */
export const LEDGER_DIR = "deleted-accounts";

/** The file in the ledger's directory that holds its random ID, written once. */
export const LEDGER_ID_FILE = "ledger.json";

/** Every file still being written starts with this, and no reader opens one. */
export const TEMPORARY_PREFIX = ".tmp-";

/** How old a temporary file must be before a start takes it as left by a crash and removes it. */
export const LEFTOVER_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How recent a change to the directory must be for a check to read it again even when its
 * modification time is the same. A file system stamps times from a coarse clock, so two changes
 * a few milliseconds apart can carry one time, and the second would go unseen.
 */
export const COARSE_CLOCK_MS = 1_000;

/** What LEDGER_ID_FILE holds, the random ID the database records when the ledger is made. */
export const LedgerHeader = Schema.Struct({ ledger: Schema.String });

/** One deleted account, with the hash of the receipt the phone sent with the deletion. */
export const LedgerEntry = Schema.Struct({
  account: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  at: Schema.Int,
  receipt: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
});
export type LedgerEntry = typeof LedgerEntry.Type;

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerHeader));
const encodeHeader = Schema.encodeSync(Schema.fromJsonString(LedgerHeader));
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerEntry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(LedgerEntry));

/**
 * The file that holds `entry`. Each receipt gets its own, so a deletion sent again with another
 * receipt keeps the first one's too.
 */
export const entryFileName = (entry: LedgerEntry) =>
  `${entry.account}.${entry.receipt ?? "none"}.json`;

export interface Ledger {
  readonly id: string;
  /** Every deletion, oldest first. */
  readonly entries: ReadonlyArray<LedgerEntry>;
}

/** Writes up to `length` bytes of `bytes` from `offset` to a temporary file. */
export type LedgerWrite = (
  file: FileHandle,
  bytes: Uint8Array,
  offset: number,
  length: number,
) => Promise<{ readonly bytesWritten: number }>;

export interface LedgerOptions {
  /**
   * NEW_DELETION_LEDGER. Lets a database that holds accounts and names no ledger make a new
   * one when the ledger is missing, which says every account it holds should exist.
   */
  readonly newLedgerOverAccounts?: boolean;
  /** How a file's bytes reach the disk. Tests pass one that stores less than it is asked to. */
  readonly write?: LedgerWrite;
  /** How a directory's names reach the disk. Tests pass one that fails or dies. */
  readonly syncDirectory?: (dir: string) => Promise<void>;
}

export interface DeletionLedgerShape {
  /** The ledger's directory, for messages. */
  readonly path: string;
  /** Whether NEW_DELETION_LEDGER is set. */
  readonly newLedgerOverAccounts: boolean;
  /**
   * The ledger, or None when it has no ID file. Fails when a file under its final name is
   * damaged. Temporary files are never read.
   */
  readonly read: Effect.Effect<Option.Option<Ledger>, LedgerError>;
  /**
   * Makes a ledger with a new random ID, unless one exists already, and gives back the ID of
   * the ledger the directory holds then.
   */
  readonly create: Effect.Effect<string, LedgerError>;
  /**
   * Records `entry` in ledger `id` and waits until it is on disk. A deletion records itself
   * here first, before the database marks the account deleted, so no deletion the database
   * holds is missing from the ledger. The
   * entry is written whole to a temporary file, synced, and only then renamed to its final
   * name, so a reader sees all of it or none. Two deletions never touch the same file, so they
   * need no lock. Fails when the ledger is missing or another ledger, or when a write stores
   * nothing, and then leaves nothing behind. Once the rename is done the deletion is accepted,
   * and `deletionsOf` holds it, even when the directory's sync then fails.
   */
  readonly record: (id: string, entry: LedgerEntry) => Effect.Effect<void, LedgerError>;
  /**
   * The ledger's entries for `account`. Any entry means the account is deleted, whatever the
   * database says. They come from memory, which a read fills and every entry this server
   * records adds to. Before it answers, it reads the directory's modification time, and when
   * that changed reads the files it has not read yet, so it also holds what another server
   * recorded, even one that died before its database knew.
   */
  readonly deletionsOf: (account: string) => Effect.Effect<ReadonlyArray<LedgerEntry>, LedgerError>;
  /** Whether the ledger holds a deletion sent with the receipt of this hash, read as `deletionsOf` reads. */
  readonly holdsReceipt: (hash: string) => Effect.Effect<boolean, LedgerError>;
  /**
   * Waits for accounts with entries this server found in the directory after its first read,
   * which another server recorded, and gives back each account once per entry. The server
   * finishes their deletions, as the one that recorded them may have died before it could.
   */
  readonly found: Effect.Effect<ReadonlyArray<string>>;
  /**
   * Removes temporary files older than LEFTOVER_AGE_MS, which a crash left part way through a
   * deletion that never committed. Gives back how many it removed.
   */
  readonly removeLeftovers: Effect.Effect<number, LedgerError>;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

const isTaken = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "EEXIST";

const isTemporary = (name: string) => name.startsWith(TEMPORARY_PREFIX);

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

const defaultSyncDirectory = async (dir: string) => {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * Writes `text` whole to a new temporary file in `dir` and syncs it. Gives back its path. A
 * write that fails removes the file.
 */
const writeTemporary = async (write: LedgerWrite, dir: string, text: string) => {
  const temporary = join(dir, `${TEMPORARY_PREFIX}${randomUUID()}`);
  const file = await open(temporary, "wx");
  try {
    await writeWhole(write, file, Buffer.from(text));
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  return temporary;
};

/** The text of `path`, or None when it does not exist. */
const readIfThere = (path: string) =>
  readFile(path, "utf8").then(Option.some, (error: unknown) => {
    if (isMissing(error)) return Option.none<string>();
    throw error;
  });

/** The names in `dir`, or none when it does not exist. */
const namesIn = (dir: string) =>
  readdir(dir).catch((error: unknown) => {
    if (isMissing(error)) return [] as Array<string>;
    throw error;
  });

/** The directory's modification time in nanoseconds and milliseconds, or None when it is missing. */
const modifiedAt = (dir: string) =>
  stat(dir, { bigint: true }).then(
    ({ mtimeNs, mtimeMs }) => Option.some({ ns: mtimeNs, ms: Number(mtimeMs) }),
    (error: unknown) => {
      if (isMissing(error)) return Option.none<{ readonly ns: bigint; readonly ms: number }>();
      throw error;
    },
  );

/**
 * The record of deleted accounts that outlives a restore. The database keeps its own record in
 * `deleted_account`, but a backup from before a deletion brings the account back without it,
 * so the server applies the ledger again after every restore and on every start.
 */
export class DeletionLedger extends Context.Service<DeletionLedger, DeletionLedgerShape>()(
  "svett/server/DeletionLedger",
) {
  /** The ledger in the directory LEDGER_DIR inside `backupDir`. */
  static readonly layer = (
    backupDir: string,
    options: LedgerOptions = {},
  ): Layer.Layer<DeletionLedger> => Layer.effect(DeletionLedger, makeLedger(backupDir, options));

  /** The ledger in BACKUP_DIR. */
  static readonly fromConfig: Layer.Layer<DeletionLedger, never, ServerConfig> = Layer.unwrap(
    Effect.map(Effect.service(ServerConfig), ({ backupDir, newDeletionLedger }) =>
      DeletionLedger.layer(backupDir, { newLedgerOverAccounts: newDeletionLedger }),
    ),
  );
}

const makeLedger = (backupDir: string, options: LedgerOptions) =>
  Effect.gen(function* () {
    const path = join(backupDir, LEDGER_DIR);
    const idFile = join(path, LEDGER_ID_FILE);
    const write = options.write ?? defaultWrite;
    const syncDirectory = options.syncDirectory ?? defaultSyncDirectory;
    const known = new Map<string, Array<LedgerEntry>>();
    const receipts = new Set<string>();
    /** Every file under a final name already read. A final file never changes once in place. */
    const readFiles = new Map<string, LedgerEntry>();
    const found = yield* Queue.unbounded<string>();
    let loaded = false;
    /** The directory's modification time at its last read, or undefined to read it again. */
    let seen: bigint | undefined;

    /** Keeps `entry` in memory. Gives back whether it was new there. */
    const remember = (entry: LedgerEntry) => {
      const entries = known.get(entry.account) ?? [];
      const fresh = !entries.some((each) => each.receipt === entry.receipt);
      if (fresh) entries.push(entry);
      known.set(entry.account, entries);
      if (entry.receipt !== null) receipts.add(entry.receipt);
      return fresh;
    };
    const damaged = (problem: string) =>
      new LedgerError({
        message: `The deletion ledger ${path} is damaged. ${problem} The server refuses to start or restore until it is mended, as it cannot tell which accounts were deleted.`,
      });
    const failed = (doing: string) => (error: unknown) =>
      error instanceof LedgerError
        ? error
        : new LedgerError({
            message: `Could not ${doing} the deletion ledger ${path}. ${String(error)}`,
          });

    /** The ledger's ID, or None when it has none. Fails when the ID file is damaged. */
    const readId = async () => {
      const text = await readIfThere(idFile);
      if (Option.isNone(text)) return Option.none<string>();
      const header = decodeHeader(text.value);
      if (Option.isNone(header)) throw damaged(`${LEDGER_ID_FILE} is not the ledger's ID.`);
      return Option.some(header.value.ledger);
    };

    /**
     * Reads every file under a final name that it has not read before, and remembers it. An
     * account that another server deleted since the first read goes to `found`. The directory's
     * time is read first, so a file that arrives during the read changes it again.
     */
    const scan = async (now: number) => {
      const modified = await modifiedAt(path);
      const id = await readId();
      const names = (await namesIn(path)).filter(
        (name) => !isTemporary(name) && name !== LEDGER_ID_FILE,
      );
      if (Option.isNone(id)) {
        if (names.length > 0) {
          throw damaged(`It holds ${names.length} deletions but no ${LEDGER_ID_FILE}.`);
        }
      } else {
        const entries = await Promise.all(
          names
            .filter((name) => !readFiles.has(name))
            .toSorted()
            .map(async (name) => {
              const entry = decodeEntry(await readFile(join(path, name), "utf8"));
              if (Option.isNone(entry) || entryFileName(entry.value) !== name) {
                throw damaged(`${name} is damaged.`);
              }
              return [name, entry.value] as const;
            }),
        );
        for (const [name, entry] of entries) {
          readFiles.set(name, entry);
          if (remember(entry) && loaded) Queue.offerUnsafe(found, entry.account);
        }
      }
      loaded = true;
      seen = Option.match(modified, {
        onNone: () => undefined,
        onSome: ({ ns, ms }) => (now - ms < COARSE_CLOCK_MS ? undefined : ns),
      });
      return id;
    };

    const read = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.tryPromise({
        try: async () => {
          const id = await scan(now);
          if (Option.isNone(id)) return Option.none<Ledger>();
          return Option.some<Ledger>({
            id: id.value,
            entries: [...readFiles.values()].toSorted((a, b) => a.at - b.at),
          });
        },
        catch: failed("read"),
      }),
    );

    /**
     * Reads the directory again when it changed since the last read, which costs a stat when it
     * did not. A directory that is gone keeps what memory holds.
     */
    const refresh = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.tryPromise({
        try: async () => {
          if (loaded && seen !== undefined) {
            const modified = await modifiedAt(path);
            if (Option.isNone(modified) || modified.value.ns === seen) return;
          }
          await scan(now);
        },
        catch: failed("read"),
      }),
    );

    const create = Effect.tryPromise({
      try: async () => {
        await mkdir(path, { recursive: true });
        await syncDirectory(dirname(path));
        // The ID goes in under its final name whole or not at all, and never over another.
        const temporary = await writeTemporary(
          write,
          path,
          `${encodeHeader({ ledger: randomUUID() })}\n`,
        );
        try {
          await link(temporary, idFile);
        } catch (error) {
          if (!isTaken(error)) throw error;
        } finally {
          await rm(temporary, { force: true });
        }
        await syncDirectory(path);
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
        try: async () => {
          const current = await readId();
          if (Option.isNone(current)) {
            throw new LedgerError({
              message: `The deletion ledger ${path} is missing. Check that BACKUP_DIR is the backup volume and that it is mounted.`,
            });
          }
          if (current.value !== id) {
            throw new LedgerError({
              message: `The database names deletion ledger ${id}, but ${path} is ledger ${current.value}. Check that BACKUP_DIR is this server's backup volume.`,
            });
          }
          const name = entryFileName(entry);
          const temporary = await writeTemporary(write, path, `${encodeEntry(entry)}\n`);
          try {
            await rename(temporary, join(path, name));
          } catch (error) {
            await rm(temporary, { force: true });
            throw error;
          }
          readFiles.set(name, entry);
          remember(entry);
          await syncDirectory(path);
        },
        catch: failed("write"),
      });

    const removeLeftovers = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.tryPromise({
        try: async () => {
          const removed = await Promise.all(
            (await namesIn(path)).filter(isTemporary).map(async (name) => {
              const file = join(path, name);
              const age = await stat(file).then(
                ({ mtimeMs }) => now - mtimeMs,
                (error: unknown) => {
                  if (isMissing(error)) return 0;
                  throw error;
                },
              );
              if (age <= LEFTOVER_AGE_MS) return false;
              await rm(file, { force: true });
              return true;
            }),
          );
          return removed.filter(Boolean).length;
        },
        catch: failed("clean up"),
      }),
    ).pipe(
      Effect.tap((removed) =>
        removed > 0
          ? Effect.logWarning(
              `Removed ${removed} temporary files from ${path} that a crash left, deletions that never committed`,
            )
          : Effect.void,
      ),
    );

    return DeletionLedger.of({
      path,
      newLedgerOverAccounts: options.newLedgerOverAccounts ?? false,
      read,
      create,
      record,
      deletionsOf: (account) =>
        Effect.andThen(
          refresh,
          Effect.sync(() => [...(known.get(account) ?? [])]),
        ),
      holdsReceipt: (hash) =>
        Effect.andThen(
          refresh,
          Effect.sync(() => receipts.has(hash)),
        ),
      found: Effect.map(Queue.takeAll(found), (accounts) => [...new Set(accounts)]),
      removeLeftovers,
    });
  });
