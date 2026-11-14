import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";

import { Backups } from "./backups.ts";
import { ServerConfig } from "./config.ts";
import { PgTools } from "./pg-tools.ts";
import { restoreBackup } from "./restore.ts";

const USAGE = `Usage:
  node src/cli.ts backup                      Back up DATABASE_URL to BACKUP_DIR now.
  node src/cli.ts restore <file>              Restore <file> into RESTORE_DATABASE_URL, which must be empty.`;

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
    yield* restoreBackup(file, target);
    yield* Effect.logInfo(`Restored ${file}`);
    return;
  }
  yield* Effect.logError(USAGE);
  return yield* Effect.fail("usage");
});

const Services = Backups.layer.pipe(
  Layer.provideMerge(PgTools.layer()),
  Layer.provideMerge(ServerConfig.fromEnv),
);

NodeRuntime.runMain(program.pipe(Effect.provide(Services)));
