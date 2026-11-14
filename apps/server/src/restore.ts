import { Data, Effect, type Redacted } from "effect";

import { databaseLayer, isEmptyDatabase } from "./database.ts";
import { PgTools } from "./pg-tools.ts";

export class RestoreError extends Data.TaggedError("RestoreError")<{
  readonly message: string;
}> {}

/**
 * Loads a backup into the database at `target`. It refuses a database that already
 * holds tables, so a restore can never merge into or overwrite live data.
 */
export const restoreBackup = (file: string, target: Redacted.Redacted) =>
  Effect.gen(function* () {
    const empty = yield* isEmptyDatabase.pipe(Effect.provide(databaseLayer(target)));
    if (!empty) {
      return yield* new RestoreError({
        message: "The target database is not empty. Restore into a new, empty database.",
      });
    }
    const tools = yield* PgTools;
    yield* tools.restore(target, file);
  });
