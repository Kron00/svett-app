import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  type AccountId,
  RATE_LIMITS,
  type RateLimit,
  type RateLimitGroup,
  takeToken,
} from "@svett/core";
import { Clock, Context, Data, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { DeletionLedger, type LedgerError } from "./deletion-ledger.ts";

/** The account was deleted. Nothing it sends is stored again. */
export class AccountDeleted extends Data.TaggedError("AccountDeleted")<{}> {}

/** The account sent more requests of one group than its limit allows just now. */
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly group: RateLimitGroup;
  readonly retryAfterSeconds: number;
}> {}

/** Another account a write names is gone, or is being deleted right now. */
export class AccountGone extends Data.TaggedError("AccountGone")<{}> {}

/**
 * The first key of every account lock. PostgreSQL keeps two-key advisory locks apart from the
 * one-key locks the backups take, so the two never meet.
 */
const ACCOUNT_LOCK_SPACE = 5_150;

/** The accounts whose locks the running request's transaction holds. */
class HeldAccounts extends Context.Service<HeldAccounts, Set<string>>()(
  "svett/server/HeldAccounts",
) {}

/**
 * Takes the lock of `account` alone, inside the running transaction, as deleting it does.
 * It waits for every request that holds the lock shared.
 */
export const lockAlone = (sql: PgClient.PgClient, account: string) =>
  sql`select pg_advisory_xact_lock(${ACCOUNT_LOCK_SPACE}, hashtext(${account}))`;

/**
 * Holds the lock of `other`, an account the running write names, until its transaction ends,
 * then checks that the account still exists and was not deleted, in the database or in the
 * deletion ledger. A deletion of `other` then
 * either finished before, and this fails with AccountGone, or waits for the write to commit
 * and deletes what it wrote. Call it before the write takes any row lock.
 *
 * A request waits for account locks only in ascending order of account ID. One it would have
 * to wait for out of order, below a lock it already holds, is tried instead, and only a
 * deletion of that account in progress holds it, so the write fails with AccountGone. No two
 * transactions can then wait for each other's account locks.
 */
export const lockOther = (sql: PgClient.PgClient, other: string) =>
  Effect.gen(function* () {
    const held = Option.getOrElse(
      yield* Effect.serviceOption(HeldAccounts),
      () => new Set<string>(),
    );
    if (!held.has(other)) {
      if ([...held].every((account) => account < other)) {
        yield* sql`select pg_advisory_xact_lock_shared(${ACCOUNT_LOCK_SPACE}, hashtext(${other}))`;
      } else {
        const [tried] = yield* sql<{ readonly locked: boolean }>`
          select pg_try_advisory_xact_lock_shared(${ACCOUNT_LOCK_SPACE}, hashtext(${other}))
            as locked
        `;
        if (tried?.locked !== true) return yield* new AccountGone();
      }
      held.add(other);
    }
    const ledger = yield* Effect.serviceOption(DeletionLedger);
    if (
      Option.isSome(ledger) &&
      (yield* Effect.orDie(ledger.value.deletionsOf(other))).length > 0
    ) {
      return yield* new AccountGone();
    }
    const [present] = yield* sql`
      select 1 from account a
      where a.id = ${other} and not exists (select 1 from deleted_account d where d.id = a.id)
    `;
    if (present === undefined) return yield* new AccountGone();
  });

/**
 * The first key of every pair lock, beside the account locks' space and the ledger's lock
 * space, so it meets neither.
 */
const PAIR_LOCK_SPACE = 5_152;

/**
 * Holds the lock of the two accounts `a` and `b` alone until the running transaction ends,
 * the same lock whichever comes first. Block, unblock, follow, approve and remove-follower each
 * take it for their pair and then check for a block, so a follow or request either commits
 * before a block, which then removes it, or sees the block and is refused. A row that does not
 * exist yet has no row lock to wait for, which is why this is a lock of its own. Take it after
 * every account lock and before touching a follow, block or profile row, so a write that holds
 * it never waits for one that waits for it.
 */
export const lockPair = (sql: PgClient.PgClient, a: string, b: string) => {
  const [low, high] = a < b ? [a, b] : [b, a];
  return sql`select pg_advisory_xact_lock(${PAIR_LOCK_SPACE}, hashtext(${`${low} ${high}`}))`;
};

export interface SafetyShape {
  /**
   * Runs `effect` for `account` in one transaction that holds the account's lock shared, after
   * checking that the account was not deleted and taking a token of `group` when it names one.
   * An account is deleted once the deletion ledger holds it, before the database marks it, so
   * a deletion whose mark failed still refuses the account while the server finishes it. The
   * check reads the ledger's directory again when it changed, so it sees another server's
   * entries too.
   * Deleting the account takes the same lock alone, so a request either finishes before the
   * deletion starts or sees the account gone, and nothing it writes outlives the deletion. A
   * write that names another account takes that account's lock too, through `lockOther`. The
   * token counts whether or not the request succeeds.
   */
  readonly asAccount: <A, E, R>(
    account: AccountId,
    group: RateLimitGroup | undefined,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AccountDeleted | RateLimited | SqlError | LedgerError, R>;
  /**
   * Runs `effect` in one transaction that holds the account's lock alone, once every request
   * running for the account has finished.
   */
  readonly exclusively: <A, E, R>(
    account: AccountId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
  /**
   * Takes a token of `group` for a caller with no account, by the network address it came
   * from, in a transaction of its own. Only a hash of the address is kept.
   */
  readonly limitAddress: (
    address: string,
    group: RateLimitGroup,
  ) => Effect.Effect<void, RateLimited | SqlError>;
  /**
   * Forgets the buckets of addresses that asked nothing since `beforeMillis`, which have long
   * filled again. Gives back how many it forgot.
   */
  readonly forgetAddresses: (beforeMillis: number) => Effect.Effect<number, SqlError>;
}

/** Address buckets share the rate limit table, under keys no account ID can take. */
const ADDRESS_KEY = "address:";

export class Safety extends Context.Service<Safety, SafetyShape>()("svett/server/Safety") {
  /** `limits` replaces the limits of the groups it names, as tests do to reach one quickly. */
  static readonly layer = (
    limits: Partial<Record<RateLimitGroup, RateLimit>> = {},
  ): Layer.Layer<Safety, never, PgClient.PgClient | DeletionLedger> =>
    Layer.effect(
      Safety,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ledger = yield* DeletionLedger;

        const take = (account: string, group: RateLimitGroup) =>
          Effect.gen(function* () {
            const limit = limits[group] ?? RATE_LIMITS[group];
            const now = yield* Clock.currentTimeMillis;
            yield* sql`
              insert into rate_limit (account_id, route_group, tokens, at_ms)
              values (${account}, ${group}, ${limit.capacity}, ${now})
              on conflict do nothing
            `;
            const [stored] = yield* sql<{ readonly tokens: number; readonly atMs: string }>`
              select tokens, at_ms as "atMs" from rate_limit
              where account_id = ${account} and route_group = ${group}
              for update
            `;
            const taken = takeToken(
              stored === undefined
                ? undefined
                : { tokens: Number(stored.tokens), atMillis: Number(stored.atMs) },
              limit,
              now,
            );
            yield* sql`
              update rate_limit set tokens = ${taken.bucket.tokens}, at_ms = ${taken.bucket.atMillis}
              where account_id = ${account} and route_group = ${group}
            `;
            if (!taken.allowed) {
              return yield* new RateLimited({ group, retryAfterSeconds: taken.retryAfterSeconds });
            }
          });

        return Safety.of({
          asAccount: (account, group, effect) =>
            sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`
                  select pg_advisory_xact_lock_shared(${ACCOUNT_LOCK_SPACE}, hashtext(${account}))
                `;
                  if ((yield* ledger.deletionsOf(account)).length > 0) {
                    return yield* new AccountDeleted();
                  }
                  const [deleted] = yield* sql`select 1 from deleted_account where id = ${account}`;
                  if (deleted !== undefined) return yield* new AccountDeleted();
                  if (group !== undefined) yield* take(account, group);
                  // A refused request still spent its token, so the transaction commits whatever
                  // the request answers. Each write that spans several rows has its own savepoint.
                  return yield* Effect.exit(
                    effect.pipe(
                      Effect.provideService(HeldAccounts, new Set([account])),
                      Effect.provideService(DeletionLedger, ledger),
                    ),
                  );
                }),
              )
              .pipe(Effect.flatMap((exit) => exit)),
          exclusively: (account, effect) =>
            sql.withTransaction(Effect.andThen(lockAlone(sql, account), effect)),
          limitAddress: (address, group) =>
            sql.withTransaction(
              take(`${ADDRESS_KEY}${createHash("sha256").update(address).digest("hex")}`, group),
            ),
          forgetAddresses: (beforeMillis) =>
            Effect.map(
              sql`
                delete from rate_limit
                where starts_with(account_id, ${ADDRESS_KEY}) and at_ms < ${beforeMillis}
                returning 1
              `,
              (rows) => rows.length,
            ),
        });
      }),
    );
}
