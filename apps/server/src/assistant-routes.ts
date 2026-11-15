import { Data, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AssistantRows } from "./assistant-rows.ts";
import { route } from "./social-routes.ts";

class ConnectionNotFound extends Data.TaggedError("ConnectionNotFound")<{}> {}

const ConnectionPath = Schema.Struct({ connection: Schema.String });
const Received = Schema.Struct({ ids: Schema.Array(Schema.String).check(Schema.isMaxLength(100)) });

/** The apps connected to the signed-in account, what each may do and when it last read. */
const connections = route((account) =>
  Effect.gen(function* () {
    return { connections: yield* (yield* AssistantRows).connections(account) };
  }),
);

/** Revokes a connection. Its tokens stop working at once, so its next request answers 401. */
const revoke = route((account) =>
  Effect.gen(function* () {
    const { connection } = yield* HttpRouter.schemaPathParams(ConnectionPath);
    const revoked = yield* (yield* AssistantRows).revoke(account, connection);
    if (!revoked) return yield* new ConnectionNotFound();
    return { revoked: true };
  }),
).pipe(
  Effect.catchTag("ConnectionNotFound", () =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({ error: "connection_not_found" }, { status: 404 }),
    ),
  ),
);

/** The proposals connected apps made, waiting for the phone to take them. */
const waiting = route((account) =>
  Effect.gen(function* () {
    return { proposals: yield* (yield* AssistantRows).waitingProposals(account) };
  }),
);

/** The phone holds these proposals now, so the server forgets them. */
const received = route((account) =>
  Effect.gen(function* () {
    const { ids } = yield* HttpServerRequest.schemaBodyJson(Received);
    return { received: yield* (yield* AssistantRows).proposalsReceived(account, ids) };
  }),
);

/** The routes the app uses for Connected apps and for taking proposals. */
export const AssistantRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/connections", connections),
  HttpRouter.add("DELETE", "/v1/connections/:connection", revoke),
  HttpRouter.add("GET", "/v1/assistant-proposals", waiting),
  HttpRouter.add("POST", "/v1/assistant-proposals/received", received),
);
