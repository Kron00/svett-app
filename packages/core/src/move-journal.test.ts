import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { AccountId } from "./database.ts";
import { copyDatabase, ownRowCount } from "./database-move.ts";
import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import {
  anonymousDataLocked,
  decodeMoveJournal,
  encodeMoveJournal,
  finishMove,
  type MoveJournal,
  type MoveSteps,
  startMove,
} from "./move-journal.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { EpochMillis } from "./schema.ts";
import { shouldOfferMove } from "./sign-in.ts";
import { Sql, SqlError, type SqlService } from "./sql.ts";
import { openTestDatabase, T0 } from "./test-database.ts";

const ALICE = AccountId.make("user_alice");
const BOB = AccountId.make("user_bob");

type Database = ReturnType<typeof openTestDatabase>;

const sqlOf = (database: Database) => database.runtime.runPromise(Effect.service(Sql));

const workouts = (database: Database) =>
  database.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      Effect.map(activities.counts, (counts) => counts.activities),
    ),
  );

const ownRows = (database: Database) =>
  database.runtime.runPromise(Effect.flatMap(Effect.service(Sql), ownRowCount));

const withHistory = async () => {
  const database = openTestDatabase(1);
  await database.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      Effect.forEach(["Legs", "Pull"], (title) =>
        activities.create({
          kind: "strength",
          startedAt: EpochMillis.make(T0 - 3_600_000),
          durationS: DurationSeconds.make(3_300),
          title,
          notes: "",
          energyKcal: null,
          audience: "only_you",
          hiddenFields: [],
          origin: { source: "svett" },
          exercises: [
            {
              exerciseId: libraryExerciseId("Barbell_Squat"),
              supersetGroup: null,
              notes: "",
              sets: [
                {
                  setType: "normal",
                  weightKg: 100,
                  reps: 5,
                  durationS: null,
                  distanceM: null,
                  rpe: null,
                },
              ],
            },
          ],
          track: null,
        }),
      ),
    ),
  );
  return database;
};

/** Where a step of the move dies, the way an app killed mid-move would. */
type Crash = "midCopy" | "recordCleaning" | "deleteAnonymous";

class Crashed extends Error {}

/**
 * A phone with imported history and no one signed in. Its journal is kept as the string the
 * app stores, and each database is a file that a crash leaves as it was.
 */
const phone = async () => {
  let anonymous: Database | undefined = await withHistory();
  const accounts = new Map<AccountId, Database>();
  let stored: string | null = null;
  const crashes = new Set<Crash>();

  const account = (id: AccountId) => {
    const existing = accounts.get(id);
    if (existing !== undefined) return existing;
    const opened = openTestDatabase(2);
    accounts.set(id, opened);
    return opened;
  };
  const crashAt = (at: Crash) =>
    crashes.delete(at) ? Effect.fail(new Crashed(at)) : Effect.succeed(undefined);

  /** Fails the second write of the copy, after the first one went into the transaction. */
  const dyingMidCopy = (sql: SqlService): SqlService => {
    let writes = 0;
    return {
      ...sql,
      run: (statement, params) =>
        ++writes === 2 && crashes.delete("midCopy")
          ? Effect.fail(new SqlError({ sql: statement, cause: new Crashed("midCopy") }))
          : sql.run(statement, params),
    };
  };

  const steps: MoveSteps<unknown> = {
    read: Effect.sync(() => decodeMoveJournal(stored)),
    record: (journal) =>
      Effect.andThen(
        journal.state === "cleaning" ? crashAt("recordCleaning") : Effect.void,
        Effect.sync(() => {
          stored = encodeMoveJournal(journal);
        }),
      ),
    copyInto: (id) =>
      Effect.gen(function* () {
        if (anonymous === undefined) return yield* Effect.fail(new Error("nothing to copy"));
        const from = yield* Effect.promise(() => sqlOf(anonymous!));
        const to = yield* Effect.promise(() => sqlOf(account(id)));
        return yield* copyDatabase(from, dyingMidCopy(to));
      }),
    deleteAnonymous: Effect.suspend(() =>
      Effect.andThen(
        crashAt("deleteAnonymous"),
        Effect.sync(() => {
          anonymous = undefined;
        }),
      ),
    ),
  };

  const run = <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.map((value) => ({ done: value }) as const),
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof Crashed
              ? ({ crashed: error.message } as const)
              : error instanceof SqlError && error.cause instanceof Crashed
                ? ({ crashed: error.cause.message } as const)
                : ({ refused: (error as { _tag?: string })._tag } as const),
          ),
        ),
      ),
    );

  return {
    crashes,
    account,
    anonymous: () => anonymous,
    journal: () => decodeMoveJournal(stored),
    /** What the Account screen asks when `id` signs in. */
    offered: async () =>
      shouldOfferMove({
        alreadyAsked: decodeMoveJournal(stored) !== undefined,
        anonymousRows: anonymous === undefined ? 0 : await ownRows(anonymous),
      }),
    decline: () => {
      stored = encodeMoveJournal({ state: "declined" });
    },
    start: (id: AccountId) => run(startMove(steps, id)),
    launch: () => run(finishMove(steps)),
  };
};

describe("moving the phone's data into an account", () => {
  it("copies it into the account and deletes the phone's own copy", async () => {
    const device = await phone();
    const before = await ownRows(device.anonymous()!);

    expect(await device.start(ALICE)).toEqual({ done: { state: "moved", account: ALICE } });
    expect(await workouts(device.account(ALICE))).toBe(2);
    expect(await ownRows(device.account(ALICE))).toBe(before);
    expect(device.anonymous()).toBeUndefined();
    expect(anonymousDataLocked(device.journal())).toBe(false);
  });

  it("names the account before copying anything", async () => {
    const device = await phone();
    device.crashes.add("midCopy");

    expect(await device.start(ALICE)).toEqual({ crashed: "midCopy" });
    expect(device.journal()).toEqual({ state: "copying", account: ALICE });
    expect(await ownRows(device.account(ALICE))).toBe(0);
    expect(anonymousDataLocked(device.journal())).toBe(true);

    expect(await device.launch()).toEqual({ done: { state: "moved", account: ALICE } });
    expect(await workouts(device.account(ALICE))).toBe(2);
  });

  it("finishes into the first account when a crash hits after the copy and another account signs in", async () => {
    const device = await phone();
    device.crashes.add("recordCleaning");

    expect(await device.start(ALICE)).toEqual({ crashed: "recordCleaning" });
    expect(await workouts(device.account(ALICE))).toBe(2);
    expect(device.journal()).toEqual({ state: "copying", account: ALICE });
    // Signed out, the history is still in the anonymous file, and nobody may open it.
    expect(anonymousDataLocked(device.journal())).toBe(true);

    expect(await device.offered()).toBe(false);
    expect(await device.start(BOB)).toEqual({ refused: "MoveRefused" });

    expect(await device.launch()).toEqual({ done: { state: "moved", account: ALICE } });
    expect(await workouts(device.account(ALICE))).toBe(2);
    expect(await ownRows(device.account(BOB))).toBe(0);
    expect(device.anonymous()).toBeUndefined();
  });

  it("finishes the cleanup for the first account when a crash hits before it and another account signs in", async () => {
    const device = await phone();
    const before = await ownRows(device.anonymous()!);
    device.crashes.add("deleteAnonymous");

    expect(await device.start(ALICE)).toEqual({ crashed: "deleteAnonymous" });
    expect(device.journal()).toEqual({ state: "cleaning", account: ALICE });
    expect(device.anonymous()).toBeDefined();
    expect(anonymousDataLocked(device.journal())).toBe(true);

    expect(await device.offered()).toBe(false);
    expect(await device.start(BOB)).toEqual({ refused: "MoveRefused" });

    expect(await device.launch()).toEqual({ done: { state: "moved", account: ALICE } });
    expect(await ownRows(device.account(ALICE))).toBe(before);
    expect(await ownRows(device.account(BOB))).toBe(0);
    expect(device.anonymous()).toBeUndefined();
    expect(anonymousDataLocked(device.journal())).toBe(false);
  });

  it("changes nothing when a launch finds the move finished", async () => {
    const device = await phone();
    await device.start(ALICE);

    expect(await device.launch()).toEqual({ done: { state: "moved", account: ALICE } });
    expect(await workouts(device.account(ALICE))).toBe(2);
    expect(await device.start(BOB)).toEqual({ refused: "MoveRefused" });
    expect(await ownRows(device.account(BOB))).toBe(0);
  });

  it("offers the move until it is declined, and then keeps the phone's data apart", async () => {
    const device = await phone();
    expect(await device.offered()).toBe(true);
    expect(await device.launch()).toEqual({ done: undefined });

    device.decline();
    expect(await device.offered()).toBe(false);
    expect(await device.start(ALICE)).toEqual({ refused: "MoveRefused" });
    expect(await workouts(device.anonymous()!)).toBe(2);
    expect(anonymousDataLocked(device.journal())).toBe(false);
  });
});

describe("the move journal", () => {
  it("reads back what it stored", () => {
    const journals: ReadonlyArray<MoveJournal> = [
      { state: "declined" },
      { state: "copying", account: ALICE },
      { state: "cleaning", account: ALICE },
      { state: "moved", account: ALICE },
    ];
    expect(journals.map((journal) => decodeMoveJournal(encodeMoveJournal(journal)))).toEqual(
      journals,
    );
  });

  it("has no answer before the first sign-in, and counts an unreadable one as answered", () => {
    expect(decodeMoveJournal(null)).toBeUndefined();
    expect(decodeMoveJournal("moved")).toEqual({ state: "declined" });
    expect(decodeMoveJournal('{"state":"copying","account":"../x"}')).toEqual({
      state: "declined",
    });
  });
});
