import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { databaseLayer } from "../database.ts";
import { Ids } from "../ids.ts";
import { manualClock } from "../manual-clock.ts";
import { openNodeDatabase } from "../node-sqlite.ts";
import {
  type ActivityId,
  type ActivitySet,
  type ConversationId,
  ConversationId as Conversation,
  EpochMillis,
} from "../schema.ts";
import { decodeSvettFile, type SvettFile } from "../svett-file.ts";
import {
  changeIdOf,
  checkSyncRow,
  type CheckedRow,
  isTooFarAhead,
  type SyncedTable,
  type SyncPushResult,
} from "../sync.ts";
import { legDay, startPushDay, workoutRows } from "../sync-testing.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { ActivityRepository } from "./activities.ts";
import { MADE_HERE } from "./origin.ts";
import { CoachMessageRepository } from "./records.ts";
import { type SyncApi, SyncRepository, syncOnce } from "./sync.ts";
import { TransferRepository } from "./transfer.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;

const phone = (seed = 1) => {
  const database = openTestDatabase(seed);
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      SyncRepository | ActivityRepository | CoachMessageRepository | TransferRepository
    >,
  ) => database.runtime.runPromise(effect);
  return { ...database, run, at: (millis: number) => run(database.clock.set(millis)) };
};
type Phone = ReturnType<typeof phone>;

/**
 * A stand-in for the server that keeps every push it gets and has nothing to pull. Like the
 * server, it holds rows timed too far past its own clock, which reads `serverMillis`.
 */
const standIn = (serverMillis: () => number) => {
  const pushes: Array<ReadonlyArray<{ readonly table: SyncedTable; readonly row: unknown }>> = [];
  const api: SyncApi<never> = {
    push: (rows) =>
      Effect.sync((): SyncPushResult => {
        pushes.push(rows);
        const now = serverMillis();
        return {
          stored: rows.length,
          ahead: rows
            .filter(({ row }) => isTooFarAhead((row as { updatedAt: number }).updatedAt, now))
            .map(({ table, row }) => ({ table, id: (row as { id: string }).id })),
          serverMillis: now,
        };
      }),
    pull: (after) => Effect.succeed({ rows: [], next: after, more: false }),
  };
  return { api, pushes, sent: () => pushes.flat() };
};

const chatId: ConversationId = Conversation.make("0190a0b2-0000-7000-8000-0000000000c0");

const sayToCoach = (on: Phone, content: string) =>
  on.run(
    Effect.flatMap(Effect.service(CoachMessageRepository), (repository) =>
      repository.append({ conversationId: chatId, role: "user", content }),
    ),
  );

const chat = (on: Phone) =>
  on.run(
    Effect.flatMap(Effect.service(CoachMessageRepository), (repository) =>
      repository.conversation(chatId),
    ),
  );

const transfer = <A, E>(
  on: Phone,
  body: (repository: typeof TransferRepository.Service) => Effect.Effect<A, E>,
) => on.run(Effect.flatMap(Effect.service(TransferRepository), body));

const exportFile = async (on: Phone): Promise<SvettFile> => {
  const { text } = await transfer(on, (repository) => repository.exportFile);
  return Result.getOrThrow(decodeSvettFile(text));
};

/** Imports `file`, taking every record that changed, and gives the import's ID. */
const importAll = async (on: Phone, file: SvettFile) => {
  const plan = await transfer(on, (repository) => repository.previewImport(file));
  const taken = await transfer(on, (repository) =>
    repository.applyImport(
      file,
      plan.changed.map(({ key }) => key),
    ),
  );
  return Option.getOrThrow(taken).importBatchId;
};

const sync = Effect.service(SyncRepository);
const activities = Effect.service(ActivityRepository);

const logLegDay = (on: ReturnType<typeof phone>) =>
  on.run(Effect.flatMap(activities, (repository) => repository.create(legDay(MADE_HERE))));

const firstSet = (on: ReturnType<typeof phone>, id: ActivityId) =>
  on.run(
    Effect.flatMap(activities, (repository) =>
      Effect.map(repository.get(id), (detail) => {
        const set = Option.getOrThrow(detail).exercises[0]?.sets[0];
        if (set === undefined) throw new Error("The workout has no sets");
        return set;
      }),
    ),
  );

/** A copy of `set` as another phone would send it. */
const fromServer = (set: ActivitySet, patch: Partial<ActivitySet>): CheckedRow => {
  const encoded = { ...set, ...patch };
  return {
    table: "activity_set",
    id: set.id,
    updatedAt: encoded.updatedAt,
    deletedAt: encoded.deletedAt,
    encoded,
    changeId: changeIdOf("activity_set", encoded),
  };
};

describe("SyncRepository", () => {
  it("queues every row this phone writes, but not the bundled library or coach chats", async () => {
    const on = phone();
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
    await logLegDay(on);
    await on.run(
      Effect.flatMap(Effect.service(CoachMessageRepository), (repository) =>
        repository.append({
          conversationId: chatId,
          role: "user",
          content: "How was leg day?",
        }),
      ),
    );
    const queued = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    expect(queued.map(({ table }) => table).sort()).toEqual([
      "activity",
      "activity_exercise",
      "activity_exercise",
      "activity_set",
      "activity_set",
      "activity_set",
      "activity_set",
    ]);
  });

  it("sends each row as stored and forgets it once the server confirms it", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const queued = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    const activity = queued.find(({ table }) => table === "activity");
    expect(activity?.row).toMatchObject({ id, title: "Legs", hiddenFields: "[]", deletedAt: null });
    await on.run(Effect.flatMap(sync, (repository) => repository.confirm(queued)));
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
  });

  it("pages through the queue in the order rows changed", async () => {
    const on = phone();
    await logLegDay(on);
    const first = await on.run(
      Effect.flatMap(sync, (repository) => repository.queued(undefined, 4)),
    );
    const rest = await on.run(
      Effect.flatMap(sync, (repository) => repository.queued(first.at(-1), 4)),
    );
    expect(first).toHaveLength(4);
    expect(rest).toHaveLength(3);
    expect(new Set([...first, ...rest].map(({ id }) => id)).size).toBe(7);
  });

  it("keeps a row queued when it changed again after the copy the server confirmed", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const sent = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    const set = await firstSet(on, id);
    await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 6 })),
    );
    await on.run(Effect.flatMap(sync, (repository) => repository.confirm(sent)));
    const left = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    expect(left.map(({ id: rowId, row }) => [rowId, (row as ActivitySet).reps])).toEqual([
      [set.id, 6],
    ]);
  });

  it("takes the server's copy of a row with no unsent change, whatever its time", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const sent = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    await on.run(Effect.flatMap(sync, (repository) => repository.confirm(sent)));
    const set = await firstSet(on, id);

    const newer = fromServer(set, { reps: 3, updatedAt: EpochMillis.make(T0 + HOUR) });
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.apply([newer], 7)))).toBe(
      1,
    );
    expect((await firstSet(on, id)).reps).toBe(3);

    // The server's copy is the one every phone ends with, such as a delete that beat an edit.
    const older = fromServer(set, { reps: 9, updatedAt: EpochMillis.make(T0 - HOUR) });
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.apply([older], 8)))).toBe(
      1,
    );
    expect((await firstSet(on, id)).reps).toBe(9);

    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.state))).toEqual({
      cursor: 8,
      clock: T0 + HOUR,
      newestSeen: T0 + HOUR,
    });
  });

  it("keeps its own unsent newer change over an older copy from the server", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const set = await firstSet(on, id);
    await on.at(T0 + MINUTE);
    await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 6 })),
    );
    const older = fromServer(set, { reps: 9, updatedAt: EpochMillis.make(T0 + 1) });
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.apply([older], 1)))).toBe(
      0,
    );
    expect((await firstSet(on, id)).reps).toBe(6);
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(7);
  });

  it("drops its own unsent change when a newer one from the server wins", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const sent = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    await on.run(Effect.flatMap(sync, (repository) => repository.confirm(sent)));
    const set = await firstSet(on, id);
    await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 6 })),
    );
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(1);

    const newer = fromServer(set, { reps: 3, updatedAt: EpochMillis.make(T0 + HOUR) });
    await on.run(Effect.flatMap(sync, (repository) => repository.apply([newer], 1)));
    expect((await firstSet(on, id)).reps).toBe(3);
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
  });

  it("times two writes in the same millisecond one after the other", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const set = await firstSet(on, id);
    const first = await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 6 })),
    );
    const second = await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 12 })),
    );
    expect(first.updatedAt).toBe(T0 + 1);
    expect(second.updatedAt).toBe(T0 + 2);
  });

  it("keeps time moving forward after the phone's clock moves back", async () => {
    const on = phone();
    await on.at(T0 + HOUR);
    const id = await logLegDay(on);
    const set = await firstSet(on, id);
    await on.at(T0);
    const edited = await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 6 })),
    );
    expect(edited.updatedAt).toBe(T0 + HOUR + 1);
  });

  it("keeps its clock across a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "svett-clock-")), "phone.db");
    const open = (millis: number) => {
      const { database, driver } = openNodeDatabase(path);
      const runtime = ManagedRuntime.make(
        Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(1)), manualClock(millis).layer),
      );
      return { database, runtime };
    };
    const before = open(T0 + HOUR);
    const id = await before.runtime.runPromise(
      Effect.flatMap(activities, (repository) => repository.create(legDay(MADE_HERE))),
    );
    await before.runtime.dispose();
    before.database.close();

    // The phone restarts with its clock an hour back.
    const after = open(T0);
    const edited = await after.runtime.runPromise(
      Effect.flatMap(activities, (repository) =>
        Effect.flatMap(repository.get(id), (detail) =>
          repository.update(Option.getOrThrow(detail).activity.id, { title: "Leg day" }),
        ),
      ),
    );
    expect(edited.updatedAt).toBe(T0 + HOUR + 1);
    await after.runtime.dispose();
    after.database.close();
  });

  it("times an edit after the newest change it applied, though its own clock is behind", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const set = await firstSet(on, id);
    const ahead = EpochMillis.make(T0 + HOUR);
    await on.run(
      Effect.flatMap(sync, (repository) =>
        repository.apply([fromServer(set, { reps: 3, updatedAt: ahead })], 1),
      ),
    );
    const edited = await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 4 })),
    );
    expect(edited.updatedAt).toBe(ahead + 1);
  });

  it("does not count a set under a deleted workout", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const set = await firstSet(on, id);
    await on.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
    // Another phone edited the set after this one deleted the workout.
    await on.run(
      Effect.flatMap(sync, (repository) =>
        repository.apply([fromServer(set, { reps: 7, updatedAt: EpochMillis.make(T0 + HOUR) })], 1),
      ),
    );
    expect(await on.run(Effect.flatMap(activities, (repository) => repository.counts))).toEqual({
      activities: 0,
      sets: 0,
    });
  });

  it("sends no coach chat, even one an import's journal kept, and Undo still brings it back", async () => {
    const on = phone();
    await sayToCoach(on, "My knee hurt on squats");
    const file = await exportFile(on);
    const message = (file.tables.coachMessage ?? [])[0]!;
    const replacement: SvettFile = {
      ...file,
      tables: { coachMessage: [{ ...message, content: "Squats felt fine" }] },
      rows: 1,
    };
    await on.at(T0 + MINUTE);
    const importBatchId = await importAll(on, replacement);
    expect((await chat(on)).map(({ content }) => content)).toEqual(["Squats felt fine"]);

    const server = standIn(() => T0 + MINUTE);
    await on.run(syncOnce(server.api));
    const payload = JSON.stringify(server.pushes);
    expect(server.sent().map(({ table }) => table)).toEqual(["import_batch"]);
    expect(payload).not.toContain("My knee hurt on squats");
    expect(payload).not.toContain("Squats felt fine");
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);

    await on.at(T0 + 2 * MINUTE);
    await transfer(on, (repository) => repository.undoImport(importBatchId, []));
    expect((await chat(on)).map(({ content }) => content)).toEqual(["My knee hurt on squats"]);
    await on.run(syncOnce(server.api));
    expect(JSON.stringify(server.pushes)).not.toContain("My knee hurt on squats");
  });

  it("sends no journal of a coach chat that arrives inside another phone's file", async () => {
    const other = phone(2);
    await sayToCoach(other, "My knee hurt on squats");
    const original = await exportFile(other);
    const message = (original.tables.coachMessage ?? [])[0]!;
    await other.at(T0 + MINUTE);
    await importAll(other, {
      ...original,
      tables: { coachMessage: [{ ...message, content: "Squats felt fine" }] },
      rows: 1,
    });
    const file = await exportFile(other);
    expect(JSON.stringify(file.tables.importChange)).toContain("My knee hurt on squats");

    const on = phone(3);
    await on.at(T0 + 2 * MINUTE);
    await importAll(on, file);
    const server = standIn(() => T0 + 2 * MINUTE);
    await on.run(syncOnce(server.api));
    const payload = JSON.stringify(server.pushes);
    expect(payload).not.toContain("My knee hurt on squats");
    expect(payload).not.toContain("Squats felt fine");
    expect(server.sent().map(({ table }) => table)).not.toContain("coach_message");
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
  });

  it("holds changes while the phone's clock is ahead, then sends them once it is right", async () => {
    const on = phone();
    const server = standIn(() => T0);
    const id = await logLegDay(on);
    await on.run(syncOnce(server.api));
    const set = await firstSet(on, id);

    // The phone's clock runs an hour ahead while the set is edited and the workout deleted.
    await on.at(T0 + HOUR);
    await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 6 })),
    );
    await on.at(T0 + HOUR + MINUTE);
    await on.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
    expect(await on.run(syncOnce(server.api))).toEqual({ pushed: 0, held: 7, pulled: 0 });

    // The clock is right again. The retry moves the changes to times the server takes.
    await on.at(T0 + 2 * MINUTE);
    server.pushes.length = 0;
    expect(await on.run(syncOnce(server.api))).toEqual({ pushed: 7, held: 0, pulled: 0 });
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
    const times = server.pushes
      .at(-1)!
      .map(({ row }) => row as { updatedAt: number; deletedAt: number | null });
    for (const { updatedAt, deletedAt } of times) {
      expect(isTooFarAhead(updatedAt, T0 + 2 * MINUTE)).toBe(false);
      expect(deletedAt).toBe(updatedAt);
    }
    // Every row the delete removed still shares its time, so Undo brings back the edited set.
    await on.run(Effect.flatMap(activities, (repository) => repository.restore(id)));
    expect((await firstSet(on, id)).reps).toBe(6);
    const later = await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 7 })),
    );
    expect(isTooFarAhead(later.updatedAt, T0 + 2 * MINUTE)).toBe(false);
  });

  it("keeps an import made while the clock was ahead undoable as unchanged", async () => {
    const other = phone(2);
    await logLegDay(other);
    const file = await exportFile(other);
    const on = phone();
    await on.at(T0 + HOUR);
    const importBatchId = await importAll(on, file);
    const server = standIn(() => T0);
    expect((await on.run(syncOnce(server.api))).held).toBeGreaterThan(0);
    await on.at(T0 + MINUTE);
    expect((await on.run(syncOnce(server.api))).held).toBe(0);
    const preview = await transfer(on, (repository) => repository.previewUndo(importBatchId));
    expect(preview.changes.map(({ edited }) => edited)).toEqual([false]);
  });

  it("keeps holding changes while the phone's clock is still ahead", async () => {
    const on = phone();
    await on.at(T0 + HOUR);
    await logLegDay(on);
    const server = standIn(() => T0);
    expect(await on.run(syncOnce(server.api))).toEqual({ pushed: 0, held: 7, pulled: 0 });
    expect(await on.run(syncOnce(server.api))).toEqual({ pushed: 0, held: 7, pulled: 0 });
  });
});

/** The server's copies of `rows`, each changed by `patch` when it gives one for its ID. */
const serverCopies = (
  rows: ReadonlyArray<{ readonly table: SyncedTable; readonly row: unknown }>,
  patch: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
) =>
  Effect.runPromise(
    Effect.forEach(rows, ({ table, row }) => {
      const id = (row as { id: string }).id;
      return checkSyncRow(table, { ...(row as object), ...patch[id] });
    }),
  );

/** Every order of `items`. */
const orders = <A>(items: ReadonlyArray<A>): Array<ReadonlyArray<A>> =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        orders(items.filter((_, other) => other !== index)).map((rest) => [item].concat(rest)),
      );

/** Runs `step` on each item, one after another. */
const inTurn = <A>(items: ReadonlyArray<A>, step: (item: A) => Promise<unknown>) =>
  items.reduce<Promise<unknown>>((done, item) => done.then(() => step(item)), Promise.resolve());

const apply = (on: Phone, rows: ReadonlyArray<CheckedRow>, next: number) =>
  on.run(Effect.flatMap(sync, (repository) => repository.apply(rows, next)));

/**
 * A leg day the server already holds, put back in progress here a minute later with its
 * first set changed to 99 reps. Gives its ID and the server's copies of its rows.
 */
const reopenedLegDay = async () => {
  const on = phone();
  const id = await logLegDay(on);
  const sent = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
  await on.run(Effect.flatMap(sync, (repository) => repository.confirm(sent)));
  const onServer = await workoutRows(on.runtime, id);
  await on.at(T0 + MINUTE);
  await on.run(
    Effect.flatMap(activities, (repository) => repository.update(id, { status: "in_progress" })),
  );
  const set = await firstSet(on, id);
  await on.run(
    Effect.flatMap(activities, (repository) => repository.updateWorkoutSet(set.id, { reps: 99 })),
  );
  return { on, id, set, onServer };
};

describe("a workout in progress", () => {
  type Sent = ReadonlyArray<{ readonly table: SyncedTable; readonly row: unknown }>;
  /** What `server` got of the workout whose rows are `rows`. */
  const sentOf = (server: ReturnType<typeof standIn>, rows: Sent) => {
    const ids = new Set(rows.map(({ row }) => (row as { id: string }).id));
    return server.sent().filter(({ row }) => ids.has((row as { id: string }).id));
  };
  const byRow = (a: Sent[number], b: Sent[number]) =>
    `${a.table}/${(a.row as { id: string }).id}`.localeCompare(
      `${b.table}/${(b.row as { id: string }).id}`,
    );

  it("keeps a workout in progress and every row under it out of what sync sends", async () => {
    const on = phone();
    await logLegDay(on);
    const id = await on.run(startPushDay());
    const server = standIn(() => T0);
    expect(await on.run(syncOnce(server.api))).toEqual({ pushed: 7, held: 0, pulled: 0 });
    const rows = await workoutRows(on.runtime, id);
    expect(rows.map(({ table }) => table)).toEqual([
      "activity",
      "activity_exercise",
      "activity_exercise",
      "activity_set",
      "activity_set",
      "activity_set",
      "activity_set",
    ]);
    expect(sentOf(server, rows)).toEqual([]);
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
  });

  it("sends the whole workout once it is finished, rows written while in progress too", async () => {
    const on = phone();
    const id = await on.run(startPushDay());
    const server = standIn(() => T0);
    await on.run(syncOnce(server.api));
    await on.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(id)));
    await on.run(syncOnce(server.api));
    const rows = await workoutRows(on.runtime, id);
    const sent = sentOf(server, rows);
    expect(sent).toHaveLength(7);
    expect(sent.toSorted(byRow)).toEqual(rows.toSorted(byRow));
    expect(sent[0]).toMatchObject({
      table: "activity",
      row: { id, status: "finished", title: "Push day" },
    });
    // Finishing left out the set that was not done, and that deletion goes too.
    expect(sent.filter(({ row }) => (row as ActivitySet).deletedAt !== null)).toHaveLength(1);
  });

  it("sends nothing of a workout in progress that is discarded", async () => {
    const on = phone();
    const id = await on.run(startPushDay());
    await on.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
    const server = standIn(() => T0);
    expect(await on.run(syncOnce(server.api))).toEqual({ pushed: 0, held: 0, pulled: 0 });
    expect(server.pushes).toEqual([]);
  });

  it("changes nothing of a reopened workout when the server's older copy of it arrives", async () => {
    const { on, id, set, onServer } = await reopenedLegDay();
    const draft = await workoutRows(on.runtime, id);
    expect(await apply(on, await serverCopies(onServer), 1)).toBe(0);
    expect(await workoutRows(on.runtime, id)).toEqual(draft);
    expect(draft[0]?.row).toMatchObject({ status: "in_progress" });
    expect((await firstSet(on, id)).reps).toBe(99);
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);

    // Finished, every row of it goes up timed after the server's copies, so this one wins.
    await on.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(id)));
    const queued = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    expect(queued.map(({ id: rowId }) => rowId).toSorted()).toEqual(
      onServer.map(({ row }) => (row as { id: string }).id).toSorted(),
    );
    const newestOnServer = Math.max(
      ...onServer.map(({ row }) => (row as { updatedAt: number }).updatedAt),
    );
    for (const { row } of queued) {
      expect((row as { updatedAt: number }).updatedAt).toBeGreaterThan(newestOnServer);
    }
    expect(queued.find(({ id: rowId }) => rowId === set.id)?.row).toMatchObject({ reps: 99 });
    expect(queued.find(({ id: rowId }) => rowId === id)?.row).toMatchObject({
      status: "finished",
    });
  });

  const addedSet = "0190a0b2-0000-7000-8000-0000000000d1";
  const cases = (["one", "several"] as const).flatMap((pages) =>
    orders(["activity", "set", "added set"] as const).map((order) => ({ pages, order })),
  );

  it.each(cases)(
    "keeps a workout in progress here when its rows arrive in $pages page(s) as $order",
    async ({ pages, order }) => {
      const { on, id, set, onServer } = await reopenedLegDay();
      const draft = await workoutRows(on.runtime, id);
      const later = EpochMillis.make(T0 + 2 * MINUTE);
      const setOnServer = onServer.find(({ row }) => (row as { id: string }).id === set.id);
      if (setOnServer === undefined) throw new Error("The server has no copy of the set");
      const [activity, changedSet, added] = await serverCopies(
        [
          onServer[0] as Sent[number],
          setOnServer,
          {
            table: "activity_set",
            row: { ...(setOnServer.row as object), id: addedSet, position: 9 },
          },
        ],
        {
          [id]: { title: "Renamed elsewhere", updatedAt: later },
          [set.id]: { reps: 3, updatedAt: later },
          [addedSet]: { reps: 4, updatedAt: later },
        },
      );
      const byName = { activity, set: changedSet, "added set": added };
      const page = order.map((name) => byName[name] as CheckedRow);
      if (pages === "one") await apply(on, page, 1);
      else await inTurn([...page.entries()], ([index, row]) => apply(on, [row], index + 1));

      const now = await workoutRows(on.runtime, id);
      expect(now.filter(({ row }) => (row as { id: string }).id !== addedSet)).toEqual(draft);
      expect(now.find(({ row }) => (row as { id: string }).id === addedSet)?.row).toMatchObject({
        deletedAt: later,
      });
      expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);

      // Finished, it goes up as this phone has it, and the set added elsewhere goes deleted.
      await on.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(id)));
      const queued = await on.run(
        Effect.flatMap(sync, (repository) => repository.queued(undefined)),
      );
      const sentRow = (rowId: string) =>
        queued.find(({ id: queuedId }) => queuedId === rowId)?.row as {
          readonly updatedAt: number;
        };
      expect(sentRow(id)).toMatchObject({ title: "Legs", status: "finished" });
      expect(sentRow(set.id)).toMatchObject({ reps: 99 });
      expect(sentRow(addedSet)).toMatchObject({ deletedAt: later });
      for (const rowId of [id, set.id, addedSet]) {
        expect(sentRow(rowId).updatedAt).toBeGreaterThan(later);
      }
    },
  );

  it("keeps a workout started here, that the server has never seen, through a pull", async () => {
    const on = phone();
    const id = await on.run(startPushDay());
    const draft = await workoutRows(on.runtime, id);
    const elsewhere = phone(2);
    const other = await logLegDay(elsewhere);
    const page = await serverCopies(await workoutRows(elsewhere.runtime, other));
    expect(await apply(on, page, 1)).toBe(page.length);
    expect(await workoutRows(on.runtime, id)).toEqual(draft);
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
    await on.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(id)));
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(
      draft.length,
    );
  });

  it("takes a finished workout put back in progress out of the queue until it is finished again", async () => {
    const on = phone();
    const id = await on.run(startPushDay());
    await on.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(id)));
    await on.run(
      Effect.flatMap(activities, (repository) => repository.update(id, { status: "in_progress" })),
    );
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
    await on.run(
      Effect.flatMap(activities, (repository) => repository.update(id, { status: "finished" })),
    );
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(7);
  });
});
