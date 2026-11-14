import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import type { AccountId } from "@svett/core";
import { Clock, Context, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { ClerkUsers, type SessionEndFailed } from "./clerk-users.ts";
import { migrate } from "./database.ts";
import { DeletionLedger, LedgerError } from "./deletion-ledger.ts";
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
  deletion_ledger: "It keeps the deletion ledger's ID alone, and names no account.",
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
 * The key of the lock every check of the ledger holds inside its transaction, so two starts on
 * one database never both record a ledger. Its first key is the account locks' space plus one,
 * so it meets none of them.
 */
const LEDGER_LOCK_SPACE = 5_151;

const lockLedger = (sql: PgClient.PgClient) =>
  sql`select pg_advisory_xact_lock(${LEDGER_LOCK_SPACE}, 0)`;

/** The ID of the ledger the database recorded, if it has one. */
const namedLedger = (sql: PgClient.PgClient) =>
  Effect.map(sql<{ readonly id: string }>`select id from deletion_ledger`, (rows) =>
    Option.fromNullishOr(rows[0]?.id),
  );

/** Selects every account ID any row names, once per row, from every table in ACCOUNT_TABLES. */
const NAMED_ACCOUNTS = Object.entries(ACCOUNT_TABLES)
  .flatMap(([table, columns]) =>
    columns.map((column) => `select "${column}" as account from "${table}"`),
  )
  .join(" union all ");

/** How many accounts the database holds a row of, in any table that names an account. */
const accountsHeld = (sql: PgClient.PgClient) =>
  Effect.map(
    sql.unsafe<{ readonly accounts: number }>(
      `select count(distinct account)::int as accounts from (${NAMED_ACCOUNTS}) as named`,
    ),
    (rows) => rows[0]?.accounts ?? 0,
  );

/**
 * The ledger this database belongs with. A database that names no ledger, a new server or one
 * from before the ledger had an ID, takes the ledger in BACKUP_DIR. It makes one when there is
 * none only when it holds no account, as no deleted account can then come back, or when
 * NEW_DELETION_LEDGER says every account it holds should exist. A database that names a ledger
 * refuses a missing ledger or another one, since serving from it would bring back every
 * account the lost ledger deleted.
 */
const checkLedger = (sql: PgClient.PgClient) =>
  Effect.gen(function* () {
    const ledger = yield* DeletionLedger;
    yield* lockLedger(sql);
    const named = yield* namedLedger(sql);
    const found = yield* ledger.read;
    if (Option.isNone(named)) {
      if (Option.isNone(found)) {
        const accounts = yield* accountsHeld(sql);
        if (accounts > 0 && !ledger.newLedgerOverAccounts) {
          return yield* new LedgerError({
            message: `The database holds ${accounts} accounts and names no deletion ledger, and ${ledger.path} is missing. A new ledger would let every account deleted after this database's backup come back. Check that BACKUP_DIR is the backup volume and that it is mounted. Only if the ledger is lost for good and every account in this database should exist, start or restore once with NEW_DELETION_LEDGER=true.`,
          });
        }
        yield* ledger.create;
        yield* accounts > 0
          ? Effect.logWarning(
              `NEW_DELETION_LEDGER is set, so made a new deletion ledger ${ledger.path} for a database that holds ${accounts} accounts. Every one of them now counts as an account that should exist, including any deleted after its backup. Unset NEW_DELETION_LEDGER now.`,
            )
          : Effect.logInfo(`Made the deletion ledger ${ledger.path}`);
      }
      const taken = Option.isSome(found) ? found : yield* ledger.read;
      if (Option.isNone(taken)) {
        return yield* new LedgerError({ message: `The deletion ledger ${ledger.path} is gone.` });
      }
      yield* sql`insert into deletion_ledger (id) values (${taken.value.id})`;
      return taken.value;
    }
    if (Option.isNone(found)) {
      return yield* new LedgerError({
        message: `The database names deletion ledger ${named.value}, but ${ledger.path} is missing. Check that BACKUP_DIR is the backup volume and that it is mounted. The server refuses to start or restore without its ledger, as it would serve accounts that were deleted.`,
      });
    }
    if (found.value.id !== named.value) {
      return yield* new LedgerError({
        message: `The database names deletion ledger ${named.value}, but ${ledger.path} is ledger ${found.value.id}. Check that BACKUP_DIR is this server's backup volume. The server refuses to start or restore with another ledger, as it would serve accounts that were deleted.`,
      });
    }
    return found.value;
  });

/**
 * Removes what a crash left in the ledger and checks the database's ledger, then deletes again
 * every account the ledger holds that the database does not know as deleted, as after a
 * restore from a backup taken before its deletion. Gives back how many it deleted.
 */
export const applyLedger = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* (yield* DeletionLedger).removeLeftovers;
  const { entries } = yield* sql.withTransaction(checkLedger(sql));
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

/**
 * Readies the database to serve, on every start and after every restore: migrates it, then
 * applies the deletion ledger.
 */
export const prepareDatabase = migrate.pipe(
  Effect.tap((applied) =>
    Effect.forEach(applied, ([id, name]) => Effect.logInfo(`Migrated ${id}_${name}`)),
  ),
  Effect.andThen(applyLedger),
);

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
              Effect.gen(function* () {
                yield* eraseAccount(sql, account, hash);
                const named = yield* namedLedger(sql);
                if (Option.isNone(named)) {
                  return yield* new LedgerError({
                    message: "The database names no deletion ledger. Start the server to make one.",
                  });
                }
                yield* ledger.record(named.value, { account, at, receipt: hash });
              }),
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
