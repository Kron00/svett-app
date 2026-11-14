import { Effect } from "effect";

import { DeletionLedger, type LedgerWrite } from "./deletion-ledger.ts";

// Appends `count` deletions named `<prefix>_<n>` to the ledger in `dir`, a few bytes per write
// and yielding between writes, so appends from two processes would interleave without a lock.
const [dir, id, prefix, count] = process.argv.slice(2);

const inPieces: LedgerWrite = async (file, bytes, offset, length) => {
  await new Promise((resolve) => setImmediate(resolve));
  return file.write(bytes, offset, Math.min(length, 3));
};

await Effect.runPromise(
  Effect.flatMap(Effect.service(DeletionLedger), (ledger) =>
    Effect.forEach(
      Array.from({ length: Number(count) }, (_, n) => n),
      (n) => ledger.record(id!, { account: `${prefix}_${n}`, at: n, receipt: null }),
    ),
  ).pipe(Effect.provide(DeletionLedger.layer(dir!, { write: inPieces }))),
);
