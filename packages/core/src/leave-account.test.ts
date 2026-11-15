import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { AccountId } from "./database.ts";
import { copyDatabase, ownRowCount } from "./database-move.ts";
import { DurationSeconds } from "./duration.ts";
import {
  anonymousDataLocked,
  decodeMoveJournal,
  DELETION_NEEDS_SIGN_IN,
  type DeletionAsked,
  type DeletionSent,
  type DeletionSteps,
  encodeMoveJournal,
  finishDeletion,
  finishLeave,
  type LeaveSteps,
  leaveAccount,
  leavingAccount,
  type MoveJournal,
  startDeletion,
} from "./move-journal.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { EpochMillis } from "./schema.ts";
import { shouldOfferMove } from "./sign-in.ts";
import { Sql } from "./sql.ts";
import { openTestDatabase, T0 } from "./test-database.ts";

const ALICE = AccountId.make("user_alice");
const BOB = AccountId.make("user_bob");

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

/** A phone whose journal starts as `start`, and a server that answers as told. */
const deletingPhone = (start: MoveJournal | undefined) => {
  let stored = start === undefined ? null : encodeMoveJournal(start);
  const server = {
    sent: [] as Array<{ account: AccountId; receipt: string; journal: MoveJournal | undefined }>,
    asked: [] as Array<string>,
    signedIn: ALICE as AccountId | undefined,
    answer: { kind: "deleted" } as DeletionSent,
    says: "unknown" as DeletionAsked,
  };
  const steps: DeletionSteps<never> = {
    read: Effect.sync(() => decodeMoveJournal(stored)),
    record: (journal) =>
      Effect.sync(() => {
        stored = encodeMoveJournal(journal);
      }),
    forget: Effect.sync(() => {
      stored = null;
    }),
    signedIn: Effect.sync(() => server.signedIn),
    send: (account, receipt) =>
      Effect.sync(() => {
        server.sent.push({ account, receipt, journal: decodeMoveJournal(stored) });
        return server.answer;
      }),
    ask: (receipt) =>
      Effect.sync(() => {
        server.asked.push(receipt);
        return server.says;
      }),
  };
  return {
    server,
    journal: () => decodeMoveJournal(stored),
    start: (keep: boolean, receipt = "r1", account = ALICE) =>
      Effect.runPromise(startDeletion(steps, account, keep, receipt)),
    launch: () => Effect.runPromise(finishDeletion(steps)),
  };
};

/** A deletion of Alice's account, saved over `before`. */
const deleting = (before: Exclude<MoveJournal, { state: "deleting" }> | null): MoveJournal => ({
  state: "deleting",
  account: ALICE,
  keep: true,
  receipt: "r1",
  before,
});

describe("deleting the account", () => {
  it("saves the deletion and the choice before anything is sent", async () => {
    const device = deletingPhone({ state: "moved", account: ALICE });

    expect(await device.start(true)).toEqual({ kind: "deleted", account: ALICE, keep: true });
    expect(device.server.sent).toEqual([
      {
        account: ALICE,
        receipt: "r1",
        journal: {
          state: "deleting",
          account: ALICE,
          keep: true,
          receipt: "r1",
          before: { state: "moved", account: ALICE },
        },
      },
    ]);
    // The receipt is asked about only when the answer does not say.
    expect(device.server.asked).toEqual([]);
  });

  it("finishes at launch after a crash before the send, as the person chose", async () => {
    const device = deletingPhone({ state: "declined" });
    device.server.answer = { kind: "unknown", problem: "offline" };
    device.server.says = "unknown";
    expect(await device.start(false)).toEqual({ kind: "pending", problem: "offline" });
    expect(device.journal()).toMatchObject({ state: "deleting", keep: false });

    device.server.answer = { kind: "deleted" };
    expect(await device.launch()).toEqual({ kind: "deleted", account: ALICE, keep: false });
    expect(device.server.sent.map(({ receipt }) => receipt)).toEqual(["r1", "r1"]);
  });

  it("asks with the receipt when the session ended with the deletion", async () => {
    const device = deletingPhone({ state: "declined" });
    device.server.answer = { kind: "unknown", problem: "signed out" };
    device.server.says = "deleted";

    expect(await device.start(true)).toEqual({ kind: "deleted", account: ALICE, keep: true });
    expect(device.server.asked).toEqual(["r1"]);
  });

  it("keeps the deletion saved while sessions are left, so it is sent again", async () => {
    const device = deletingPhone({ state: "declined" });
    device.server.answer = { kind: "unfinished", problem: "sessions" };
    device.server.says = "deleted";

    expect(await device.start(true)).toEqual({ kind: "pending", problem: "sessions" });
    expect(device.journal()).toMatchObject({ state: "deleting" });
  });

  it("puts the journal back only when the server refused and says it deleted nothing", async () => {
    const device = deletingPhone({ state: "moved", account: ALICE });
    device.server.answer = { kind: "refused", problem: "no" };
    device.server.says = "unknown";
    expect(await device.start(true)).toEqual({ kind: "pending", problem: "no" });
    expect(device.journal()).toMatchObject({ state: "deleting" });

    device.server.says = "not_deleted";
    expect(await device.launch()).toEqual({ kind: "refused", problem: "no" });
    expect(device.journal()).toEqual({ state: "moved", account: ALICE });

    const fresh = deletingPhone(undefined);
    fresh.server.answer = { kind: "refused", problem: "no" };
    fresh.server.says = "not_deleted";
    expect(await fresh.start(false)).toEqual({ kind: "refused", problem: "no" });
    expect(fresh.journal()).toBeUndefined();
  });

  it("sends a saved deletion only with a session of its account", async () => {
    const device = deletingPhone({ state: "declined" });
    device.server.answer = { kind: "unknown", problem: "offline" };
    await device.start(true);
    expect(device.server.sent).toHaveLength(1);

    const launchAs = async (someone: AccountId | undefined) => {
      device.server.signedIn = someone;
      device.server.says = "not_deleted";
      expect(await device.launch()).toEqual({ kind: "pending", problem: DELETION_NEEDS_SIGN_IN });
      expect(device.journal()).toMatchObject({ state: "deleting", account: ALICE, keep: true });
    };
    await launchAs(BOB);
    await launchAs(undefined);
    expect(device.server.sent).toHaveLength(1);
    expect(device.server.asked).toEqual(["r1", "r1", "r1"]);

    // Another phone, or a request the lost answer hid, deleted it, so it ends as Alice chose.
    device.server.signedIn = BOB;
    device.server.says = "deleted";
    expect(await device.launch()).toEqual({ kind: "deleted", account: ALICE, keep: true });
    expect(device.server.sent).toHaveLength(1);
  });

  it("is refused while another account's deletion is saved", async () => {
    const device = deletingPhone(deleting({ state: "declined" }));
    device.server.signedIn = BOB;
    const refused = await device.start(false, "r2", BOB);
    expect(refused).toEqual({
      kind: "refused",
      problem: `svett is still deleting another account on this phone. ${DELETION_NEEDS_SIGN_IN}`,
    });
    expect(device.journal()).toMatchObject({ account: ALICE, receipt: "r1" });
    expect(device.server.sent).toEqual([]);
    expect(device.server.asked).toEqual([]);
  });

  it("keeps the receipt and takes the new choice when the deletion is asked for again", async () => {
    const device = deletingPhone({ state: "declined" });
    device.server.answer = { kind: "unknown", problem: "offline" };
    await device.start(true, "r1");
    await device.start(false, "r2");

    expect(device.journal()).toMatchObject({ keep: false, receipt: "r1" });
    expect(device.server.sent.map(({ receipt }) => receipt)).toEqual(["r1", "r1"]);
  });

  it("is refused while a move is unfinished, and changes nothing at launch without a deletion", async () => {
    const moving = deletingPhone({ state: "copying", account: ALICE });
    expect((await moving.start(true)).kind).toBe("refused");
    expect(moving.server.sent).toEqual([]);
    expect(moving.journal()).toEqual({ state: "copying", account: ALICE });

    const idle = deletingPhone({ state: "declined" });
    expect(await idle.launch()).toEqual({ kind: "none" });
    expect(idle.server.sent).toEqual([]);
  });

  it("keeps the phone's own data locked as the journal it replaced did", () => {
    expect(anonymousDataLocked(deleting({ state: "declined" }))).toBe(false);
    expect(anonymousDataLocked(deleting(null))).toBe(false);
    expect(leavingAccount(deleting(null))).toBeUndefined();
  });
});
