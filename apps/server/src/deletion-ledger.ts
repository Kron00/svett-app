import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { ServerConfig } from "./config.ts";

export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly message: string;
}> {}

/** The ledger's name in BACKUP_DIR, the volume that outlives every deploy and every restore. */
export const LEDGER_FILE = "deleted-accounts.jsonl";

/** One deleted account, with the hash of the receipt the phone sent with the deletion. */
export const LedgerEntry = Schema.Struct({
  account: Schema.String,
  at: Schema.Int,
  receipt: Schema.NullOr(Schema.String),
});
export type LedgerEntry = typeof LedgerEntry.Type;

const LedgerLine = Schema.fromJsonString(LedgerEntry);
const decodeLine = Schema.decodeUnknownOption(LedgerLine);
const encodeLine = Schema.encodeSync(LedgerLine);

/**
 * Reads the ledger's lines. A line it cannot read is left out: only a write that a crash cut
 * short leaves one, and its deletion never committed.
 */
export const readLedger = (text: string): ReadonlyArray<LedgerEntry> =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => Option.toArray(decodeLine(line)));

export interface DeletionLedgerShape {
  /**
   * Appends `entry` and waits until it is on disk. A deletion records itself here before it
   * commits, so no deletion the database holds is missing from the ledger.
   */
  readonly record: (entry: LedgerEntry) => Effect.Effect<void, LedgerError>;
  /** Every deletion the ledger holds, oldest first. */
  readonly entries: Effect.Effect<ReadonlyArray<LedgerEntry>, LedgerError>;
}

/**
 * The record of deleted accounts that outlives a restore. The database keeps its own record in
 * `deleted_account`, but a backup from before a deletion brings the account back without it,
 * so the server applies the ledger again after every restore and on every start.
 */
export class DeletionLedger extends Context.Service<DeletionLedger, DeletionLedgerShape>()(
  "svett/server/DeletionLedger",
) {
  /** The ledger in `dir`. */
  static readonly layer = (dir: string): Layer.Layer<DeletionLedger> =>
    Layer.succeed(
      DeletionLedger,
      DeletionLedger.of({
        record: (entry) =>
          Effect.tryPromise({
            try: async () => {
              await mkdir(dir, { recursive: true });
              // Appends of one short line never interleave, so several servers can share it.
              const file = await open(join(dir, LEDGER_FILE), "a");
              try {
                await file.appendFile(`${encodeLine(entry)}\n`);
                await file.sync();
              } finally {
                await file.close();
              }
            },
            catch: (error) =>
              new LedgerError({ message: `Could not write the deletion ledger. ${String(error)}` }),
          }),
        entries: Effect.tryPromise({
          try: () => readFile(join(dir, LEDGER_FILE), "utf8"),
          catch: (error) => error,
        }).pipe(
          Effect.map(readLedger),
          Effect.catch((error) =>
            (error as NodeJS.ErrnoException)?.code === "ENOENT"
              ? Effect.succeed([])
              : Effect.fail(
                  new LedgerError({
                    message: `Could not read the deletion ledger. ${String(error)}`,
                  }),
                ),
          ),
        ),
      }),
    );

  /** The ledger in BACKUP_DIR. */
  static readonly fromConfig: Layer.Layer<DeletionLedger, never, ServerConfig> = Layer.unwrap(
    Effect.map(Effect.service(ServerConfig), ({ backupDir }) => DeletionLedger.layer(backupDir)),
  );
}
