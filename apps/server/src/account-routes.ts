import { SyncPush } from "@svett/core";
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AccountRows, checkRows } from "./account-rows.ts";
import { signedInAccount } from "./auth.ts";

const unauthorized = () =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 }));

// Clients tell this apart from a refused session, which signing in again would fix.
const signInUnavailable = () =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      {
        error: "sign_in_unavailable",
        message:
          "Sign-in is not set up on this server yet, so accounts and their data are unavailable.",
      },
      { status: 503 },
    ),
  );

const me = Effect.gen(function* () {
  const account = yield* signedInAccount;
  const rows = yield* AccountRows;
  yield* rows.ensureAccount(account);
  return HttpServerResponse.jsonUnsafe({ accountId: account });
}).pipe(Effect.catchTags({ Unauthorized: unauthorized, SignInUnavailable: signInUnavailable }));

const PullQuery = Schema.Struct({
  after: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});

const invalidRequest = (error: { readonly message: string }) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: "invalid_request", message: error.message },
      { status: 400 },
    ),
  );

/** The account's rows applied after the change number `after`, a page at a time. */
const pullRows = Effect.gen(function* () {
  const account = yield* signedInAccount;
  const { after } = yield* HttpServerRequest.schemaSearchParams(PullQuery);
  const rows = yield* AccountRows;
  return HttpServerResponse.jsonUnsafe(yield* rows.changes(account, after ?? 0));
}).pipe(
  Effect.catchTags({
    Unauthorized: unauthorized,
    SignInUnavailable: signInUnavailable,
    SchemaError: invalidRequest,
  }),
);

const pushRows = Effect.gen(function* () {
  const account = yield* signedInAccount;
  const push = yield* HttpServerRequest.schemaBodyJson(SyncPush);
  const checked = yield* checkRows(push);
  const rows = yield* AccountRows;
  return HttpServerResponse.jsonUnsafe(
    yield* rows.write(account, checked, yield* Clock.currentTimeMillis),
  );
}).pipe(
  Effect.catchTags({
    Unauthorized: unauthorized,
    SignInUnavailable: signInUnavailable,
    InvalidRow: (invalid) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            error: "invalid_row",
            table: invalid.table,
            index: invalid.index,
            message: invalid.message,
          },
          { status: 400 },
        ),
      ),
    SchemaError: invalidRequest,
  }),
);

/** The routes that need a signed-in account. Each takes the owner from the session alone. */
export const AccountRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/me", me),
  HttpRouter.add("GET", "/v1/rows", pullRows),
  HttpRouter.add("PUT", "/v1/rows", pushRows),
);
