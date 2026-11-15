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
  MAX_SYNC_ROWS,
  type PushedRow,
  type SyncedTable,
  type SyncPushResult,
} from "../sync.ts";
import { legDay, startPushDay, workoutRows } from "../sync-testing.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { ActivityRepository } from "./activities.ts";
import { MADE_HERE } from "./origin.ts";
import { CoachMessageRepository } from "./records.ts";
import { pushesOf, type QueuedRow, type SyncApi, SyncRepository, syncOnce } from "./sync.ts";
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
  const pushes: Array<ReadonlyArray<PushedRow>> = [];
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

/** How many deletions `on` still has to name to the server for its Undos. */
const restoresLeft = (on: Phone) =>
  Number(on.database.prepare("SELECT count(*) AS n FROM sync_restore").get()?.["n"]);

/** Deletes and undoes the workout `id` on `on`, and reads, sends and confirms its queue. */
const undoSteps = (on: Phone, id: ActivityId) => {
  const queued = () => on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
  return {
    queued,
    sending: (rows: ReadonlyArray<QueuedRow>) =>
      on.run(Effect.flatMap(sync, (repository) => repository.sending(rows))),
    confirm: (rows: ReadonlyArray<QueuedRow>) =>
      on.run(Effect.flatMap(sync, (repository) => repository.confirm(rows))),
    workout: async () => {
      const found = (await queued()).find(({ id: rowId }) => rowId === id);
      if (found === undefined) throw new Error("The workout is not queued");
      return found;
    },
    step: async (minutes: number, change: "remove" | "restore") => {
      await on.at(T0 + minutes * MINUTE);
      await (change === "remove"
        ? on.run(Effect.flatMap(activities, (repository) => repository.remove(id)))
        : on.run(Effect.flatMap(activities, (repository) => repository.restore(id))));
      return T0 + minutes * MINUTE;
    },
  };
};

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

  it("sends an Undo with the deletion it reverses, until the server confirms it", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const queued = () => on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    const confirmAll = async () => {
      const rows = await queued();
      await on.run(Effect.flatMap(sync, (repository) => repository.confirm(rows)));
    };
    await confirmAll();
    await on.at(T0 + MINUTE);
    await on.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
    const removed = await queued();
    expect(removed).toHaveLength(7);
    expect(removed.every(({ restores }) => restores.length === 0)).toBe(true);
    const deletedAt = (removed[0]?.row as { deletedAt: number } | undefined)?.deletedAt;
    expect(deletedAt).toBeTypeOf("number");
    await confirmAll();

    await on.at(T0 + 2 * MINUTE);
    await on.run(Effect.flatMap(activities, (repository) => repository.restore(id)));
    const set = await firstSet(on, id);
    await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 6 })),
    );
    const restored = await queued();
    expect(restored).toHaveLength(7);
    expect(restored.map(({ restores }) => restores)).toEqual(restored.map(() => [deletedAt]));

    await confirmAll();
    await on.run(
      Effect.flatMap(activities, (repository) => repository.updateSet(set.id, { reps: 7 })),
    );
    expect((await queued()).map(({ id: rowId, restores }) => [rowId, restores])).toEqual([
      [set.id, []],
    ]);
  });

  it("sends each deletion an Undo reversed until a push sent with it is confirmed, also while one is on the way", async () => {
    const on = phone();
    const { queued, sending, confirm, workout, step } = undoSteps(on, await logLegDay(on));
    await confirm(await queued());
    const first = await step(1, "remove");
    await confirm(await queued());

    await step(2, "restore");
    const second = await step(3, "remove");
    const onTheWay = await queued();
    await sending(onTheWay);
    expect((await workout()).restores).toEqual([first]);
    await step(4, "restore");
    expect((await workout()).restores).toEqual([first, second]);

    await confirm(onTheWay);
    expect((await workout()).restores).toEqual([second]);
    expect((await workout()).row).toMatchObject({ deletedAt: null });
    await confirm(await queued());
    expect(await queued()).toEqual([]);
  });

  it("names no deletion that no push carried, through 1,000 delete and Undo cycles", async () => {
    const on = phone();
    const { queued, confirm, step } = undoSteps(on, await logLegDay(on));
    await confirm(await queued());
    for (let cycle = 0; cycle < 1_000; cycle++) {
      await step(2 * cycle + 1, "remove");
      await step(2 * cycle + 2, "restore");
    }

    const left = await queued();
    expect(left).toHaveLength(7);
    expect(left.map(({ restores }) => restores)).toEqual(left.map(() => []));
    expect(left.map(({ row }) => (row as { deletedAt: number | null }).deletedAt)).toEqual(
      left.map(() => null),
    );
    expect(restoresLeft(on)).toBe(0);
  });

  it.each(["confirmed", "answer lost"] as const)(
    "still names a deletion a push carried when Undo reverses it offline, %s",
    async (outcome) => {
      const on = phone();
      const { queued, sending, confirm, workout, step } = undoSteps(on, await logLegDay(on));
      await confirm(await queued());
      const sent = await step(1, "remove");
      const push = await queued();
      await sending(push);
      if (outcome === "confirmed") await confirm(push);
      await step(2, "restore");
      await step(3, "remove");
      await step(4, "restore");

      expect((await workout()).restores).toEqual([sent]);
      const named = await queued();
      expect(named.map(({ restores }) => restores)).toEqual(named.map(() => [sent]));
    },
  );

  it("names a deletion that Undo reversed after the push carrying it was read and before it left", async () => {
    const on = phone();
    const { queued, sending, confirm, workout, step } = undoSteps(on, await logLegDay(on));
    await confirm(await queued());
    const read = await step(1, "remove");
    const push = await queued();
    await step(2, "restore");
    expect((await workout()).restores).toEqual([]);

    await sending(push);
    expect((await workout()).restores).toEqual([read]);
  });

  it("names a deletion an import brought when Undo of the import reverses it, since another phone may have sent it", async () => {
    const on = phone();
    const id = await logLegDay(on);
    const { queued, confirm, workout, step } = undoSteps(on, id);
    await confirm(await queued());
    const deletedAt = await step(1, "remove");
    const file = await exportFile(on);
    await step(2, "restore");
    await confirm(await queued());

    await on.at(T0 + 3 * MINUTE);
    const importBatchId = await importAll(on, file);
    await on.at(T0 + 4 * MINUTE);
    await transfer(on, (repository) => repository.undoImport(importBatchId, []));

    expect((await workout()).row).toMatchObject({ deletedAt: null });
    expect((await workout()).restores).toEqual([deletedAt]);
  });

  it("splits a row's Undo deletions across pushes when they pass one push's limit, newest first", () => {
    const restores = Array.from({ length: 2 * MAX_SYNC_ROWS + 3 }, (_, index) => index);
    const page: Array<QueuedRow> = [
      { mark: 1, table: "activity", id: "a", row: { id: "a" }, restores },
      { mark: 2, table: "activity", id: "b", row: { id: "b" }, restores: [7] },
      { mark: 3, table: "activity", id: "c", row: { id: "c" }, restores: [] },
    ];

    const pushes = pushesOf(page);
    expect(pushes.map((rows) => rows.map(({ row }) => (row as { id: string }).id))).toEqual([
      ["a", "b", "c"],
      ["a"],
      ["a"],
    ]);
    expect(pushes.flat().every(({ restores: sent = [] }) => sent.length <= MAX_SYNC_ROWS)).toBe(
      true,
    );
    expect(pushes.flatMap((rows) => rows[0]?.restores ?? [])).toEqual([...restores].reverse());
    expect(pushes[0]?.slice(1)).toEqual([
      { table: "activity", row: { id: "b" }, restores: [7] },
      { table: "activity", row: { id: "c" } },
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

const setsOf = async (on: Phone, id: ActivityId) =>
  Option.getOrThrow(
    await on.run(Effect.flatMap(activities, (repository) => repository.get(id))),
  ).exercises.flatMap((exercise) => exercise.sets.map(({ id: setId, reps }) => ({ setId, reps })));

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

    // Finished, every row of it goes up, each with the time it last changed here.
    await on.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(id)));
    const queued = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    const sent = new Map(queued.map(({ id: rowId, row }) => [rowId, row]));
    expect([...sent.keys()].toSorted()).toEqual(
      onServer.map(({ row }) => (row as { id: string }).id).toSorted(),
    );
    const edited = draft.find(({ row }) => row["id"] === set.id)?.row;
    expect(edited).toMatchObject({ reps: 99 });
    expect(sent.get(set.id)).toEqual(edited);
    expect(sent.get(id)).toMatchObject({ status: "finished" });
    for (const { row } of onServer) {
      const rowId = (row as { id: string }).id;
      if (rowId !== id && rowId !== set.id) expect(sent.get(rowId)).toEqual(row);
    }
  });

  const addedSet = "0190a0b2-0000-7000-8000-0000000000d1";
  const later = EpochMillis.make(T0 + 2 * MINUTE);

  /**
   * The server's copies of the reopened leg day's workout renamed, its first set at 3 reps
   * and a set added, as another phone changed them after the reopen here.
   */
  const changedElsewhere = async (
    onServer: Sent,
    setId: string,
    id: ActivityId,
  ): Promise<Record<"activity" | "set" | "added set", CheckedRow>> => {
    const setOnServer = onServer.find(({ row }) => (row as { id: string }).id === setId);
    if (setOnServer === undefined) throw new Error("The server has no copy of the set");
    const [activity, set, added] = await serverCopies(
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
        [setId]: { reps: 3, updatedAt: later },
        [addedSet]: { reps: 4, updatedAt: later },
      },
    );
    if (activity === undefined || set === undefined || added === undefined) {
      throw new Error("A copy is missing");
    }
    return { activity, set, "added set": added };
  };

  const cases = (["one", "several"] as const).flatMap((pages) =>
    orders(["activity", "set", "added set"] as const).map((order) => ({ pages, order })),
  );

  it.each(cases)(
    "keeps a workout in progress here as it is when its rows arrive in $pages page(s) as $order, and merges them once finished",
    async ({ pages, order }) => {
      const { on, id, set, onServer } = await reopenedLegDay();
      const draft = await workoutRows(on.runtime, id);
      const byName = await changedElsewhere(onServer, set.id, id);
      const page = order.map((name) => byName[name]);
      if (pages === "one") await apply(on, page, 1);
      else await inTurn([...page.entries()], ([index, row]) => apply(on, [row], index + 1));

      expect(await workoutRows(on.runtime, id)).toEqual(draft);
      expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);

      // Finished, each row goes to its later change: the rename and the set's 3 reps came
      // after the reopen and the 99 reps here, and the set added elsewhere is kept.
      await on.run(Effect.flatMap(activities, (repository) => repository.finishWorkout(id)));
      const detail = Option.getOrThrow(
        await on.run(Effect.flatMap(activities, (repository) => repository.get(id))),
      );
      expect(detail.activity).toMatchObject({ title: "Renamed elsewhere", status: "finished" });
      expect(await setsOf(on, id)).toEqual(
        expect.arrayContaining([
          { setId: set.id, reps: 3 },
          { setId: addedSet, reps: 4 },
        ]),
      );
      const queued = await on.run(
        Effect.flatMap(sync, (repository) => repository.queued(undefined)),
      );
      for (const rowId of [id, set.id, addedSet]) {
        expect(queued.some(({ id: queuedId }) => queuedId === rowId)).toBe(false);
      }
    },
  );

  it("puts a discarded workout back as it was before it was reopened here", async () => {
    const { on, id, set } = await reopenedLegDay();
    await on.run(Effect.flatMap(activities, (repository) => repository.remove(id)));
    const detail = Option.getOrThrow(
      await on.run(Effect.flatMap(activities, (repository) => repository.get(id))),
    );
    expect(detail.activity).toMatchObject({ title: "Legs", status: "finished" });
    expect((await setsOf(on, id)).find(({ setId }) => setId === set.id)).toEqual({
      setId: set.id,
      reps: 5,
    });
    expect(await setsOf(on, id)).toHaveLength(4);
  });

  it("keeps another phone's changes when a workout reopened here is discarded", async () => {
    const { on, id, set, onServer } = await reopenedLegDay();
    const mine = await on.run(
      Effect.flatMap(activities, (repository) =>
        Effect.flatMap(repository.get(id), (found) =>
          repository.addSet(Option.getOrThrow(found).exercises[0]!.exercise.id, {
            setType: "normal",
            weightKg: 110,
            reps: 2,
            durationS: null,
            distanceM: null,
            targetRepsMin: null,
            targetRepsMax: null,
          }),
        ),
      ),
    );
    const byName = await changedElsewhere(onServer, set.id, id);
    await apply(on, [byName.activity, byName.set, byName["added set"]], 1);
    await on.run(Effect.flatMap(activities, (repository) => repository.remove(id)));

    const detail = Option.getOrThrow(
      await on.run(Effect.flatMap(activities, (repository) => repository.get(id))),
    );
    expect(detail.activity).toMatchObject({ title: "Renamed elsewhere", status: "finished" });
    const sets = await setsOf(on, id);
    expect(sets).toHaveLength(5);
    expect(sets).toEqual(
      expect.arrayContaining([
        { setId: set.id, reps: 3 },
        { setId: addedSet, reps: 4 },
      ]),
    );
    expect(sets.some(({ setId }) => setId === mine)).toBe(false);
    // What other phones have goes up again, and nothing written here while in progress does.
    const queued = await on.run(Effect.flatMap(sync, (repository) => repository.queued(undefined)));
    expect(queued.map(({ id: rowId }) => rowId).toSorted()).toEqual(
      [...onServer.map(({ row }) => (row as { id: string }).id), addedSet].toSorted(),
    );
  });

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
