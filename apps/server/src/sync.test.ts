import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import {
  ActivityRepository,
  type ActivityId,
  EpochMillis,
  Fingerprint,
  HistoryRepository,
  type ImportBatchId,
  ImportRepository,
  MADE_HERE,
  MeasurementRepository,
  SourceIdentity,
  syncOnce,
  SyncRepository,
  httpSyncApi,
  changeIdOf,
  contentFingerprint,
  databaseLayer as phoneDatabaseLayer,
  decodeHevyFile,
  hevyImport,
  TransferRepository,
  wallTimeAsUtc,
  Ids,
  type SqlDriver,
  SyncFailed,
  DRAFT_MESSAGE,
  type PushedRow,
  SYNC_PROTOCOL_VERSION,
  SYNC_VERSION_HEADER,
} from "@svett/core";
import {
  legDay,
  manualClock,
  startPushDay,
  workoutRows,
  openNodeDatabase,
  openTestDatabase,
  syncedRows,
  T0,
} from "@svett/core/node";
import { Effect, Exit, Layer, ManagedRuntime, Option, Result } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AccountRoutes } from "./account-routes.ts";
import { AccountRows } from "./account-rows.ts";
import { Sessions } from "./auth.ts";
import { ClerkConfig } from "./clerk-config.ts";
import { databaseLayer, migrate } from "./database.ts";
import { type StandInIssuer, startStandInIssuer } from "./test-issuer.ts";
import { startTestPostgres, type TestPostgres } from "./test-postgres.ts";

let postgres: TestPostgres;
let issuer: StandInIssuer;
let databases = 0;
const servers: Array<{ readonly dispose: () => Promise<void> }> = [];

beforeAll(async () => {
  [postgres, issuer] = await Promise.all([startTestPostgres(), startStandInIssuer()]);
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => server.dispose()));
  await Promise.all([postgres?.stop(), issuer?.stop()]);
});

const ALICE = "user_alice";
const BOB = "user_bob";
const MINUTE = 60_000;

/** The svett server on a fresh, migrated database, listening on a free port. */
const startServer = async () => {
  const url = await postgres.createDatabase(`sync_${++databases}`);
  await Effect.runPromise(migrate.pipe(Effect.provide(databaseLayer(url))));
  const clerk = Layer.succeed(
    ClerkConfig,
    ClerkConfig.of({
      signIn: "configured",
      issuer: issuer.issuer,
      jwksUrl: issuer.jwksUrl,
      authorizedParties: [],
      audience: undefined,
    }),
  );
  const services = Layer.mergeAll(AccountRows.layer, Sessions.layer).pipe(
    Layer.provide(databaseLayer(url)),
    Layer.provide(clerk),
  );
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(AccountRoutes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
      Layer.provide(services),
    ),
  );
  servers.push(runtime);
  const address = await runtime.runPromise(
    Effect.map(Effect.service(HttpServer.HttpServer), (server) => server.address),
  );
  if (!("port" in address)) throw new Error("The server is not on TCP");
  return `http://127.0.0.1:${address.port}`;
};

/** A phone's database for `account`, with its own clock and its own sync queue. */
const openPhone = (server: string, account: string, seed: number) => {
  const database = openTestDatabase(seed);
  const run = <A, E>(
    effect: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof database.runtime>>,
  ) => database.runtime.runPromise(effect);
  const api = (token = () => issuer.sessionToken(account)) =>
    httpSyncApi({ server, accountId: account, token, fetch });
  return {
    ...database,
    run,
    api,
    /** One sync with the session of `account`, or of another account with `as`. */
    sync: (as = account) => run(syncOnce(api(() => issuer.sessionToken(as)))),
    at: (millis: number) => run(database.clock.set(millis)),
    rows: () => syncedRows(database.runtime),
  };
};
type Phone = ReturnType<typeof openPhone>;

const activities = Effect.service(ActivityRepository);

const logLegDay = (phone: Phone) =>
  phone.run(Effect.flatMap(activities, (repository) => repository.create(legDay(MADE_HERE))));

const detail = (phone: Phone, id: ActivityId) =>
  phone.run(Effect.flatMap(activities, (repository) => repository.get(id)));

const firstSet = async (phone: Phone, id: ActivityId) => {
  const set = Option.getOrThrow(await detail(phone, id)).exercises[0]?.sets[0];
  if (set === undefined) throw new Error("The workout has no sets");
  return set;
};

const editFirstSet = async (phone: Phone, id: ActivityId, reps: number) => {
  const set = await firstSet(phone, id);
  return phone.run(
    Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps })),
  );
};

const activityIds = async (phone: Phone) =>
  ((await phone.rows())["activity"] as ReadonlyArray<{ readonly id: string }>).map(({ id }) => id);

const counts = (phone: Phone) =>
  phone.run(Effect.flatMap(activities, (repository) => repository.counts));

const reopen = (phone: Phone, id: ActivityId) =>
  phone.run(
    Effect.flatMap(activities, (repository) => repository.update(id, { status: "in_progress" })),
  );

const finish = (phone: Phone, id: ActivityId) =>
  phone.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(id)));

/** Adds a done set of `reps` to the first exercise of the workout in progress `id`. */
const addDoneSet = (phone: Phone, id: ActivityId, reps: number) =>
  phone.run(
    Effect.flatMap(activities, (repository) =>
      Effect.gen(function* () {
        const workout = Option.getOrThrow(yield* repository.get(id));
        const exercise = workout.exercises[0]?.exercise;
        if (exercise === undefined) throw new Error("The workout has no exercises");
        const setId = yield* repository.addSet(exercise.id, {
          setType: "normal",
          weightKg: 110,
          reps,
          durationS: null,
          distanceM: null,
          targetRepsMin: null,
          targetRepsMax: null,
        });
        yield* repository.updateWorkoutSet(setId, { done: true });
        return setId;
      }),
    ),
  );

const setsOf = async (phone: Phone, id: ActivityId) =>
  Option.getOrThrow(await detail(phone, id)).exercises.flatMap(({ sets }) =>
    sets.map(({ id: setId, reps }) => ({ setId, reps })),
  );

/** Every order of `items`. */
const orders = <A>(items: ReadonlyArray<A>): Array<ReadonlyArray<A>> =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        orders(items.filter((_, other) => other !== index)).map((rest) => [item].concat(rest)),
      );

/** Runs `step` on each item, one after another, as phones that sync in turn do. */
const inTurn = <A>(items: ReadonlyArray<A>, step: (item: A) => Promise<unknown>) =>
  items.reduce<Promise<unknown>>((done, item) => done.then(() => step(item)), Promise.resolve());

/** Syncs each phone in turn, twice, so every phone has every other phone's changes. */
const syncAll = (phones: ReadonlyArray<Phone>) =>
  inTurn([...phones, ...phones], (phone) => phone.sync());

/** A workout on `phone` that every phone in `others` has pulled. */
const sharedLegDay = async (phone: Phone, others: ReadonlyArray<Phone>) => {
  const id = await logLegDay(phone);
  await syncAll([phone, ...others]);
  return id;
};

const queuedCount = (phone: Phone) =>
  phone.run(Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queuedCount));

const remove = (phone: Phone, id: ActivityId) =>
  phone.run(Effect.flatMap(activities, (repository) => repository.remove(id)));

const undo = (phone: Phone, id: ActivityId) =>
  phone.run(Effect.flatMap(activities, (repository) => repository.restore(id)));

/** The change ID of the copy of `set` that `phone` would send. */
const queuedChangeId = async (phone: Phone, setId: string) => {
  const queued = await phone.run(
    Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queued(undefined)),
  );
  const copy = queued.find(({ id }) => id === setId);
  if (copy === undefined) throw new Error("The set is not queued");
  return changeIdOf("activity_set", copy.row);
};

/** True when `rows` holds the workout `id` as deleted. */
const holdsDeleted = (id: ActivityId) => (rows: ReadonlyArray<PushedRow>) =>
  rows.some(
    ({ table, row }) =>
      table === "activity" &&
      (row as { id: string }).id === id &&
      (row as { deletedAt: number | null }).deletedAt !== null,
  );

/**
 * `phone`'s sync API, where `during` runs once while the first push that `when` matches is
 * on the way. It "arrives" at the server and its answer comes back, it arrives and its answer
 * is lost, or it never arrives.
 */
const pushWith = (
  phone: Phone,
  when: (rows: ReadonlyArray<PushedRow>) => boolean,
  during: () => Promise<unknown>,
  outcome: "confirmed" | "answer lost" | "never arrived",
) => {
  const api = phone.api();
  const lost = new SyncFailed({ problem: "offline", message: "The push was cut off." });
  let ran = false;
  const push = (rows: ReadonlyArray<PushedRow>) => {
    if (ran || !when(rows)) return api.push(rows);
    ran = true;
    const meanwhile = Effect.promise(during);
    if (outcome === "never arrived") return Effect.andThen(meanwhile, Effect.fail(lost));
    return Effect.flatMap(api.push(rows), (result) =>
      Effect.andThen(
        meanwhile,
        outcome === "confirmed" ? Effect.succeed(result) : Effect.fail(lost),
      ),
    );
  };
  return { ...api, push };
};

/** Checks that both phones hold the same rows, the workout `id` with `sets`, and nothing queued. */
const expectBothKept = async (phones: readonly [Phone, Phone], id: ActivityId, sets: unknown) => {
  expect(await phones[0].rows()).toEqual(await phones[1].rows());
  const seen = await Promise.all(
    phones.map(async (phone) => ({
      sets: await setsOf(phone, id),
      queued: await queuedCount(phone),
    })),
  );
  expect(seen).toEqual(phones.map(() => ({ sets, queued: 0 })));
};

describe("sync", { timeout: 120_000 }, () => {
  it("brings two phones on one account to the same data after offline edits on both", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const shared = await sharedLegDay(a, [b]);

    await a.at(T0 + MINUTE);
    await logLegDay(a);
    await editFirstSet(a, shared, 6);
    await b.at(T0 + 2 * MINUTE);
    await b.run(
      Effect.flatMap(Effect.service(MeasurementRepository), (repository) =>
        repository.create({
          kind: "body_weight",
          measuredAt: EpochMillis.make(T0),
          value: 80,
          origin: MADE_HERE,
        }),
      ),
    );
    await b.run(
      Effect.flatMap(activities, (repository) => repository.update(shared, { title: "Leg day" })),
    );

    await syncAll([a, b]);
    expect(await a.rows()).toEqual(await b.rows());
    expect(await counts(b)).toEqual({ activities: 2, sets: 8 });
    const merged = Option.getOrThrow(await detail(b, shared));
    expect(merged.activity.title).toBe("Leg day");
    expect(merged.exercises[0]?.sets[0]?.reps).toBe(6);
  });

  it.each(orders([0, 1, 2]))(
    "ends with the newest change to a row when phones %i, %i and %i sync in that order",
    async (...order) => {
      const server = await startServer();
      const phones = [1, 2, 3].map((seed) => openPhone(server, ALICE, seed));
      const [first, ...others] = phones as [Phone, Phone, Phone];
      const id = await sharedLegDay(first, others);
      await inTurn([...phones.entries()], async ([index, phone]) => {
        await phone.at(T0 + (index + 1) * MINUTE);
        await editFirstSet(phone, id, 10 + index);
      });
      await inTurn(order, (index) => phones[index]?.sync() ?? Promise.resolve());
      await syncAll(phones);
      const rows = await Promise.all(phones.map((phone) => phone.rows()));
      for (const other of rows) expect(other).toEqual(rows[0]);
      expect((await firstSet(first, id)).reps).toBe(12);
    },
  );

  it.each(orders([0, 1]))(
    "picks the higher change ID of two changes with equal times when phones %i and %i sync in that order",
    async (...order) => {
      const server = await startServer();
      const phones = [openPhone(server, ALICE, 1), openPhone(server, ALICE, 2)] as const;
      const id = await sharedLegDay(phones[0], [phones[1]]);
      const set = await firstSet(phones[0], id);
      await inTurn([...phones.entries()], async ([index, phone]) => {
        await phone.at(T0 + MINUTE);
        await editFirstSet(phone, id, 20 + index);
      });
      const [zero, one] = await Promise.all(phones.map((phone) => queuedChangeId(phone, set.id)));
      await inTurn(order, (index) => phones[index]?.sync() ?? Promise.resolve());
      await syncAll(phones);
      expect(await phones[0].rows()).toEqual(await phones[1].rows());
      expect((await firstSet(phones[1], id)).reps).toBe((one ?? "") > (zero ?? "") ? 21 : 20);
    },
  );

  it("does not undo a newer edit when it retries a change whose confirmation was lost", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);

    await a.at(T0 + MINUTE);
    await editFirstSet(a, id, 6);
    const api = a.api();
    // The server applies the push, and its answer never reaches the phone.
    const lost = await a.run(
      Effect.exit(
        syncOnce({
          ...api,
          push: (rows) =>
            Effect.flatMap(api.push(rows), () =>
              Effect.fail(new SyncFailed({ problem: "offline", message: "The answer was lost." })),
            ),
        }),
      ),
    );
    expect(Exit.isFailure(lost)).toBe(true);
    expect(
      await a.run(Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queuedCount)),
    ).toBeGreaterThan(0);

    await b.sync();
    await b.at(T0 + 2 * MINUTE);
    await editFirstSet(b, id, 7);
    await b.sync();

    await a.sync();
    await b.sync();
    expect((await firstSet(a, id)).reps).toBe(7);
    expect(await a.rows()).toEqual(await b.rows());
  });

  it.each([
    { when: "after", editAt: 2 * MINUTE, order: [0, 1] },
    { when: "after", editAt: 2 * MINUTE, order: [1, 0] },
    { when: "before", editAt: MINUTE / 2, order: [0, 1] },
    { when: "before", editAt: MINUTE / 2, order: [1, 0] },
  ])(
    "keeps a workout one phone deleted when the other edits its set $when the delete, syncing in order $order",
    async ({ editAt, order }) => {
      const server = await startServer();
      const deleter = openPhone(server, ALICE, 1);
      const editor = openPhone(server, ALICE, 2);
      const phones = [deleter, editor];
      const id = await sharedLegDay(deleter, [editor]);

      await deleter.at(T0 + MINUTE);
      await deleter.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
      await editor.at(T0 + editAt);
      await editFirstSet(editor, id, 9);

      await inTurn(order, (index) => phones[index]?.sync() ?? Promise.resolve());
      await syncAll(phones);
      expect(await deleter.rows()).toEqual(await editor.rows());
      await inTurn(phones, async (phone) => {
        expect(await counts(phone)).toEqual({ activities: 0, sets: 0 });
        expect(Option.isNone(await detail(phone, id))).toBe(true);
        const history = await phone.run(
          Effect.flatMap(Effect.service(HistoryRepository), (repository) =>
            repository.page({ limit: 10 }),
          ),
        );
        expect(history).toEqual([]);
      });

      // The edit is dropped everywhere, and nothing waits to upload.
      const queued = await Promise.all(
        phones.map((phone) =>
          phone.run(Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queuedCount)),
        ),
      );
      expect(queued).toEqual([0, 0]);

      // Undo brings the workout back on both phones as it was when it was deleted.
      await deleter.at(T0 + 3 * MINUTE);
      await deleter.run(Effect.flatMap(activities, (repository) => repository.restore(id)));
      await syncAll(phones);
      expect(await deleter.rows()).toEqual(await editor.rows());
      expect(await counts(editor)).toEqual({ activities: 1, sets: 4 });
      const restored = Option.getOrThrow(await detail(editor, id));
      expect(
        restored.exercises.map(({ sets }) => sets.map(({ weightKg, reps }) => [weightKg, reps])),
      ).toEqual([
        [
          [100, 5],
          [100, 5],
          [105, 5],
        ],
        [[40, 12]],
      ]);
    },
  );

  it("keeps an edit made while its push was on the way, in the same millisecond", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);
    await a.at(T0 + MINUTE);
    await editFirstSet(a, id, 6);
    const api = a.api();
    let edited = false;
    // The phone's clock has not moved when the edit to 12 lands, before the server answers.
    await a.run(
      syncOnce({
        ...api,
        push: (rows) =>
          Effect.flatMap(
            Effect.promise(async () => {
              if (edited) return;
              edited = true;
              await editFirstSet(a, id, 12);
            }),
            () => api.push(rows),
          ),
      }),
    );
    expect((await firstSet(a, id)).reps).toBe(12);
    await syncAll([a, b]);
    expect((await firstSet(a, id)).reps).toBe(12);
    expect((await firstSet(b, id)).reps).toBe(12);
    expect(await a.rows()).toEqual(await b.rows());
    expect(
      await a.run(Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queuedCount)),
    ).toBe(0);
  });

  it("uploads nothing from the first account after signing in as a second", async () => {
    const server = await startServer();
    const alice = openPhone(server, ALICE, 1);
    await logLegDay(alice);
    await alice.sync();

    // The same phone, after signing out and in as Bob, opens Bob's own database.
    const bob = openPhone(server, BOB, 2);
    expect(await bob.sync()).toEqual({ pushed: 0, held: 0, pulled: 0 });

    // A sync of Alice's database with Bob's session refuses before sending anything.
    await logLegDay(alice);
    const crossed = await alice.run(
      Effect.exit(syncOnce(alice.api(() => issuer.sessionToken(BOB)))),
    );
    expect(crossed).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(crossed)).toContain("wrong_account");

    const bobsOtherPhone = openPhone(server, BOB, 3);
    await bobsOtherPhone.sync();
    expect(await counts(bobsOtherPhone)).toEqual({ activities: 0, sets: 0 });
    const alicesOtherPhone = openPhone(server, ALICE, 4);
    await alicesOtherPhone.sync();
    expect(await counts(alicesOtherPhone)).toEqual({ activities: 1, sets: 4 });
  });

  it("syncs all of the same Hevy file, through the Hevy import, into each of two accounts", async () => {
    const server = await startServer();
    const sample = Result.getOrThrow(
      decodeHevyFile(
        readFileSync(
          new URL("../../../packages/core/test-data/hevy-sample.csv", import.meta.url),
          "utf8",
        ),
        wallTimeAsUtc,
      ),
    );
    const importSample = (phone: Phone) =>
      phone.run(
        Effect.flatMap(Effect.service(TransferRepository), (transfers) =>
          transfers.applyImport(hevyImport(sample), []),
        ),
      );
    const alice = openPhone(server, ALICE, 1);
    const bob = openPhone(server, BOB, 2);
    expect(Option.isSome(await importSample(alice))).toBe(true);
    expect(Option.isSome(await importSample(bob))).toBe(true);
    await alice.sync();
    await bob.sync();

    const alicesOther = openPhone(server, ALICE, 3);
    const bobsOther = openPhone(server, BOB, 4);
    await alicesOther.sync();
    await bobsOther.sync();
    expect((await counts(alicesOther)).activities).toBeGreaterThan(0);
    expect(await counts(alicesOther)).toEqual(await counts(alice));
    expect(await alicesOther.rows()).toEqual(await alice.rows());
    expect(await bobsOther.rows()).toEqual(await bob.rows());
    expect(await activityIds(alicesOther)).toEqual(await activityIds(bobsOther));
  });

  it("syncs more rows than one push or one pull carries into each of two accounts", async () => {
    const server = await startServer();
    const WORKOUTS = 80;
    const importHevy = async (phone: Phone) => {
      const batch: ImportBatchId = await phone.run(
        Effect.flatMap(Effect.service(ImportRepository), (repository) => repository.create("hevy")),
      );
      await phone.run(
        Effect.flatMap(activities, (repository) =>
          Effect.forEach(
            Array.from({ length: WORKOUTS }, (_, n) => n),
            (n) => {
              const startedAt = new Date(Date.UTC(2026, 0, 1 + n, 18)).toISOString();
              return repository.create(
                legDay(
                  {
                    source: "hevy",
                    sourceId: SourceIdentity.make(startedAt),
                    fingerprint: Fingerprint.make(contentFingerprint(startedAt)),
                    importBatchId: batch,
                  },
                  `Hevy ${n}`,
                ),
              );
            },
          ),
        ),
      );
    };
    const alice = openPhone(server, ALICE, 1);
    const bob = openPhone(server, BOB, 2);
    await importHevy(alice);
    await importHevy(bob);
    // More rows than one push or one pull carries.
    expect((await alice.sync()).pushed).toBeGreaterThan(500);
    await bob.sync();

    const alicesOther = openPhone(server, ALICE, 3);
    const bobsOther = openPhone(server, BOB, 4);
    await alicesOther.sync();
    await bobsOther.sync();
    const imported = { activities: WORKOUTS, sets: WORKOUTS * 4 };
    expect(await counts(alicesOther)).toEqual(imported);
    expect(await counts(bobsOther)).toEqual(imported);
    expect((await alicesOther.rows())["activity"]).toEqual((await alice.rows())["activity"]);
    expect((await bobsOther.rows())["activity"]).toEqual((await bob.rows())["activity"]);
    expect(await activityIds(alicesOther)).toEqual(await activityIds(bobsOther));
  });

  it("holds a change timed too far ahead of the server, then sends it once the clock is right", async () => {
    const server = await startServer();
    const phone = openPhone(server, ALICE, 1);
    await phone.at(Date.now());
    await logLegDay(phone);
    // The server keeps real time.
    await phone.at(Date.now() + 60 * MINUTE);
    const late = await logLegDay(phone);
    await editFirstSet(phone, late, 8);
    expect(await phone.sync()).toEqual({ pushed: 7, held: 7, pulled: 0 });
    expect(
      await phone.run(Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queuedCount)),
    ).toBe(7);
    const other = openPhone(server, ALICE, 2);
    await other.sync();
    expect(await counts(other)).toEqual({ activities: 1, sets: 4 });

    // Someone sets the phone's clock right, and the next sync sends what it held.
    await phone.at(Date.now());
    expect(await phone.sync()).toMatchObject({ pushed: 7, held: 0 });
    expect(
      await phone.run(Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queuedCount)),
    ).toBe(0);
    await other.sync();
    expect(await counts(other)).toEqual({ activities: 2, sets: 8 });
    expect((await firstSet(other, late)).reps).toBe(8);
    expect(await other.rows()).toEqual(await phone.rows());
  });

  it("finishes a pull the app was closed in the middle of, after it opens again", async () => {
    const server = await startServer();
    const source = openPhone(server, ALICE, 1);
    await source.run(
      Effect.flatMap(activities, (repository) =>
        Effect.forEach(
          Array.from({ length: 80 }, (_, n) => n),
          (n) => repository.create(legDay(MADE_HERE, `Legs ${n}`)),
        ),
      ),
    );
    await source.sync();

    const path = join(mkdtempSync(join(tmpdir(), "svett-pull-")), "phone.db");
    const open = (killAfterInserts?: number) => {
      const { database, driver } = openNodeDatabase(path);
      let inserts = 0;
      let killed = false;
      const kill = <A>(call: () => Promise<A>) => {
        if (killed) return Promise.reject(new Error("The app is closed."));
        return call();
      };
      const dying: SqlDriver = {
        all: (sql, params) => kill(() => driver.all(sql, params)),
        exec: (sql) => kill(() => driver.exec(sql)),
        run: (sql, params) =>
          kill(() => {
            if (killAfterInserts !== undefined && /^\s*INSERT INTO activity/.test(sql)) {
              if (++inserts > killAfterInserts) {
                killed = true;
                return Promise.reject(new Error("The app is closed."));
              }
            }
            return driver.run(sql, params);
          }),
      };
      const runtime = ManagedRuntime.make(
        Layer.provideMerge(phoneDatabaseLayer(dying, Ids.layerSeeded(5)), manualClock(T0).layer),
      );
      const sync = () =>
        runtime.runPromiseExit(
          syncOnce(
            httpSyncApi({
              server,
              accountId: ALICE,
              token: () => issuer.sessionToken(ALICE),
              fetch,
            }),
          ),
        );
      return { database, runtime, sync };
    };

    // The second page of the pull is part way through its transaction when the app closes.
    const first = open(550);
    expect(Exit.isFailure(await first.sync())).toBe(true);
    first.database.close();

    const again = open();
    const state = await again.runtime.runPromise(
      Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.state),
    );
    expect(state.cursor).toBe(500);
    expect(Exit.isSuccess(await again.sync())).toBe(true);
    expect(await syncedRows(again.runtime)).toEqual(await source.rows());
    await again.runtime.dispose();
    again.database.close();
  });
  it("refuses a workout in progress and every row under it, whatever their order", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const id = await a.run(startPushDay());
    const rows = await workoutRows(a.runtime, id);
    const put = async (push: typeof rows) => {
      const response = await fetch(`${server}/v1/rows`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${await issuer.sessionToken(ALICE)}`,
          "content-type": "application/json",
          [SYNC_VERSION_HEADER]: String(SYNC_PROTOCOL_VERSION),
        },
        body: JSON.stringify({ rows: push }),
      });
      return { status: response.status, body: await response.json() };
    };
    const answers = await Promise.all(
      rows.map((row) => put([row, ...rows.filter((other) => other !== row)])),
    );
    expect(answers).toEqual(
      rows.map(({ table }) => ({
        status: 400,
        body: { error: "invalid_row", table, index: 0, message: DRAFT_MESSAGE },
      })),
    );
    const other = openPhone(server, ALICE, 2);
    expect(await other.sync()).toEqual({ pushed: 0, held: 0, pulled: 0 });
  });

  it("keeps each phone's workout in progress to itself and brings each one whole to the other once finished", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const fromA = await a.run(startPushDay("Push"));
    await b.at(T0 + MINUTE);
    const fromB = await b.run(startPushDay("Pull"));
    await syncAll([a, b]);
    expect(await activityIds(a)).toEqual([fromA]);
    expect(await activityIds(b)).toEqual([fromB]);
    const inProgress = (phone: Phone) =>
      phone.run(
        Effect.flatMap(activities, (repository) =>
          Effect.map(
            repository.inProgress,
            Option.map(({ activity }) => activity.id),
          ),
        ),
      );
    expect(await inProgress(a)).toEqual(Option.some(fromA));
    expect(await inProgress(b)).toEqual(Option.some(fromB));

    await a.at(T0 + 2 * MINUTE);
    await a.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(fromA)));
    await syncAll([a, b]);
    expect(await workoutRows(b.runtime, fromA)).toEqual(await workoutRows(a.runtime, fromA));
    expect(await workoutRows(a.runtime, fromB)).toEqual([]);
    expect(await inProgress(b)).toEqual(Option.some(fromB));

    await b.at(T0 + 3 * MINUTE);
    await b.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(fromB)));
    await syncAll([a, b]);
    expect(await workoutRows(a.runtime, fromB)).toEqual(await workoutRows(b.runtime, fromB));
    expect(await workoutRows(a.runtime, fromB)).toHaveLength(7);
    expect(await a.rows()).toEqual(await b.rows());
    expect(await counts(a)).toEqual({ activities: 2, sets: 6 });
  });

  it("keeps a set another phone added to a workout in progress here, on both phones once it is finished", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);

    await a.at(T0 + MINUTE);
    await reopen(a, id);
    const fromA = await addDoneSet(a, id, 7);
    await b.at(T0 + 2 * MINUTE);
    await reopen(b, id);
    const fromB = await addDoneSet(b, id, 8);
    await finish(b, id);
    const draft = await workoutRows(a.runtime, id);
    await syncAll([a, b]);
    expect(await workoutRows(a.runtime, id)).toEqual(draft);

    await a.at(T0 + 3 * MINUTE);
    await finish(a, id);
    await syncAll([a, b]);
    expect(await a.rows()).toEqual(await b.rows());
    const [onA, onB] = await Promise.all([setsOf(a, id), setsOf(b, id)]);
    expect(onA).toEqual(onB);
    expect(onA).toHaveLength(6);
    expect(onA).toEqual(
      expect.arrayContaining([
        { setId: fromA, reps: 7 },
        { setId: fromB, reps: 8 },
      ]),
    );
  });

  it.each([
    { later: "a", first: "a" },
    { later: "a", first: "b" },
    { later: "b", first: "a" },
    { later: "b", first: "b" },
  ] as const)(
    "takes the later edit to a set changed on both phones, from $later, when $first finishes first",
    async ({ later, first }) => {
      const server = await startServer();
      const a = openPhone(server, ALICE, 1);
      const b = openPhone(server, ALICE, 2);
      const phones = { a, b };
      const id = await sharedLegDay(a, [b]);
      const set = await firstSet(a, id);
      await Promise.all(
        [a, b].map(async (phone) => {
          await phone.at(T0 + MINUTE);
          await reopen(phone, id);
        }),
      );
      const earlier = later === "a" ? b : a;
      await earlier.at(T0 + 2 * MINUTE);
      await earlier.run(
        Effect.flatMap(activities, (repository) =>
          repository.updateWorkoutSet(set.id, { reps: 3 }),
        ),
      );
      await phones[later].at(T0 + 3 * MINUTE);
      await phones[later].run(
        Effect.flatMap(activities, (repository) =>
          repository.updateWorkoutSet(set.id, { reps: 9 }),
        ),
      );

      const second = first === "a" ? b : a;
      await phones[first].at(T0 + 4 * MINUTE);
      await finish(phones[first], id);
      await syncAll([a, b]);
      await second.at(T0 + 5 * MINUTE);
      await finish(second, id);
      await syncAll([a, b]);

      expect(await a.rows()).toEqual(await b.rows());
      expect((await firstSet(a, id)).reps).toBe(9);
      expect((await firstSet(b, id)).reps).toBe(9);
    },
  );

  it("deletes a workout another phone deleted while it was in progress here, and Undo brings it back as it was", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);
    const set = await firstSet(a, id);

    await a.at(T0 + MINUTE);
    await reopen(a, id);
    await a.run(
      Effect.flatMap(activities, (repository) => repository.updateWorkoutSet(set.id, { reps: 99 })),
    );
    await b.at(T0 + 2 * MINUTE);
    await b.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
    const draft = await workoutRows(a.runtime, id);
    await syncAll([a, b]);
    expect(await workoutRows(a.runtime, id)).toEqual(draft);

    // An edit made after the delete, under the deleted workout, is dropped with it.
    await a.at(T0 + 3 * MINUTE);
    await a.run(
      Effect.flatMap(activities, (repository) => repository.updateWorkoutSet(set.id, { reps: 77 })),
    );
    await finish(a, id);
    await syncAll([a, b]);
    expect(await a.rows()).toEqual(await b.rows());
    expect(await detail(a, id)).toEqual(Option.none());
    expect(await counts(a)).toEqual({ activities: 0, sets: 0 });

    await b.at(T0 + 4 * MINUTE);
    await b.run(Effect.flatMap(activities, (repository) => repository.restore(id)));
    await syncAll([a, b]);
    expect(await a.rows()).toEqual(await b.rows());
    expect(await setsOf(a, id)).toHaveLength(4);
    expect((await firstSet(a, id)).reps).toBe(5);
  });

  it.each(["a", "b"] as const)(
    "drops a set added and an edit made here after another phone deleted the workout in progress here, and Undo on %s brings back only what it had",
    async (undoOn) => {
      const server = await startServer();
      const a = openPhone(server, ALICE, 1);
      const b = openPhone(server, ALICE, 2);
      const id = await sharedLegDay(a, [b]);
      const before = await setsOf(a, id);
      const edited = before[1];
      if (edited === undefined) throw new Error("The workout has one set");

      await b.at(T0 + MINUTE);
      await reopen(b, id);
      await a.at(T0 + 2 * MINUTE);
      await a.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
      await syncAll([a, b]);

      await b.at(T0 + 3 * MINUTE);
      const added = await addDoneSet(b, id, 77);
      await b.run(
        Effect.flatMap(activities, (repository) =>
          repository.updateWorkoutSet(edited.setId, { reps: 66 }),
        ),
      );
      await finish(b, id);
      await syncAll([a, b]);
      expect(await a.rows()).toEqual(await b.rows());
      expect(await detail(a, id)).toEqual(Option.none());
      expect(await detail(b, id)).toEqual(Option.none());
      expect(await counts(b)).toEqual({ activities: 0, sets: 0 });

      await (undoOn === "a" ? a : b).at(T0 + 4 * MINUTE);
      await (undoOn === "a" ? a : b).run(
        Effect.flatMap(activities, (repository) => repository.restore(id)),
      );
      await syncAll([a, b]);
      expect(await a.rows()).toEqual(await b.rows());
      expect(await setsOf(a, id)).toEqual(before);
      expect(await setsOf(b, id)).toEqual(before);
      expect((await setsOf(b, id)).some(({ setId }) => setId === added)).toBe(false);
      expect(await counts(a)).toEqual({ activities: 1, sets: before.length });
    },
  );

  it("drops a set added and an edit made here under an exercise another phone deleted while the workout was in progress here", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);
    const workout = Option.getOrThrow(await detail(a, id));
    const [removed, rest] = workout.exercises;
    const edited = removed?.sets[1];
    if (removed === undefined || rest === undefined || edited === undefined) {
      throw new Error("The workout needs two exercises and two sets in the first");
    }

    await b.at(T0 + MINUTE);
    await reopen(b, id);
    await a.at(T0 + 2 * MINUTE);
    await reopen(a, id);
    await a.run(
      Effect.flatMap(activities, (repository) => repository.removeExercise(removed.exercise.id)),
    );
    await finish(a, id);
    await syncAll([a, b]);

    await b.at(T0 + 3 * MINUTE);
    const added = await addDoneSet(b, id, 77);
    await b.run(
      Effect.flatMap(activities, (repository) =>
        repository.updateWorkoutSet(edited.id, { reps: 66 }),
      ),
    );
    await finish(b, id);
    await syncAll([a, b]);

    expect(await a.rows()).toEqual(await b.rows());
    const underRemoved = (
      (await b.rows())["activity_set"] as ReadonlyArray<Record<string, unknown>>
    ).filter((set) => set["activity_exercise_id"] === removed.exercise.id);
    expect(underRemoved.map((set) => set["id"])).not.toContain(added);
    expect(underRemoved.every((set) => set["deleted_at"] !== null)).toBe(true);
    expect(underRemoved.map((set) => set["reps"])).toEqual(removed.sets.map(() => 5));
    const [onA, onB] = await Promise.all([detail(a, id), detail(b, id)]);
    expect(onA).toEqual(onB);
    expect(Option.getOrThrow(onB).exercises.map(({ exercise }) => exercise.id)).toEqual([
      rest.exercise.id,
    ]);
  });

  it("puts a workout discarded here back as the other phone has it, with that phone's changes", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);

    await a.at(T0 + MINUTE);
    await reopen(a, id);
    const set = await firstSet(a, id);
    await a.run(
      Effect.flatMap(activities, (repository) => repository.updateWorkoutSet(set.id, { reps: 99 })),
    );
    const fromA = await addDoneSet(a, id, 7);
    await b.at(T0 + 2 * MINUTE);
    await editFirstSet(b, id, 3);
    await b.run(Effect.flatMap(activities, (repository) => repository.update(id, { title: "B" })));
    await syncAll([a, b]);

    await a.at(T0 + 3 * MINUTE);
    await a.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
    await syncAll([a, b]);
    expect(await detail(a, id)).toEqual(await detail(b, id));
    const kept = Option.getOrThrow(await detail(a, id));
    expect(kept.activity).toMatchObject({ title: "B", status: "finished" });
    expect((await firstSet(a, id)).reps).toBe(3);
    expect((await setsOf(a, id)).some(({ setId }) => setId === fromA)).toBe(false);
    expect(await counts(a)).toEqual(await counts(b));
  });

  it.each(["a", "b"] as const)(
    "keeps a workout deleted that another phone finished before it pulled the delete, and Undo on %s brings back only what it had",
    async (undoOn) => {
      const server = await startServer();
      const a = openPhone(server, ALICE, 1);
      const b = openPhone(server, ALICE, 2);
      const id = await sharedLegDay(a, [b]);
      const before = await setsOf(a, id);
      const edited = before[1];
      if (edited === undefined) throw new Error("The workout has one set");

      await b.at(T0 + MINUTE);
      await reopen(b, id);
      await a.at(T0 + 2 * MINUTE);
      await remove(a, id);
      await a.sync();

      await b.at(T0 + 3 * MINUTE);
      const added = await addDoneSet(b, id, 77);
      await b.run(
        Effect.flatMap(activities, (repository) =>
          repository.updateWorkoutSet(edited.setId, { reps: 66 }),
        ),
      );
      await finish(b, id);
      await syncAll([b, a]);
      expect(await a.rows()).toEqual(await b.rows());
      expect(await detail(a, id)).toEqual(Option.none());
      expect(await detail(b, id)).toEqual(Option.none());
      expect(await counts(b)).toEqual({ activities: 0, sets: 0 });
      expect(await queuedCount(b)).toBe(0);

      const undoing = undoOn === "a" ? a : b;
      await undoing.at(T0 + 4 * MINUTE);
      await undo(undoing, id);
      await syncAll([a, b]);
      expect(await a.rows()).toEqual(await b.rows());
      expect(await setsOf(a, id)).toEqual(before);
      expect(await setsOf(b, id)).toEqual(before);
      expect((await setsOf(b, id)).some(({ setId }) => setId === added)).toBe(false);
      expect(await counts(a)).toEqual({ activities: 1, sets: before.length });
    },
  );

  it("keeps an exercise deleted that another phone changed before it pulled the delete", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);
    const workout = Option.getOrThrow(await detail(a, id));
    const [removed, rest] = workout.exercises;
    const edited = removed?.sets[1];
    if (removed === undefined || rest === undefined || edited === undefined) {
      throw new Error("The workout needs two exercises and two sets in the first");
    }

    await b.at(T0 + MINUTE);
    await reopen(b, id);
    await a.at(T0 + 2 * MINUTE);
    await reopen(a, id);
    await a.run(
      Effect.flatMap(activities, (repository) => repository.removeExercise(removed.exercise.id)),
    );
    await finish(a, id);
    await a.sync();

    await b.at(T0 + 3 * MINUTE);
    const added = await addDoneSet(b, id, 77);
    await b.run(
      Effect.flatMap(activities, (repository) =>
        repository.updateWorkoutSet(edited.id, { reps: 66 }),
      ),
    );
    await finish(b, id);
    await syncAll([b, a]);

    expect(await a.rows()).toEqual(await b.rows());
    expect(await queuedCount(b)).toBe(0);
    const rows = await b.rows();
    const exercise = (rows["activity_exercise"] as ReadonlyArray<Record<string, unknown>>).find(
      (row) => row["id"] === removed.exercise.id,
    );
    expect(exercise?.["deleted_at"]).not.toBeNull();
    const underRemoved = (rows["activity_set"] as ReadonlyArray<Record<string, unknown>>).filter(
      (set) => set["activity_exercise_id"] === removed.exercise.id,
    );
    expect(underRemoved.map((set) => set["id"])).toContain(added);
    expect(underRemoved.every((set) => set["deleted_at"] !== null)).toBe(true);
    expect(
      Object.fromEntries(
        underRemoved.filter((set) => set["id"] !== added).map((set) => [set["id"], set["reps"]]),
      ),
    ).toEqual(Object.fromEntries(removed.sets.map((set) => [set.id, 5])));
    const [onA, onB] = await Promise.all([detail(a, id), detail(b, id)]);
    expect(onA).toEqual(onB);
    expect(Option.getOrThrow(onB).exercises.map(({ exercise: { id: kept } }) => kept)).toEqual([
      rest.exercise.id,
    ]);
  });

  it("takes an Undo from a phone that pulled the delete, and drops a stale edit from one that had not", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const c = openPhone(server, ALICE, 3);
    const id = await sharedLegDay(a, [b, c]);
    const before = await setsOf(a, id);

    await a.at(T0 + MINUTE);
    await remove(a, id);
    await a.sync();
    await b.at(T0 + 2 * MINUTE);
    await b.sync();
    expect(await detail(b, id)).toEqual(Option.none());
    await undo(b, id);

    await c.at(T0 + 3 * MINUTE);
    await c.run(Effect.flatMap(activities, (repository) => repository.update(id, { title: "C" })));
    await editFirstSet(c, id, 3);
    await syncAll([c, b, a]);

    const all = await Promise.all([a, b, c].map((phone) => phone.rows()));
    expect(all[1]).toEqual(all[0]);
    expect(all[2]).toEqual(all[0]);
    const seen = await Promise.all(
      [a, b, c].map(async (phone) => ({
        title: Option.getOrThrow(await detail(phone, id)).activity.title,
        sets: await setsOf(phone, id),
        queued: await queuedCount(phone),
      })),
    );
    expect(seen).toEqual([a, b, c].map(() => ({ title: "Legs", sets: before, queued: 0 })));
  });

  it("drops a change that would bring back a deleted workout without an Undo, and the queue drains", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);

    await a.at(T0 + MINUTE);
    await remove(a, id);
    await a.sync();
    await b.at(T0 + 2 * MINUTE);
    await b.run(
      Effect.flatMap(activities, (repository) => repository.update(id, { title: "Stale" })),
    );
    await editFirstSet(b, id, 3);
    const first = await b.sync();
    expect(first.pushed).toBe(2);
    expect(await queuedCount(b)).toBe(0);
    expect(await detail(b, id)).toEqual(Option.none());

    await a.sync();
    expect(await a.rows()).toEqual(await b.rows());
    expect(await detail(a, id)).toEqual(Option.none());
    expect((await b.sync()).pushed).toBe(0);
    expect(await queuedCount(b)).toBe(0);
  });

  it.each(["confirmed", "answer lost", "never arrived"] as const)(
    "keeps a second Undo made while the push of the second delete is on the way, %s",
    async (outcome) => {
      const server = await startServer();
      const a = openPhone(server, ALICE, 1);
      const b = openPhone(server, ALICE, 2);
      const id = await sharedLegDay(a, [b]);
      const before = await setsOf(a, id);

      await a.at(T0 + MINUTE);
      await remove(a, id);
      await a.sync();
      await a.at(T0 + 2 * MINUTE);
      await undo(a, id);
      await a.at(T0 + 3 * MINUTE);
      await remove(a, id);
      await a.run(
        Effect.exit(
          syncOnce(
            pushWith(
              a,
              holdsDeleted(id),
              async () => {
                await a.at(T0 + 4 * MINUTE);
                await undo(a, id);
              },
              outcome,
            ),
          ),
        ),
      );
      await syncAll([a, b]);

      await expectBothKept([a, b], id, before);
    },
  );

  it("keeps a workout deleted, undone, deleted and undone again before the phone syncs", async () => {
    const server = await startServer();
    const a = openPhone(server, ALICE, 1);
    const b = openPhone(server, ALICE, 2);
    const id = await sharedLegDay(a, [b]);
    const before = await setsOf(a, id);

    await a.at(T0 + MINUTE);
    await remove(a, id);
    await a.sync();
    await inTurn([2, 3, 4], async (minutes) => {
      await a.at(T0 + minutes * MINUTE);
      await (minutes % 2 === 0 ? undo(a, id) : remove(a, id));
    });
    await syncAll([a, b]);

    await expectBothKept([a, b], id, before);
  });

  it.each(["a deletes and b undoes", "b deletes and a undoes"] as const)(
    "keeps a workout through a delete, Undo, delete and Undo across two phones, when %s",
    async (roles) => {
      const server = await startServer();
      const a = openPhone(server, ALICE, 1);
      const b = openPhone(server, ALICE, 2);
      const id = await sharedLegDay(a, [b]);
      const before = await setsOf(a, id);
      const [deleting, undoing] = roles === "a deletes and b undoes" ? [a, b] : [b, a];

      await inTurn([1, 3], async (minutes) => {
        await deleting.sync();
        await deleting.at(T0 + minutes * MINUTE);
        await remove(deleting, id);
        await deleting.sync();
        await undoing.sync();
        expect(await detail(undoing, id)).toEqual(Option.none());
        await undoing.at(T0 + (minutes + 1) * MINUTE);
        await undo(undoing, id);
        await undoing.sync();
      });
      await syncAll([a, b]);

      await expectBothKept([a, b], id, before);
    },
  );

  it.each([
    ["no sync version", undefined],
    ["an older sync version", String(SYNC_PROTOCOL_VERSION - 1)],
  ] as const)(
    "refuses a push and a pull with %s, before storing or confirming anything",
    async (_, version) => {
      const server = await startServer();
      const a = openPhone(server, ALICE, 1);
      const id = await logLegDay(a);
      const old = httpSyncApi({
        server,
        accountId: ALICE,
        token: () => issuer.sessionToken(ALICE),
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          if (version === undefined) headers.delete(SYNC_VERSION_HEADER);
          else headers.set(SYNC_VERSION_HEADER, version);
          return fetch(input, { ...init, headers });
        },
      });
      const refused = new SyncFailed({
        problem: "update_required",
        message: "Update svett to sync.",
      });
      expect(await a.run(Effect.exit(syncOnce(old)))).toEqual(Exit.fail(refused));
      expect(await a.run(Effect.exit(old.pull(0)))).toEqual(Exit.fail(refused));
      expect(await queuedCount(a)).toBe(7);

      const b = openPhone(server, ALICE, 2);
      await b.sync();
      expect(await counts(b)).toEqual({ activities: 0, sets: 0 });
      await a.sync();
      await b.sync();
      expect(await setsOf(b, id)).toEqual(await setsOf(a, id));
    },
  );
});
