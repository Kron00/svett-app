import { Context, Data, Effect, Exit, Layer, Semaphore } from "effect";

export type SqlValue = string | number | null;
export type SqlRow = Readonly<Record<string, SqlValue>>;

/**
 * The few calls the repositories need from a SQLite connection.
 * The app implements it with expo-sqlite, tests and scripts with node:sqlite.
 */
export interface SqlDriver {
  readonly all: (sql: string, params: ReadonlyArray<SqlValue>) => Promise<ReadonlyArray<SqlRow>>;
  readonly run: (sql: string, params: ReadonlyArray<SqlValue>) => Promise<void>;
  readonly exec: (sql: string) => Promise<void>;
}

export class SqlError extends Data.TaggedError("SqlError")<{
  readonly sql: string;
  readonly cause: unknown;
}> {}

const InTransaction = Context.Reference<boolean>("svett/Sql/InTransaction", {
  defaultValue: () => false,
});

export interface SqlService {
  readonly all: (
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ) => Effect.Effect<ReadonlyArray<SqlRow>, SqlError>;
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<void, SqlError>;
  readonly exec: (sql: string) => Effect.Effect<void, SqlError>;
  /** Runs `effect` in one SQLite transaction. Nested calls join the outer one. */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}

export class Sql extends Context.Service<Sql, SqlService>()("svett/Sql") {
  static readonly layer = (driver: SqlDriver): Layer.Layer<Sql> =>
    Layer.effect(Sql, makeSql(driver));
}

const call = <A>(sql: string, use: () => Promise<A>) =>
  Effect.tryPromise({ try: use, catch: (cause) => new SqlError({ sql, cause }) });

const makeSql = (driver: SqlDriver) =>
  Effect.gen(function* () {
    // One connection serves every fiber, so a statement from another fiber must not
    // land inside someone else's open transaction.
    const lock = yield* Semaphore.make(1);

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.service(InTransaction), (inside) =>
        inside ? effect : lock.withPermits(1)(effect),
      );

    return Sql.of({
      all: (sql, params = []) => serialized(call(sql, () => driver.all(sql, params))),
      run: (sql, params = []) => serialized(call(sql, () => driver.run(sql, params))),
      exec: (sql) => serialized(call(sql, () => driver.exec(sql))),
      transaction: (effect) =>
        Effect.flatMap(Effect.service(InTransaction), (inside) =>
          inside
            ? effect
            : lock.withPermits(1)(
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    yield* call("BEGIN", () => driver.exec("BEGIN"));
                    const exit = yield* Effect.exit(
                      restore(Effect.provideService(effect, InTransaction, true)),
                    );
                    const end = Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK";
                    yield* call(end, () => driver.exec(end));
                    return yield* exit;
                  }),
                ),
              ),
        ),
    });
  });
