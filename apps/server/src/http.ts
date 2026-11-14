import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";

import { Backups } from "./backups.ts";

const health = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const backups = yield* Backups;
  const databaseUp = yield* sql`select 1`.pipe(
    Effect.timeout("3 seconds"),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  const latest = yield* backups.latest.pipe(Effect.orElseSucceed(() => undefined));
  return HttpServerResponse.jsonUnsafe(
    {
      status: databaseUp ? "ok" : "error",
      database: databaseUp ? "ok" : "unreachable",
      latestBackup: latest === undefined ? null : new Date(latest.takenAt).toISOString(),
    },
    { status: databaseUp ? 200 : 503 },
  );
  // Coolify polls this every few seconds, which would bury every other request log.
}).pipe(HttpMiddleware.withLoggerDisabled);

export const Routes = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.text("svett server\n")),
  HttpRouter.add("GET", "/health", health),
);
