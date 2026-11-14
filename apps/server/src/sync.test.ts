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
} from "@svett/core";
import {
  legDay,
  manualClock,
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

/** The change ID of the copy of `set` that `phone` would send. */
const queuedChangeId = async (phone: Phone, setId: string) => {
  const queued = await phone.run(
    Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queued(undefined)),
  );
  const copy = queued.find(({ id }) => id === setId);
  if (copy === undefined) throw new Error("The set is not queued");
  return changeIdOf("activity_set", copy.row);
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
});
