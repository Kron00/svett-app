import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { type ActivityId, type ActivitySet, ConversationId, EpochMillis } from "../schema.ts";
import { changeIdOf, type CheckedRow } from "../sync.ts";
import { legDay } from "../sync-testing.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { ActivityRepository } from "./activities.ts";
import { MADE_HERE } from "./origin.ts";
import { CoachMessageRepository } from "./records.ts";
import { SyncRepository } from "./sync.ts";

const HOUR = 3_600_000;

const phone = () => {
  const database = openTestDatabase();
  const run = <A, E>(
    effect: Effect.Effect<A, E, SyncRepository | ActivityRepository | CoachMessageRepository>,
  ) => database.runtime.runPromise(effect);
  return { ...database, run };
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
          conversationId: ConversationId.make("0190a0b2-0000-7000-8000-0000000000c0"),
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

  it("takes a newer copy from the server, keeps its own newer one, and queues neither", async () => {
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

    const older = fromServer(set, { reps: 9, updatedAt: EpochMillis.make(T0 - HOUR) });
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.apply([older], 8)))).toBe(
      0,
    );
    expect((await firstSet(on, id)).reps).toBe(3);

    expect(await on.run(Effect.flatMap(sync, (repository) => repository.queuedCount))).toBe(0);
    expect(await on.run(Effect.flatMap(sync, (repository) => repository.state))).toEqual({
      cursor: 8,
      newestSeen: T0 + HOUR,
    });
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
});
