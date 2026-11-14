import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { AccountRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { Backups, NightlyBackups } from "./backups.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { ServerConfig } from "./config.ts";
import { Database, migrate } from "./database.ts";
import { Routes } from "./http.ts";
import { PgTools } from "./pg-tools.ts";

const HttpServer = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ port }) =>
    NodeHttpServer.layer(createServer, { port, host: "0.0.0.0" }),
  ),
);

const Migrated = Layer.effectDiscard(
  migrate.pipe(
    Effect.tap((applied) =>
      Effect.forEach(applied, ([id, name]) => Effect.logInfo(`Migrated ${id}_${name}`)),
    ),
  ),
);

const Services = Layer.mergeAll(Backups.layer, AccountRows.layer, Sessions.layer).pipe(
  Layer.provideMerge(Database),
  Layer.provide(PgTools.layer()),
  // Without a valid Clerk setup the server still starts, with sign-in off.
  Layer.provideMerge(ClerkConfig.fromEnv),
  Layer.provideMerge(ServerConfig.fromEnv),
);

const App = Layer.mergeAll(
  HttpRouter.serve(Layer.mergeAll(Routes, AccountRoutes)),
  NightlyBackups,
).pipe(Layer.provide(Migrated), Layer.provide(HttpServer), Layer.provide(Services));

NodeRuntime.runMain(Layer.launch(App));
