import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "../duration.ts";
import { contentFingerprint } from "../ids.ts";
import { libraryExerciseId } from "../exercise-library.ts";
import {
  ActivityId,
  EpochMillis,
  Fingerprint,
  type ImportBatchId,
  SourceIdentity,
} from "../schema.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { ImportRepository } from "./records.ts";
import {
  type ActivityDraft,
  ActivityRepository,
  type PlannedSet,
  type SetDraft,
  type NewWorkout,
} from "./activities.ts";
import { MADE_HERE, type Origin } from "./origin.ts";

const set = (
  weightKg: number,
  reps: number,
  setType: SetDraft["setType"] = "normal",
): SetDraft => ({
  setType,
  weightKg,
  reps,
  durationS: null,
  distanceM: null,
  rpe: null,
});

const planned = (values: Partial<PlannedSet>): PlannedSet => ({
  setType: "normal",
  weightKg: null,
  reps: null,
  durationS: null,
  distanceM: null,
  targetRepsMin: null,
  targetRepsMax: null,
  ...values,
});

const workout = (origin: Origin = MADE_HERE): ActivityDraft => ({
  kind: "strength",
  startedAt: EpochMillis.make(T0 - 3_600_000),
  durationS: DurationSeconds.make(3_300),
  title: "Legs",
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: [],
  origin,
  exercises: [
    {
      exerciseId: libraryExerciseId("Barbell_Squat"),
      supersetGroup: null,
      notes: "",
      sets: [set(60, 8, "warm_up"), set(100, 5), set(100, 5)],
    },
    {
      exerciseId: libraryExerciseId("Lying_Leg_Curls"),
      supersetGroup: null,
      notes: "slow",
      sets: [set(40, 12)],
    },
  ],
  track: null,
});

const run = <A, E>(
  database: ReturnType<typeof openTestDatabase>,
  body: (repository: typeof ActivityRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(ActivityRepository), body));

const importOn = async (seed: number) => {
  const database = openTestDatabase(seed);
  const batch: ImportBatchId = await database.runtime.runPromise(
    Effect.flatMap(Effect.service(ImportRepository), (imports) => imports.create("hevy")),
  );
  const origin: Origin = {
    source: "hevy",
    sourceId: SourceIdentity.make("2025-12-31T08:00:00Z"),
    fingerprint: Fingerprint.make(contentFingerprint({ title: "Legs" })),
    importBatchId: batch,
  };
  const id = await run(database, (activities) => activities.create(workout(origin)));
  return database.database
    .prepare(
      `SELECT id FROM activity WHERE id = :id
       UNION ALL SELECT id FROM activity_exercise WHERE activity_id = :id
       UNION ALL SELECT s.id FROM activity_set s JOIN activity_exercise e ON e.id = s.activity_exercise_id WHERE e.activity_id = :id
       ORDER BY id`,
    )
    .all({ id })
    .map((row) => row["id"]);
};

describe("ActivityRepository", () => {
  it("creates a draft with its own ID once, however often it is created", async () => {
    const database = openTestDatabase();
    const chosen = ActivityId.make("0190a000-0000-7000-8000-0000000000aa");
    const ids = await run(database, (activities) =>
      Effect.all([
        activities.create({ ...workout(), id: chosen }),
        activities.create({ ...workout(), id: chosen, title: "Legs again" }),
      ]),
    );
    expect(ids).toEqual([chosen, chosen]);
    const detail = await run(database, (activities) => activities.get(chosen));
    expect(Option.getOrThrow(detail).activity.title).toBe("Legs");
    expect(await run(database, (activities) => activities.counts)).toEqual({
      activities: 1,
      sets: 4,
    });
  });

  it("creates an activity and reads it back with its exercises and sets in order", async () => {
    const database = openTestDatabase();
    const detail = await run(database, (activities) =>
      Effect.flatMap(activities.create(workout()), activities.get),
    );
    const { activity, exercises } = Option.getOrThrow(detail);
    expect(activity).toMatchObject({ title: "Legs", source: "svett", audience: "only_you" });
    expect(activity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(exercises.map(({ exercise }) => exercise.notes)).toEqual(["", "slow"]);
    expect(exercises[0]?.sets.map((row) => [row.setType, row.weightKg, row.reps])).toEqual([
      ["warm_up", 60, 8],
      ["normal", 100, 5],
      ["normal", 100, 5],
    ]);
    expect(await run(database, (activities) => activities.counts)).toEqual({
      activities: 1,
      sets: 4,
    });
  });

  it("lists the newest activities first, a page at a time", async () => {
    const database = openTestDatabase();
    const titles = await run(database, (activities) =>
      Effect.gen(function* () {
        for (const day of [1, 3, 2]) {
          yield* activities.create({
            ...workout(),
            title: `Day ${day}`,
            startedAt: EpochMillis.make(T0 + day * 86_400_000),
          });
        }
        const page = yield* activities.list({ limit: 2 });
        const next = yield* activities.list({ limit: 2, before: page.at(-1)! });
        return [page, next].map((rows) => rows.map((row) => row.title));
      }),
    );
    expect(titles).toEqual([["Day 3", "Day 2"], ["Day 1"]]);
  });

  it("pages through workouts that start at the same moment without skipping any", async () => {
    const database = openTestDatabase();
    const pages = await run(database, (activities) =>
      Effect.gen(function* () {
        for (const title of ["A", "B", "C"]) {
          yield* activities.create({ ...workout(), title });
        }
        const page = yield* activities.list({ limit: 2 });
        const next = yield* activities.list({ limit: 2, before: page.at(-1)! });
        return [page, next].map((rows) => rows.length);
      }),
    );
    expect(pages).toEqual([2, 1]);
  });

  it("keeps both of two concurrent edits, and a concurrent delete stays deleted", async () => {
    const database = openTestDatabase();
    const id = await run(database, (activities) => activities.create(workout()));
    await run(database, (activities) =>
      Effect.all(
        [activities.update(id, { title: "Push" }), activities.update(id, { notes: "PR" })],
        {
          concurrency: "unbounded",
        },
      ),
    );
    const edited = Option.getOrThrow(await run(database, (activities) => activities.get(id)));
    expect(edited.activity).toMatchObject({ title: "Push", notes: "PR" });

    await run(database, (activities) =>
      Effect.all([Effect.exit(activities.update(id, { title: "Pull" })), activities.remove(id)], {
        concurrency: "unbounded",
      }),
    );
    expect(await run(database, (activities) => activities.get(id))).toEqual(Option.none());
  });

  it("starts a workout in progress that history and counts leave out until it is finished", async () => {
    const database = openTestDatabase();
    await run(database, (activities) => activities.create(workout()));
    const started: NewWorkout = {
      title: "Push",
      routineId: null,
      exercises: [
        {
          exerciseId: libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip"),
          supersetGroup: null,
          notes: "",
          sets: [planned({ weightKg: 80, targetRepsMin: 5, targetRepsMax: 8 }), planned({})],
        },
      ],
    };
    const id = await run(database, (activities) => activities.startWorkout(started));

    const current = Option.getOrThrow(await run(database, (activities) => activities.inProgress));
    expect(current.activity).toMatchObject({
      id,
      kind: "strength",
      status: "in_progress",
      startedAt: T0,
      title: "Push",
    });
    expect(current.exercises[0]?.sets.map((row) => [row.done, row.weightKg, row.reps])).toEqual([
      [false, 80, null],
      [false, null, null],
    ]);
    expect(
      (await run(database, (activities) => activities.list())).map((row) => row.title),
    ).toEqual(["Legs"]);
    expect(await run(database, (activities) => activities.counts)).toEqual({
      activities: 1,
      sets: 4,
    });

    await run(database, (activities) => activities.update(id, { status: "finished" }));
    expect(await run(database, (activities) => activities.inProgress)).toEqual(Option.none());
    // Neither set was marked done, so only the workout counts.
    expect(await run(database, (activities) => activities.counts)).toEqual({
      activities: 2,
      sets: 4,
    });
  });

  it("refuses a second workout while one is in progress, and allows one after a discard", async () => {
    const database = openTestDatabase();
    const start: NewWorkout = { title: "Push", routineId: null, exercises: [] };
    const first = await run(database, (activities) => activities.startWorkout(start));
    const exit = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.startWorkout({ ...start, title: "Pull" }),
      ),
    );
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "WorkoutInProgressError", activityId: first } }] },
    });
    await run(database, (activities) => activities.remove(first));
    expect(await run(database, (activities) => activities.inProgress)).toEqual(Option.none());
    const second = await run(database, (activities) =>
      activities.startWorkout({ ...start, title: "Pull" }),
    );
    expect(
      Option.getOrThrow(await run(database, (activities) => activities.inProgress)).activity.id,
    ).toBe(second);
  });

  it("refuses to restore a discarded workout in progress while another is in progress", async () => {
    const database = openTestDatabase();
    const start: NewWorkout = { title: "Push", routineId: null, exercises: [] };
    const first = await run(database, (activities) => activities.startWorkout(start));
    await run(database, (activities) => activities.remove(first));
    await database.runtime.runPromise(database.clock.advance(1000));
    const second = await run(database, (activities) =>
      activities.startWorkout({ ...start, title: "Pull" }),
    );

    const exit = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.restore(first)),
    );
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "WorkoutInProgressError", activityId: second } }] },
    });
    expect(await run(database, (activities) => activities.get(first))).toEqual(Option.none());
    expect(
      Option.getOrThrow(await run(database, (activities) => activities.inProgress)).activity.id,
    ).toBe(second);

    await run(database, (activities) => activities.remove(second));
    await run(database, (activities) => activities.restore(first));
    expect(
      Option.getOrThrow(await run(database, (activities) => activities.inProgress)).activity.id,
    ).toBe(first);
  });

  it("refuses to put a workout back in progress while another is in progress", async () => {
    const database = openTestDatabase();
    const finished = await run(database, (activities) => activities.create(workout()));
    const running = await run(database, (activities) =>
      activities.startWorkout({ title: "Push", routineId: null, exercises: [] }),
    );

    const exit = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.update(finished, { status: "in_progress" }),
      ),
    );
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "WorkoutInProgressError", activityId: running } }] },
    });
    const kept = Option.getOrThrow(await run(database, (activities) => activities.get(finished)));
    expect(kept.activity.status).toBe("finished");

    const renamed = await run(database, (activities) =>
      activities.update(running, { title: "Push A" }),
    );
    expect(renamed).toMatchObject({ status: "in_progress", title: "Push A" });
  });

  it("refuses to mark an empty set done", async () => {
    const database = openTestDatabase();
    await run(database, (activities) =>
      activities.startWorkout({
        title: "Push",
        routineId: null,
        exercises: [
          {
            exerciseId: libraryExerciseId("Side_Lateral_Raise"),
            supersetGroup: null,
            notes: "",
            sets: [planned({})],
          },
        ],
      }),
    );
    const current = Option.getOrThrow(await run(database, (activities) => activities.inProgress));
    const setId = current.exercises[0]!.sets[0]!.id;
    const exit = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.updateSet(setId, { done: true }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const done = await run(database, (activities) =>
      activities.updateSet(setId, { done: true, reps: 12 }),
    );
    expect(done).toMatchObject({ done: true, reps: 12 });
  });

  it("refuses a set that records nothing and writes none of the activity", async () => {
    const database = openTestDatabase();
    const draft = workout();
    const empty = { ...set(100, 0), reps: null };
    const broken = {
      ...draft,
      exercises: [{ ...draft.exercises[0]!, sets: [set(100, 5), empty] }],
    };
    const exit = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.create(broken)),
    );
    expect(exit).toMatchObject({
      cause: { reasons: [{ error: { _tag: "InvalidRowError", table: "activity_set" } }] },
    });
    expect(await run(database, (activities) => activities.counts)).toEqual({
      activities: 0,
      sets: 0,
    });
  });

  it("updates an activity and a set, and moves updated_at forward", async () => {
    const database = openTestDatabase();
    const id = await run(database, (activities) => activities.create(workout()));
    await database.runtime.runPromise(database.clock.advance(60_000));
    const detail = await run(database, (activities) =>
      Effect.gen(function* () {
        yield* activities.update(id, { title: "Heavy legs", audience: "followers" });
        const before = Option.getOrThrow(yield* activities.get(id));
        const setId = before.exercises[0]!.sets[1]!.id;
        yield* activities.updateSet(setId, { weightKg: 102.5, rpe: 8.5 });
        return Option.getOrThrow(yield* activities.get(id));
      }),
    );
    expect(detail.activity).toMatchObject({
      title: "Heavy legs",
      audience: "followers",
      updatedAt: T0 + 60_000,
    });
    expect(detail.exercises[0]!.sets[1]).toMatchObject({
      weightKg: 102.5,
      rpe: 8.5,
      updatedAt: T0 + 60_000,
    });
  });

  it("refuses an update that would break a rule", async () => {
    const database = openTestDatabase();
    const exit = await database.runtime.runPromiseExit(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* activities.create(workout());
        const detail = Option.getOrThrow(yield* activities.get(id));
        return yield* activities.updateSet(detail.exercises[0]!.sets[0]!.id, { rpe: 11 });
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("deletes an activity with its exercises, sets and route, and reads skip them", async () => {
    const database = openTestDatabase();
    const kept = await run(database, (activities) => activities.create(workout()));
    const removed = await run(database, (activities) =>
      activities.create({
        ...workout(),
        kind: "run",
        title: "Run",
        exercises: [],
        track: {
          distanceM: 5_000,
          elevationGainM: 20,
          hideStartM: 200,
          hideEndM: 200,
          samples: [
            {
              kind: "location",
              recordedAt: EpochMillis.make(T0),
              segment: 0,
              latitude: 59.33,
              longitude: 18.07,
              altitudeM: null,
            },
            { kind: "heart_rate", recordedAt: EpochMillis.make(T0 + 1000), bpm: 140 },
            {
              kind: "split",
              recordedAt: EpochMillis.make(T0 + 300_000),
              distanceM: 1000,
              durationS: DurationSeconds.make(300),
            },
          ],
        },
      }),
    );
    const before = Option.getOrThrow(await run(database, (activities) => activities.get(removed)));
    const trackId = before.track!.id;
    expect(
      (await run(database, (activities) => activities.samples(trackId))).map((s) => s.kind),
    ).toEqual(["location", "heart_rate", "split"]);

    await database.runtime.runPromise(database.clock.advance(1000));
    await run(database, (activities) => activities.remove(removed));

    expect(await run(database, (activities) => activities.get(removed))).toEqual(Option.none());
    expect((await run(database, (activities) => activities.list())).map((a) => a.id)).toEqual([
      kept,
    ]);
    expect(await run(database, (activities) => activities.samples(trackId))).toEqual([]);
    const deletedAt = database.database
      .prepare(
        `SELECT DISTINCT deleted_at AS at FROM (
           SELECT deleted_at FROM activity WHERE id = :id
           UNION ALL SELECT deleted_at FROM activity_track WHERE activity_id = :id
           UNION ALL SELECT deleted_at FROM activity_sample WHERE activity_track_id = :track)`,
      )
      .all({ id: removed, track: trackId });
    expect(deletedAt).toEqual([{ at: T0 + 1000 }]);
    expect(await run(database, (activities) => activities.counts)).toEqual({
      activities: 1,
      sets: 4,
    });
  });

  it("restores a deleted activity with what it had, but not a set deleted before", async () => {
    const database = openTestDatabase();
    const id = await run(database, (activities) => activities.create(workout()));
    const setId = Option.getOrThrow(await run(database, (activities) => activities.get(id)))
      .exercises[0]!.sets[0]!.id;
    database.database.prepare("UPDATE activity_set SET deleted_at = 5 WHERE id = ?").run(setId);
    await database.runtime.runPromise(database.clock.advance(1000));
    await run(database, (activities) => activities.remove(id));
    await database.runtime.runPromise(database.clock.advance(1000));
    await run(database, (activities) => activities.restore(id));

    const restored = Option.getOrThrow(await run(database, (activities) => activities.get(id)));
    expect(restored.activity.updatedAt).toBe(T0 + 2000);
    expect(restored.exercises.map(({ sets }) => sets.length)).toEqual([2, 1]);
  });

  it("fails to delete an activity that is not there", async () => {
    const database = openTestDatabase();
    const id = await run(database, (activities) => activities.create(workout()));
    await run(database, (activities) => activities.remove(id));
    const exit = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.remove(id)),
    );
    expect(exit).toMatchObject({ cause: { reasons: [{ error: { _tag: "RowNotFoundError" } }] } });
  });

  it("gives an imported workout and its children the same IDs on two devices", async () => {
    const first = await importOn(1);
    expect(first).toHaveLength(1 + 2 + 4);
    expect(await importOn(2)).toEqual(first);
  });
});
