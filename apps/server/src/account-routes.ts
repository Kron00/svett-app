import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AccountRows, checkRows, RowsWrite } from "./account-rows.ts";
import { signedInAccount } from "./auth.ts";

const unauthorized = () =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 }));

const me = Effect.gen(function* () {
  const account = yield* signedInAccount;
  const rows = yield* AccountRows;
  yield* rows.ensureAccount(account);
  return HttpServerResponse.jsonUnsafe({ accountId: account });
}).pipe(Effect.catchTag("Unauthorized", unauthorized));

const listRows = Effect.gen(function* () {
  const account = yield* signedInAccount;
  const rows = yield* AccountRows;
  return HttpServerResponse.jsonUnsafe({ rows: yield* rows.list(account) });
}).pipe(Effect.catchTag("Unauthorized", unauthorized));

const writeRows = Effect.gen(function* () {
  const account = yield* signedInAccount;
  const write = yield* HttpServerRequest.schemaBodyJson(RowsWrite);
  const checked = yield* checkRows(write);
  const rows = yield* AccountRows;
  yield* rows.write(account, checked);
  return HttpServerResponse.jsonUnsafe({ stored: checked.length });
}).pipe(
  Effect.catchTags({
    Unauthorized: unauthorized,
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
    SchemaError: (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "invalid_request", message: error.message },
          { status: 400 },
        ),
      ),
  }),
);

/** The routes that need a signed-in account. Each takes the owner from the session alone. */
export const AccountRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/me", me),
  HttpRouter.add("GET", "/v1/rows", listRows),
  HttpRouter.add("PUT", "/v1/rows", writeRows),
);
