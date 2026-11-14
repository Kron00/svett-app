import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { AccountId } from "./database.ts";
import { copyDatabase, ownRowCount } from "./database-move.ts";
import { DurationSeconds } from "./duration.ts";
import {
  anonymousDataLocked,
  decodeMoveJournal,
  encodeMoveJournal,
  finishLeave,
  type LeaveSteps,
  leaveAccount,
  leavingAccount,
} from "./move-journal.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { EpochMillis } from "./schema.ts";
import { shouldOfferMove } from "./sign-in.ts";
import { Sql } from "./sql.ts";
import { openTestDatabase, T0 } from "./test-database.ts";

const ALICE = AccountId.make("user_alice");

type Database = ReturnType<typeof openTestDatabase>;

const titles = (database: Database) =>
  database.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      Effect.map(activities.list({ limit: 50 }), (rows) => rows.map((row) => row.title).sort()),
    ),
  );

const ownRows = (database: Database) =>
  database.runtime.runPromise(Effect.flatMap(Effect.service(Sql), ownRowCount));

const log = (database: Database, title: string) =>
  database.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.create({
        kind: "run",
        startedAt: EpochMillis.make(T0 - 3_600_000),
        durationS: DurationSeconds.make(1_800),
        title,
        notes: "",
        energyKcal: null,
        audience: "only_you",
        hiddenFields: [],
        origin: { source: "svett" },
        exercises: [],
        track: null,
      }),
    ),
  );

type Crash = "copy" | "delete";
class Crashed extends Error {}

/**
 * A phone signed in to Alice's account, whose database holds two workouts, and whose own
 * database holds one logged before any account. The journal says the data moved into Alice.
 */
const phone = async () => {
  const anonymous = openTestDatabase(1);
  await log(anonymous, "Before the account");
  let alice: Database | undefined = openTestDatabase(2);
  await log(alice, "Tempo");
  await log(alice, "Long run");
  let stored: string | null = encodeMoveJournal({ state: "declined" });
  const crashes = new Set<Crash>();
  const crashAt = (at: Crash) =>
    crashes.delete(at) ? Effect.fail(new Crashed(at)) : Effect.succeed(undefined);

  const steps: LeaveSteps<unknown> = {
    read: Effect.sync(() => decodeMoveJournal(stored)),
    record: (journal) =>
      Effect.sync(() => {
        stored = encodeMoveJournal(journal);
      }),
    forget: Effect.sync(() => {
      stored = null;
    }),
    copyToAnonymous: () =>
      Effect.gen(function* () {
        yield* crashAt("copy");
        if (alice === undefined) return yield* Effect.fail(new Error("Alice's file is gone"));
        const from = yield* Effect.promise(() => alice!.runtime.runPromise(Effect.service(Sql)));
        const to = yield* Effect.promise(() => anonymous.runtime.runPromise(Effect.service(Sql)));
        return yield* copyDatabase(from, to);
      }),
    deleteAccountData: () =>
      Effect.andThen(
        crashAt("delete"),
        Effect.sync(() => {
          alice = undefined;
        }),
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
              : ({ failed: String(error) } as const),
          ),
        ),
      ),
    );

  return {
    crashes,
    anonymous,
    alice: () => alice,
    journal: () => decodeMoveJournal(stored),
    offered: async () =>
      shouldOfferMove({
        alreadyAsked: decodeMoveJournal(stored) !== undefined,
        anonymousRows: await ownRows(anonymous),
      }),
    leave: (keep: boolean) => run(leaveAccount(steps, ALICE, keep)),
    launch: () => run(finishLeave(steps)),
  };
};

describe("leaving a deleted account", () => {
  it("keeps a copy as the phone's own data, beside what it held before", async () => {
    const device = await phone();

    expect(await device.leave(true)).toEqual({ done: undefined });
    expect(await titles(device.anonymous)).toEqual(["Before the account", "Long run", "Tempo"]);
    expect(device.alice()).toBeUndefined();
    expect(anonymousDataLocked(device.journal())).toBe(false);
    // The phone's data has no owner again, so the next sign-in offers to move it.
    expect(await device.offered()).toBe(true);
  });

  it("erases the account's data and leaves the phone's own data as it was", async () => {
    const device = await phone();

    expect(await device.leave(false)).toEqual({ done: undefined });
    expect(await titles(device.anonymous)).toEqual(["Before the account"]);
    expect(device.alice()).toBeUndefined();
    expect(device.journal()).toBeUndefined();
  });

  it("finishes keeping a copy at the next launch after a crash before the copy", async () => {
    const device = await phone();
    device.crashes.add("copy");

    expect(await device.leave(true)).toEqual({ crashed: "copy" });
    expect(device.journal()).toEqual({ state: "keeping", account: ALICE });
    expect(leavingAccount(device.journal())).toBe(ALICE);
    // Nobody sees the phone's data half copied.
    expect(anonymousDataLocked(device.journal())).toBe(true);

    expect(await device.launch()).toEqual({ done: undefined });
    expect(await titles(device.anonymous)).toEqual(["Before the account", "Long run", "Tempo"]);
    expect(device.alice()).toBeUndefined();
  });

  it("finishes erasing at the next launch after a crash before the delete", async () => {
    const device = await phone();
    device.crashes.add("delete");

    expect(await device.leave(true)).toEqual({ crashed: "delete" });
    expect(device.journal()).toEqual({ state: "erasing", account: ALICE });
    expect(anonymousDataLocked(device.journal())).toBe(false);
    expect(await titles(device.anonymous)).toEqual(["Before the account", "Long run", "Tempo"]);

    expect(await device.launch()).toEqual({ done: undefined });
    expect(device.alice()).toBeUndefined();
    expect(device.journal()).toBeUndefined();
  });

  it("changes nothing at launch when no account is leaving", async () => {
    const device = await phone();

    expect(await device.launch()).toEqual({ done: { state: "declined" } });
    expect(device.alice()).toBeDefined();
    expect(leavingAccount(device.journal())).toBeUndefined();
  });
});
