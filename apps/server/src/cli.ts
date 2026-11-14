import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";

import { Backups } from "./backups.ts";
import { ServerConfig } from "./config.ts";
import { DeletionLedger } from "./deletion-ledger.ts";
import { PgTools } from "./pg-tools.ts";
import { restoreForUse } from "./restore.ts";

const USAGE = `Usage:
  node src/cli.ts backup                      Back up DATABASE_URL to BACKUP_DIR now.
  node src/cli.ts restore <file>              Restore <file> into RESTORE_DATABASE_URL, which must be empty,
                                              then delete again every account the deletion ledger holds.`;

const [command, file] = process.argv.slice(2);

const program = Effect.gen(function* () {
  if (command === "backup") {
    const backups = yield* Backups;
    const { file: written } = yield* backups.takeNow;
    yield* Effect.logInfo(`Backup written to ${written}`);
    return;
  }
  if (command === "restore" && file !== undefined) {
    const target = yield* Config.Redacted("RESTORE_DATABASE_URL");
    const deleted = yield* restoreForUse(file, target);
    yield* Effect.logInfo(
      `Restored ${file}, and deleted ${deleted} accounts again from the deletion ledger`,
    );
    return;
  }
  yield* Effect.logError(USAGE);
  return yield* Effect.fail("usage");
});

const Services = Layer.merge(Backups.layer, DeletionLedger.fromConfig).pipe(
  Layer.provideMerge(PgTools.layer()),
  Layer.provideMerge(ServerConfig.fromEnv),
);

NodeRuntime.runMain(program.pipe(Effect.provide(Services)));
