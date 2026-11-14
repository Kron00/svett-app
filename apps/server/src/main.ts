import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { Backups, NightlyBackups } from "./backups.ts";
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

const Services = Layer.mergeAll(Database, Backups.layer).pipe(
  Layer.provide(PgTools.layer()),
  Layer.provideMerge(ServerConfig.fromEnv),
);

const App = Layer.mergeAll(HttpRouter.serve(Routes), NightlyBackups).pipe(
  Layer.provide(Migrated),
  Layer.provide(HttpServer),
  Layer.provide(Services),
);

NodeRuntime.runMain(Layer.launch(App));
