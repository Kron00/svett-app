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
  type CheckedRow,
  isTooFarAhead,
  type SyncedTable,
  type SyncPushResult,
} from "../sync.ts";
import { legDay } from "../sync-testing.ts";
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
