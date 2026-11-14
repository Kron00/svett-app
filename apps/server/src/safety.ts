import { PgClient } from "@effect/sql-pg";
import {
  type AccountId,
  RATE_LIMITS,
  type RateLimit,
  type RateLimitGroup,
  takeToken,
} from "@svett/core";
import { Clock, Context, Data, Effect, Layer } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/** The account was deleted. Nothing it sends is stored again. */
export class AccountDeleted extends Data.TaggedError("AccountDeleted")<{}> {}

/** The account sent more requests of one group than its limit allows just now. */
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly group: RateLimitGroup;
  readonly retryAfterSeconds: number;
}> {}

/**
 * The first key of every account lock. PostgreSQL keeps two-key advisory locks apart from the
 * one-key locks the backups take, so the two never meet.
 */
const ACCOUNT_LOCK_SPACE = 5_150;

export interface SafetyShape {
  /**
   * Runs `effect` for `account` in one transaction that holds the account's lock shared, after
   * checking that the account was not deleted and taking a token of `group` when it names one.
   * Deleting the account takes the same lock alone, so a request either finishes before the
   * deletion starts or sees the account gone, and nothing it writes outlives the deletion. The
   * token counts whether or not the request succeeds.
   */
  readonly asAccount: <A, E, R>(
    account: AccountId,
    group: RateLimitGroup | undefined,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AccountDeleted | RateLimited | SqlError, R>;
  /**
   * Runs `effect` in one transaction that holds the account's lock alone, once every request
   * running for the account has finished.
   */
  readonly exclusively: <A, E, R>(
    account: AccountId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}

export class Safety extends Context.Service<Safety, SafetyShape>()("svett/server/Safety") {
  /** `limits` replaces the limits of the groups it names, as tests do to reach one quickly. */
  static readonly layer = (
    limits: Partial<Record<RateLimitGroup, RateLimit>> = {},
  ): Layer.Layer<Safety, never, PgClient.PgClient> =>
    Layer.effect(
      Safety,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const limitOf = (group: RateLimitGroup) => limits[group] ?? RATE_LIMITS[group];

        const take = (account: AccountId, group: RateLimitGroup) =>
          Effect.gen(function* () {
            const limit = limitOf(group);
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
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  select pg_advisory_xact_lock_shared(${ACCOUNT_LOCK_SPACE}, hashtext(${account}))
                `;
                const [deleted] = yield* sql`select 1 from deleted_account where id = ${account}`;
                if (deleted !== undefined) return yield* new AccountDeleted();
                if (group !== undefined) yield* take(account, group);
                // A refused request still spent its token, so the transaction commits whatever
                // the request answers. Each write that spans several rows has its own savepoint.
                return yield* Effect.exit(effect);
              }),
            ).pipe(Effect.flatMap((exit) => exit)),
          exclusively: (account, effect) =>
            sql.withTransaction(
              Effect.andThen(
                sql`select pg_advisory_xact_lock(${ACCOUNT_LOCK_SPACE}, hashtext(${account}))`,
                effect,
              ),
            ),
        });
      }),
    );
}
