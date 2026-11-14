import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { AccountDeletion, readyToServe } from "./account-deletion.ts";
import { AccountRoutes, DeletionRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { Backups, NightlyBackups } from "./backups.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { ClerkUsers } from "./clerk-users.ts";
import { ServerConfig } from "./config.ts";
import { Database } from "./database.ts";
import { DeletionLedger } from "./deletion-ledger.ts";
import { FeedRoutes } from "./feed-routes.ts";
import { FeedRows } from "./feed-rows.ts";
import { Routes } from "./http.ts";
import { PgTools } from "./pg-tools.ts";
import { Safety } from "./safety.ts";
import { SocialRoutes } from "./social-routes.ts";
import { SocialRows } from "./social-rows.ts";

const HttpServer = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ port }) =>
    NodeHttpServer.layer(createServer, { port, host: "0.0.0.0" }),
  ),
);

// A restore from a backup taken before a deletion brings the account back, and a deletion the
// ledger accepted may not have committed, so the ledger deletes each again before the server
// answers any request.
const Prepared = Layer.effectDiscard(readyToServe);

const Services = Layer.mergeAll(
  Backups.layer,
  AccountRows.layer,
  SocialRows.layer,
  FeedRows.layer,
  Sessions.layer,
  AccountDeletion.layer,
).pipe(
  Layer.provideMerge(Safety.layer()),
  Layer.provideMerge(DeletionLedger.fromConfig),
  Layer.provideMerge(Database),
  Layer.provide(ClerkUsers.fromEnv),
  Layer.provide(PgTools.layer()),
  // Without a valid Clerk setup the server still starts, with sign-in off.
  Layer.provideMerge(ClerkConfig.fromEnv),
  Layer.provideMerge(ServerConfig.fromEnv),
);

const App = Layer.mergeAll(
  HttpRouter.serve(Layer.mergeAll(Routes, AccountRoutes, DeletionRoutes, SocialRoutes, FeedRoutes)),
  NightlyBackups,
).pipe(Layer.provide(Prepared), Layer.provide(HttpServer), Layer.provide(Services));

NodeRuntime.runMain(Layer.launch(App));
