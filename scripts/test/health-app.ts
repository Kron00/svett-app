// Does to a database file what svett does when the health proof presses Import or Save,
// for tests of scripts/health-proof.ts and sim/health.sh.
// Usage: node scripts/test/health-app.ts import <svett.db> <export.zip or ride.gpx> [--keep-both]
//        node scripts/test/health-app.ts manual <svett.db>
//        node scripts/test/health-app.ts summary <export.zip or ride.gpx>
import { readFileSync } from "node:fs";

import {
  ActivityRepository,
  bytesSource,
  databaseLayer,
  Ids,
  manualEntryDraft,
  NO_CHOICES,
  readSourceFile,
  sourceFileSummary,
  TransferRepository,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect, Result } from "effect";

import { MANUAL } from "../health-proof.ts";

const withDatabase = async <A>(
  path: string,
  body: Effect.Effect<A, unknown, ActivityRepository | TransferRepository>,
) => {
  const { database, driver } = openNodeDatabase(path);
  try {
    return await Effect.runPromise(
      body.pipe(Effect.provide(databaseLayer(driver, Ids.layerSeeded(2)))),
    );
  } finally {
    database.close();
  }
};

const readFile = async (filePath: string) =>
  Result.getOrThrow(
    await readSourceFile(bytesSource(readFileSync(filePath)), {
      hourOf: (at) => new Date(at).getUTCHours(),
    }),
  );

/** The line svett shows atop the file's preview. */
export const summary = async (filePath: string) => sourceFileSummary(await readFile(filePath));

/**
 * Imports every workout in the file, linking each possible duplicate as Import does by
 * default, or keeping each apart with `keepBoth`.
 */
export const importFile = async (databasePath: string, filePath: string, keepBoth = false) => {
  const file = await readFile(filePath);
  return withDatabase(
    databasePath,
    Effect.flatMap(Effect.service(TransferRepository), (transfers) =>
      Effect.flatMap(transfers.previewSourceImport(file.workouts), (plan) =>
        transfers.applySourceImport(
          file.source,
          file.workouts,
          keepBoth ? { take: [], keepBoth: plan.duplicates.map((item) => item.key) } : NO_CHOICES,
        ),
      ),
    ),
  );
};

/** Saves the manual ride the proof's link fills in. */
export const saveManual = (databasePath: string) => {
  const draft = Result.getOrThrow(
    manualEntryDraft(
      { ...MANUAL, startedAt: MANUAL.start },
      Date.now(),
      new Date(MANUAL.start).getUTCHours(),
    ),
  );
  return withDatabase(
    databasePath,
    Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.create(draft)),
  );
};

if (import.meta.main) {
  const [command, databasePath = "", filePath = "", flag] = process.argv.slice(2);
  if (command === "import") await importFile(databasePath, filePath, flag === "--keep-both");
  else if (command === "manual") await saveManual(databasePath);
  else if (command === "summary") console.log(await summary(databasePath));
  else throw new Error(`Unknown command ${command}`);
}
