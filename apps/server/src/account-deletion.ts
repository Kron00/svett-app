import { PgClient } from "@effect/sql-pg";
import type { AccountId } from "@svett/core";
import { Context, Effect, Layer } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { ClerkUsers, type SessionEndFailed } from "./clerk-users.ts";
import { Safety } from "./safety.ts";

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
  effect_sql_migrations: "The migrator's record of the schema. It names no account.",
};

export interface AccountDeletionShape {
  /**
   * Deletes every row of `account` in every table, remembers its ID as deleted, then deletes
   * its Clerk user, which ends every session. Nothing changes when the server could not end
   * sessions at all. Running it again for a deleted account deletes the Clerk user again, so
   * a deletion that Clerk failed can be finished.
   */
  readonly remove: (account: AccountId) => Effect.Effect<void, SqlError | SessionEndFailed>;
}

export class AccountDeletion extends Context.Service<AccountDeletion, AccountDeletionShape>()(
  "svett/server/AccountDeletion",
) {
  static readonly layer: Layer.Layer<
    AccountDeletion,
    never,
    PgClient.PgClient | Safety | ClerkUsers
  > = Layer.effect(
    AccountDeletion,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const safety = yield* Safety;
      const clerk = yield* ClerkUsers;
      return AccountDeletion.of({
        remove: (account) =>
          Effect.gen(function* () {
            yield* clerk.available;
            yield* safety.exclusively(
              account,
              Effect.gen(function* () {
                yield* sql`insert into deleted_account (id) values (${account}) on conflict do nothing`;
                for (const [table, columns] of Object.entries(ACCOUNT_TABLES)) {
                  yield* sql`
                    delete from ${sql(table)}
                    where ${sql.or(columns.map((column) => sql`${sql(column)} = ${account}`))}
                  `;
                }
              }),
            );
            yield* Effect.logInfo("Deleted an account's rows");
            yield* clerk.deleteUser(account);
          }),
      });
    }),
  );
}
