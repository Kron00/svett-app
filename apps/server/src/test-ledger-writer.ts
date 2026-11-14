import { Effect } from "effect";

import { DeletionLedger, type LedgerWrite } from "./deletion-ledger.ts";

// `record <dir> <id> <prefix> <count>` records `count` deletions named `<prefix>_<n>` in the
// ledger in `dir`, a few bytes per write and yielding between writes, so two processes' writes
// interleave. `crash <dir> <id> <account>` dies once the deletion's whole entry is written to
// its temporary file, before the rename.
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

const accounts =
  mode === "crash" ? [name!] : Array.from({ length: Number(count) }, (_, n) => `${name}_${n}`);

await Effect.runPromise(
  Effect.flatMap(Effect.service(DeletionLedger), (ledger) =>
    Effect.forEach(accounts, (account, n) => ledger.record(id!, { account, at: n, receipt: null })),
  ).pipe(
    Effect.provide(DeletionLedger.layer(dir!, { write: mode === "crash" ? thenCrash : inPieces })),
  ),
);
