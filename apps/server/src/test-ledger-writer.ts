import { Effect } from "effect";

import { DeletionLedger, type LedgerOptions, type LedgerWrite } from "./deletion-ledger.ts";

// `record <dir> <id> <prefix> <count>` records `count` deletions named `<prefix>_<n>` in the
// ledger in `dir`, a few bytes per write and yielding between writes, so two processes' writes
// interleave. `crash <dir> <id> <account>` dies once the deletion's whole entry is written to
// its temporary file, before the rename. `renamed <dir> <id> <account> <receipt hash>` dies
// once the entry is renamed into place, before the directory's sync.
const [mode, dir, id, name, count] = process.argv.slice(2);

const inPieces: LedgerWrite = async (file, bytes, offset, length) => {
  await new Promise((resolve) => setImmediate(resolve));
  return file.write(bytes, offset, Math.min(length, 3));
};

const thenCrash: LedgerWrite = async (file, bytes, offset, length) => {
  await file.write(bytes, offset, length);
  await file.sync();
  process.exit(9);
};

const options: LedgerOptions =
  mode === "crash"
    ? { write: thenCrash }
    : mode === "renamed"
      ? { syncDirectory: () => process.exit(9) }
      : { write: inPieces };

const accounts =
  mode === "record" ? Array.from({ length: Number(count) }, (_, n) => `${name}_${n}`) : [name!];

await Effect.runPromise(
  Effect.flatMap(Effect.service(DeletionLedger), (ledger) =>
    Effect.forEach(accounts, (account, n) =>
      ledger.record(id!, { account, at: n, receipt: mode === "renamed" ? count! : null }),
    ),
  ).pipe(Effect.provide(DeletionLedger.layer(dir!, options))),
);
