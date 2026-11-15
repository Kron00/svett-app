import { Data, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { currentSync, outdatedSync } from "./account-routes.ts";
import { AssistantRows } from "./assistant-rows.ts";
import { route } from "./social-routes.ts";

class ConnectionNotFound extends Data.TaggedError("ConnectionNotFound")<{}> {}

const ConnectionPath = Schema.Struct({ connection: Schema.String });
const Received = Schema.Struct({ ids: Schema.Array(Schema.String).check(Schema.isMaxLength(100)) });

/**
 * The apps connected to the signed-in account, what each may do, when it last read and its
 * latest entries in the access log.
 */
const connections = route((account) =>
  Effect.gen(function* () {
    return { connections: yield* (yield* AssistantRows).connections(account) };
  }),
);

/**
 * Revokes a connection. Its tokens stop working at once, so its next request answers 401. It
 * counts against the phone's own writes, never the app's `assistant` bucket, so a busy app
 * cannot keep the person from revoking it.
 */
const revoke = route(
  (account) =>
    Effect.gen(function* () {
      const { connection } = yield* HttpRouter.schemaPathParams(ConnectionPath);
      const revoked = yield* (yield* AssistantRows).revoke(account, connection);
      if (!revoked) return yield* new ConnectionNotFound();
      return { revoked: true };
    }),
  "sync_push",
).pipe(
  Effect.catchTag("ConnectionNotFound", () =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({ error: "connection_not_found" }, { status: 404 }),
    ),
  ),
);

/**
 * The proposals connected apps made, waiting for the phone to take them. The phone takes them
 * with each sync, so a phone on an older sync API is refused as a sync is.
 */
const waiting = route((account) =>
  Effect.gen(function* () {
    yield* currentSync;
    return { proposals: yield* (yield* AssistantRows).waitingProposals(account) };
  }),
).pipe(Effect.catchTag("OutdatedSync", outdatedSync));

/** The phone holds these proposals now, so the server forgets them. */
const received = route(
  (account) =>
    Effect.gen(function* () {
      yield* currentSync;
      const { ids } = yield* HttpServerRequest.schemaBodyJson(Received);
      return { received: yield* (yield* AssistantRows).proposalsReceived(account, ids) };
    }),
  "sync_push",
).pipe(Effect.catchTag("OutdatedSync", outdatedSync));

/** The routes the app uses for Connected apps and for taking proposals. */
export const AssistantRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/connections", connections),
  HttpRouter.add("DELETE", "/v1/connections/:connection", revoke),
  HttpRouter.add("GET", "/v1/assistant-proposals", waiting),
  HttpRouter.add("POST", "/v1/assistant-proposals/received", received),
);
