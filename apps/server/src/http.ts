import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";

import { Backups } from "./backups.ts";

const iso = (millis: number) => new Date(millis).toISOString();

const health = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const backups = yield* Backups;
  const databaseUp = yield* sql`select 1`.pipe(
    Effect.timeout("3 seconds"),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  const latest = yield* backups.latest.pipe(Effect.orElseSucceed(() => undefined));
  const check = yield* backups.lastRestoreCheck;
  return HttpServerResponse.jsonUnsafe(
    {
      status: databaseUp ? "ok" : "error",
      database: databaseUp ? "ok" : "unreachable",
      latestBackup: latest === undefined ? null : iso(latest.takenAt),
      restoreCheck:
        check === undefined
          ? null
          : {
              backup: iso(check.backupTakenAt),
              checkedAt: iso(check.checkedAt),
              restored: check.tables !== undefined,
              tables: check.tables ?? null,
            },
    },
    { status: databaseUp ? 200 : 503 },
  );
  // Coolify polls this every few seconds, which would bury every other request log.
}).pipe(HttpMiddleware.withLoggerDisabled);

export const Routes = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.text("svett server\n")),
  HttpRouter.add("GET", "/health", health),
);
