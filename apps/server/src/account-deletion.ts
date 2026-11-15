import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import type { AccountId } from "@svett/core";
import { Clock, Context, Effect, Exit, Layer, Option } from "effect";
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
  oauth_code: ["account_id"],
  assistant_connection: ["account_id"],
  assistant_refresh_used: ["account_id"],
  assistant_access: ["account_id"],
  assistant_proposal: ["account_id"],
};

/** The tables a deletion leaves, and why. */
export const KEPT_TABLES: Readonly<Record<string, string>> = {
  deleted_account:
    "It keeps the deleted account's ID alone, so nothing recreates the account, and whether Clerk ended its sessions.",
  deletion_receipt: "It keeps the hash of a deletion's receipt alone, and names no account.",
  deletion_ledger: "It keeps the deletion ledger's ID alone, and names no account.",
  effect_sql_migrations: "The migrator's record of the schema. It names no account.",
  oauth_client:
    "It keeps an app's name and where it sends people back after sign-in, and names no account.",
};

/** The hash the server keeps of a receipt the phone sent with a deletion. */
export const receiptHash = (receipt: string) => createHash("sha256").update(receipt).digest("hex");

/** Records the hashes of a deletion's receipts, so any server can answer for them. */
const keepReceipts = (sql: PgClient.PgClient, receipts: ReadonlyArray<string | null>) =>
  Effect.forEach(
    receipts.filter((receipt) => receipt !== null),
    (receipt) => sql`
      insert into deletion_receipt (receipt_hash) values (${receipt}) on conflict do nothing
    `,
    { discard: true },
  );

/**
 * Marks `account` deleted in the database, with the hashes of its receipts, and nothing else,
 * so the transaction stays small and commits even when deleting the rows fails. From its commit
 * every server refuses the account and every read leaves it out. It runs inside a transaction
 * that holds the account's lock alone.
 */
const markDeleted = (
  sql: PgClient.PgClient,
  account: string,
  receipts: ReadonlyArray<string | null>,
) =>
  Effect.andThen(
    sql`insert into deleted_account (id) values (${account}) on conflict do nothing`,
    keepReceipts(sql, receipts),
  );

/**
 * Deletes every row of `account` in every table and marks it deleted with its rows gone, with
 * the hashes of its receipts. It runs inside a transaction that holds the account's lock alone.
 */
const eraseAccount = (
  sql: PgClient.PgClient,
  account: string,
  receipts: ReadonlyArray<string | null>,
) =>
  Effect.gen(function* () {
    yield* sql`
      insert into deleted_account (id, rows_deleted) values (${account}, true)
      on conflict (id) do update set rows_deleted = true
    `;
    yield* keepReceipts(sql, receipts);
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
 * every account the ledger holds whose rows the database does not know as deleted, as after a
 * restore from a backup taken before its deletion, or after a deletion that stopped part way.
 * Gives back how many it deleted.
 */
export const applyLedger = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* (yield* DeletionLedger).removeLeftovers;
  const { entries } = yield* sql.withTransaction(checkLedger(sql));
  if (entries.length === 0) return 0;
  const deleted = new Set(
    (yield* sql<{ readonly id: string }>`
      select id from deleted_account where rows_deleted
    `).map(({ id }) => id),
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
        eraseAccount(sql, entry.account, [entry.receipt]),
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
 * applies the deletion ledger. A start then ends the sessions of each deleted account, through
 * `AccountDeletion.finishAccepted`.
 */
export const prepareDatabase = migrate.pipe(
  Effect.tap((applied) =>
    Effect.forEach(applied, ([id, name]) => Effect.logInfo(`Migrated ${id}_${name}`)),
  ),
  Effect.andThen(applyLedger),
);

export interface AccountDeletionShape {
  /**
   * Deletes `account` in three steps. It records the deletion in the ledger, and once the entry
   * is renamed into place the deletion is accepted. It then marks the account deleted in the
   * database in a small transaction of its own, after which every server refuses the account
   * and every read leaves it out. Last it deletes every row of the account in every table and
   * deletes its Clerk user, which ends every session. Nothing changes when the server could not
   * end sessions at all, or when the deletion fails before its ledger entry is in place. When a
   * later step fails, the server refuses the account from the ledger in memory, and keeps
   * trying in the background from the first step not done. Running it again for a deleted
   * account finishes it too. `receipt` is a secret the phone made, which `deleted` takes later
   * to tell the phone the deletion happened, once its session is gone with the account.
   */
  readonly remove: (
    account: AccountId,
    receipt?: string,
  ) => Effect.Effect<void, SqlError | SessionEndFailed | LedgerError>;
  /** Whether a deletion sent with `receipt` was accepted. */
  readonly deleted: (receipt: string) => Effect.Effect<boolean, SqlError | LedgerError>;
  /**
   * Ends the sessions of every deleted account whose Clerk user may still be there, on every
   * start once `prepareDatabase` deleted the ledger's accounts again. One that fails is left
   * to the background. Gives back how many it tried.
   */
  readonly finishAccepted: Effect.Effect<number, SqlError>;
}

/** How long the background waits before it tries to finish a deletion again, at first and at most. */
export const FINISH_RETRY_MS = { first: 1_000, most: 5 * 60_000 };

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
      const scope = yield* Effect.scope;
      const finishing = new Set<string>();

      const endSessions = (account: string) =>
        clerk
          .deleteUser(account as AccountId)
          .pipe(
            Effect.andThen(
              sql`update deleted_account set sessions_ended = true where id = ${account}`,
            ),
          );

      /**
       * Finishes the deletion the ledger accepted for `account`, from the first step not done.
       * It marks the account deleted, with every receipt the ledger holds for it, in its own
       * transaction, then deletes its rows, then its Clerk user. Each step is safe to run twice,
       * and Clerk counts a user that is gone as deleted.
       */
      const finish = (account: string) =>
        Effect.gen(function* () {
          const receipts = (yield* ledger.deletionsOf(account)).map(({ receipt }) => receipt);
          yield* safety.exclusively(account as AccountId, markDeleted(sql, account, receipts));
          const [done] = yield* sql<{
            readonly rowsDeleted: boolean;
            readonly sessionsEnded: boolean;
          }>`
            select rows_deleted as "rowsDeleted", sessions_ended as "sessionsEnded"
            from deleted_account where id = ${account}
          `;
          if (done?.rowsDeleted !== true) {
            yield* safety.exclusively(account as AccountId, eraseAccount(sql, account, receipts));
          }
          if (done?.sessionsEnded !== true) yield* endSessions(account);
        });

      /** Keeps trying to finish the deletion of `account`, waiting longer each time. */
      const retry = (account: string, wait: number): Effect.Effect<void> =>
        Effect.sleep(wait).pipe(
          Effect.andThen(finish(account)),
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not finish an accepted deletion yet, trying again. ${String(error)}`,
            ).pipe(Effect.andThen(retry(account, Math.min(wait * 2, FINISH_RETRY_MS.most)))),
          ),
        );

      const finishLater = (account: string) =>
        Effect.suspend(() => {
          if (finishing.has(account)) return Effect.void;
          finishing.add(account);
          return Effect.asVoid(
            Effect.forkIn(
              retry(account, FINISH_RETRY_MS.first).pipe(
                Effect.tap(() => Effect.logInfo("Finished an accepted deletion")),
                Effect.ensuring(Effect.sync(() => finishing.delete(account))),
              ),
              scope,
            ),
          );
        });

      /** Finishes the deletion of `account` in the background, if the ledger accepted it. */
      const finishIfAccepted = (account: string) =>
        ledger.deletionsOf(account).pipe(
          Effect.flatMap((entries) => (entries.length > 0 ? finishLater(account) : Effect.void)),
          Effect.ignore,
        );

      // Another server's entry may be all the database will ever get of a deletion, when that
      // server died before marking the account. Whichever server reads the entry finishes it.
      yield* Effect.forkIn(
        Effect.forever(
          Effect.flatMap(ledger.found, (accounts) =>
            Effect.forEach(
              accounts,
              (account) =>
                finish(account).pipe(
                  Effect.tap(() =>
                    Effect.logInfo("Finished a deletion another server recorded in the ledger"),
                  ),
                  Effect.catch(() => finishLater(account)),
                ),
              { concurrency: 4, discard: true },
            ),
          ),
        ),
        scope,
      );

      return AccountDeletion.of({
        remove: (account, receipt) =>
          Effect.gen(function* () {
            yield* clerk.available;
            const hash = receipt === undefined ? null : receiptHash(receipt);
            const at = yield* Clock.currentTimeMillis;
            const named = yield* namedLedger(sql);
            if (Option.isNone(named)) {
              return yield* new LedgerError({
                message: "The database names no deletion ledger. Start the server to make one.",
              });
            }
            const recorded = yield* Effect.exit(
              ledger.record(named.value, { account, at, receipt: hash }),
            );
            if (Exit.isFailure(recorded)) {
              // The directory's sync can fail after the rename, and the deletion is accepted.
              const entries = yield* ledger.deletionsOf(account);
              if (!entries.some((entry) => entry.receipt === hash)) return yield* recorded;
              yield* Effect.logWarning(
                "The deletion ledger failed after it accepted a deletion, so the deletion goes on",
              );
            }
            yield* finish(account).pipe(Effect.tapError(() => finishLater(account)));
            yield* Effect.logInfo("Deleted an account");
          }).pipe(
            // A request cut off once the entry is in place still leaves a deletion to finish.
            Effect.onInterrupt(() => finishIfAccepted(account)),
          ),
        deleted: (receipt) =>
          Effect.gen(function* () {
            const hash = receiptHash(receipt);
            if (yield* ledger.holdsReceipt(hash)) return true;
            const rows = yield* sql`select 1 from deletion_receipt where receipt_hash = ${hash}`;
            return rows.length > 0;
          }),
        finishAccepted: Effect.gen(function* () {
          const pending = yield* sql<{ readonly id: string }>`
            select id from deleted_account where not sessions_ended
          `;
          yield* Effect.forEach(
            pending,
            ({ id }) =>
              endSessions(id).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    `Could not end a deleted account's sessions on start, trying again. ${String(error)}`,
                  ).pipe(Effect.andThen(finishLater(id))),
                ),
              ),
            { concurrency: 8, discard: true },
          );
          return pending.length;
        }),
      });
    }),
  );
}

/**
 * Readies the server to serve: prepares the database, then ends the sessions of every deleted
 * account whose Clerk user may still be there.
 */
export const readyToServe = prepareDatabase.pipe(
  Effect.andThen(
    Effect.flatMap(Effect.service(AccountDeletion), (deletion) => deletion.finishAccepted),
  ),
);
