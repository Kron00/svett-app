import { Schema } from "effect";

export const AccountId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)).pipe(
  Schema.brand("AccountId"),
);
export type AccountId = typeof AccountId.Type;

/** Whose data a database holds. Each owner has its own file, so accounts never mix. */
export const DatabaseOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("anonymous") }),
  Schema.Struct({ kind: Schema.Literal("account"), accountId: AccountId }),
]);
export type DatabaseOwner = typeof DatabaseOwner.Type;

export const ANONYMOUS: DatabaseOwner = { kind: "anonymous" };
