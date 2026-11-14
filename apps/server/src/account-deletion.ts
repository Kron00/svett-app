import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import type { AccountId } from "@svett/core";
import { Clock, Context, Effect, Layer } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { ClerkUsers, type SessionEndFailed } from "./clerk-users.ts";
import { DeletionLedger, type LedgerError } from "./deletion-ledger.ts";
import { lockAlone, Safety } from "./safety.ts";

/**
 * Every table that holds an account's rows, with each column that names an account. Deleting
 * an account deletes every row any of them names it in, so a like it gave, a comment on its
 * post by someone else and a follow of it all go. The deletion test fails until a new table
 * is listed here or in KEPT_TABLES.
 */
export const ACCOUNT_TABLES: Readonly<Record<string, ReadonlyArray<string>>> = {
  account: ["id"],
  account_row: ["account_id"],
  profile: ["account_id"],
  follow: ["follower_id", "followee_id"],
  block: ["blocker_id", "blocked_id"],
  activity_social: ["account_id"],
  activity_like: ["owner_id", "liker_id"],
  activity_comment: ["owner_id", "author_id"],
  inbox_read: ["account_id"],
  rate_limit: ["account_id"],
};

/** The tables a deletion leaves, and why. */
export const KEPT_TABLES: Readonly<Record<string, string>> = {
  deleted_account: "It keeps the deleted account's ID alone, so nothing recreates the account.",
  deletion_receipt: "It keeps the hash of a deletion's receipt alone, and names no account.",
  effect_sql_migrations: "The migrator's record of the schema. It names no account.",
};

/** The hash the server keeps of a receipt the phone sent with a deletion. */
export const receiptHash = (receipt: string) => createHash("sha256").update(receipt).digest("hex");

/**
 * Deletes every row of `account` in every table and remembers it as deleted, with the hash of
 * its receipt. It runs inside a transaction that holds the account's lock alone.
 */
const eraseAccount = (sql: PgClient.PgClient, account: string, receipt: string | null) =>
  Effect.gen(function* () {
    yield* sql`insert into deleted_account (id) values (${account}) on conflict do nothing`;
    if (receipt !== null) {
      yield* sql`
        insert into deletion_receipt (receipt_hash) values (${receipt}) on conflict do nothing
      `;
    }
    for (const [table, columns] of Object.entries(ACCOUNT_TABLES)) {
      yield* sql`
        delete from ${sql(table)}
        where ${sql.or(columns.map((column) => sql`${sql(column)} = ${account}`))}
      `;
    }
  });

/**
 * Deletes again every account the ledger holds that the database does not know as deleted, as
 * after a restore from a backup taken before its deletion. Gives back how many it deleted.
 */
export const applyLedger = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const entries = yield* (yield* DeletionLedger).entries;
  if (entries.length === 0) return 0;
  const deleted = new Set(
    (yield* sql<{ readonly id: string }>`select id from deleted_account`).map(({ id }) => id),
  );
  const receipts = new Set(
    (yield* sql<{ readonly hash: string }>`
      select receipt_hash as hash from deletion_receipt
    `).map(({ hash }) => hash),
  );
  const missing = entries.filter(
    (entry) =>
      !deleted.has(entry.account) || (entry.receipt !== null && !receipts.has(entry.receipt)),
  );
  yield* Effect.forEach(missing, (entry) =>
    sql.withTransaction(
      Effect.andThen(
        lockAlone(sql, entry.account),
        eraseAccount(sql, entry.account, entry.receipt),
      ),
    ),
  );
  const accounts = new Set(
    missing.filter((entry) => !deleted.has(entry.account)).map(({ account }) => account),
  );
  if (accounts.size > 0) {
    yield* Effect.logInfo(`Deleted ${accounts.size} accounts again from the deletion ledger`);
  }
  return accounts.size;
});

export interface AccountDeletionShape {
  /**
   * Deletes every row of `account` in every table, remembers its ID as deleted, records the
   * deletion in the ledger before it commits, then deletes its Clerk user, which ends every
   * session. Nothing changes when the server could not end sessions at all. Running it again
   * for a deleted account deletes the Clerk user again, so a deletion that Clerk failed can be
   * finished. `receipt` is a secret the phone made, which `deleted` takes later to tell the
   * phone the deletion happened, once its session is gone with the account.
   */
  readonly remove: (
    account: AccountId,
    receipt?: string,
  ) => Effect.Effect<void, SqlError | SessionEndFailed | LedgerError>;
  /** Whether a deletion sent with `receipt` happened. */
  readonly deleted: (receipt: string) => Effect.Effect<boolean, SqlError>;
}

export class AccountDeletion extends Context.Service<AccountDeletion, AccountDeletionShape>()(
  "svett/server/AccountDeletion",
) {
  static readonly layer: Layer.Layer<
    AccountDeletion,
    never,
    PgClient.PgClient | Safety | ClerkUsers | DeletionLedger
  > = Layer.effect(
    AccountDeletion,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const safety = yield* Safety;
      const clerk = yield* ClerkUsers;
      const ledger = yield* DeletionLedger;
      return AccountDeletion.of({
        remove: (account, receipt) =>
          Effect.gen(function* () {
            yield* clerk.available;
            const hash = receipt === undefined ? null : receiptHash(receipt);
            const at = yield* Clock.currentTimeMillis;
            yield* safety.exclusively(
              account,
              Effect.andThen(
                eraseAccount(sql, account, hash),
                ledger.record({ account, at, receipt: hash }),
              ),
            );
            yield* Effect.logInfo("Deleted an account's rows");
            yield* clerk.deleteUser(account);
          }),
        deleted: (receipt) =>
          sql`select 1 from deletion_receipt where receipt_hash = ${receiptHash(receipt)}`.pipe(
            Effect.map((rows) => rows.length > 0),
          ),
      });
    }),
  );
}
