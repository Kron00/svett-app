import { DeletionReceipt, exportFileName, EpochMillis, SyncPush } from "@svett/core";
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AccountDeletion } from "./account-deletion.ts";
import { AccountRows, checkRows } from "./account-rows.ts";
import { signedInAccount } from "./auth.ts";
import { Safety } from "./safety.ts";
import { answerRefusals, route } from "./social-routes.ts";

const me = route((account) =>
  Effect.gen(function* () {
    yield* (yield* AccountRows).ensureAccount(account);
    return { accountId: account };
  }),
);

const PullQuery = Schema.Struct({
  after: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});

/** The account's rows applied after the change number `after`, a page at a time. */
const pullRows = route((account) =>
  Effect.gen(function* () {
    const { after } = yield* HttpServerRequest.schemaSearchParams(PullQuery);
    return yield* (yield* AccountRows).changes(account, after ?? 0);
  }),
);

const pushRows = route(
  (account) =>
    Effect.gen(function* () {
      const push = yield* HttpServerRequest.schemaBodyJson(SyncPush);
      const checked = yield* checkRows(push);
      return yield* (yield* AccountRows).write(account, checked, yield* Clock.currentTimeMillis);
    }),
  "sync_push",
);

/** Every row the server holds for the account, as a svett file the app imports. */
const exportRows = answerRefusals(
  Effect.gen(function* () {
    const account = yield* signedInAccount;
    const rows = yield* AccountRows;
    const now = yield* Clock.currentTimeMillis;
    const file = yield* (yield* Safety).asAccount(
      account,
      undefined,
      rows.exportFile(account, now),
    );
    return HttpServerResponse.text(file, {
      contentType: "application/json",
      headers: {
        "content-disposition": `attachment; filename="${exportFileName(EpochMillis.make(now))}"`,
      },
    });
  }),
);

const DeleteBody = Schema.fromJsonString(
  Schema.Struct({ receipt: Schema.optional(DeletionReceipt) }),
);
const decodeDeleteBody = Schema.decodeUnknownEffect(DeleteBody);

/**
 * Deletes the signed-in account. It skips the deleted-account check, so a deletion that
 * Clerk failed can be sent again to finish. The body may carry the deletion's receipt.
 */
const deleteAccount = answerRefusals(
  Effect.gen(function* () {
    const account = yield* signedInAccount;
    const text = yield* (yield* HttpServerRequest.HttpServerRequest).text;
    const { receipt } = text.trim() === "" ? {} : yield* decodeDeleteBody(text);
    yield* (yield* AccountDeletion).remove(account, receipt);
    return HttpServerResponse.jsonUnsafe({ deleted: true });
  }),
);

const ReceiptPath = Schema.Struct({ receipt: DeletionReceipt });

/**
 * Whether an account was deleted with this receipt. It needs no session, as the deletion ended
 * every one, and only the phone that made the receipt knows it.
 */
const deletionHappened = answerRefusals(
  Effect.gen(function* () {
    const { receipt } = yield* HttpRouter.schemaPathParams(ReceiptPath);
    return HttpServerResponse.jsonUnsafe({
      deleted: yield* (yield* AccountDeletion).deleted(receipt),
    });
  }),
);

/** The routes that need a signed-in account. Each takes the owner from the session alone. */
export const AccountRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/me", me),
  HttpRouter.add("GET", "/v1/rows", pullRows),
  HttpRouter.add("PUT", "/v1/rows", pushRows),
  HttpRouter.add("GET", "/v1/export", exportRows),
);

/**
 * Deleting the signed-in account, which needs Clerk's Backend API to end its sessions, and
 * asking with a receipt whether a deletion happened.
 */
export const DeletionRoutes = Layer.mergeAll(
  HttpRouter.add("DELETE", "/v1/me", deleteAccount),
  HttpRouter.add("GET", "/v1/deletions/:receipt", deletionHappened),
);
