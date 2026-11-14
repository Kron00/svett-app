import { Effect, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "../duration.ts";
import {
  sampleGpx,
  sampleHealthZip,
  sampleHevyDraft,
  SAMPLE_STRENGTH_START,
} from "../health-sample.ts";
import { EpochMillis, Fingerprint, SourceIdentity } from "../schema.ts";
import { readSourceFile, type SourceFile } from "../source-file.ts";
import {
  heartRateSummary,
  isNothingFromSource,
  NO_CHOICES,
  sourceActivityId,
  type SourceWorkout,
} from "../source-import.ts";
import { openTestDatabase } from "../test-database.ts";
import { bytesSource } from "../zip.ts";
import { ActivityRepository } from "./activities.ts";
import { ImportRepository } from "./records.ts";
import { TransferRepository } from "./transfer.ts";

type Database = ReturnType<typeof openTestDatabase>;

const read = async (bytes: Uint8Array): Promise<SourceFile> =>
  Result.getOrThrow(
    await readSourceFile(bytesSource(bytes), { hourOf: (at) => new Date(at).getUTCHours() }),
  );

const health = () => read(sampleHealthZip());
const gpx = () => read(new TextEncoder().encode(sampleGpx()));

const transfers = <A, E>(
  database: Database,
  body: (repository: typeof TransferRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(TransferRepository), body));

const activities = <A, E>(
  database: Database,
  body: (repository: typeof ActivityRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(ActivityRepository), body));

const counts = (database: Database) => activities(database, (repository) => repository.counts);

const liveRows = (database: Database, table: string) =>
  database.database.prepare(`SELECT count(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get()![
    "n"
  ];

/** Seeds a strength workout as a Hevy import would leave it. */
const seedHevy = (database: Database) =>
  database.runtime.runPromise(
    Effect.gen(function* () {
      const batch = yield* (yield* ImportRepository).create("hevy");
      return yield* (yield* ActivityRepository).create(sampleHevyDraft(batch));
    }),
  );

const importAll = (database: Database, file: SourceFile, choices = NO_CHOICES) =>
  transfers(database, (repository) =>
    repository.applySourceImport(file.source, file.workouts, choices),
  );

describe("importing from Apple Health and GPX", () => {
  it("previews the new workouts, and declining saves nothing", async () => {
    const database = openTestDatabase();
    const file = await health();
    const plan = await transfers(database, (repository) =>
      repository.previewSourceImport(file.workouts),
    );
    expect(plan.added).toBe(4);
    expect(plan.duplicates).toEqual([]);
    expect(plan.items.map((item) => item.workout.title)).toEqual([
      "Yoga",
      "Afternoon ride",
      "Evening workout",
      "Morning run",
    ]);
    expect(await counts(database)).toEqual({ activities: 0, sets: 0 });
    expect(await transfers(database, (repository) => repository.listImports)).toEqual([]);
  });

  it("imports each workout once and only once", async () => {
    const database = openTestDatabase();
    const file = await health();
    const result = await importAll(database, file);
    expect(
      Option.map(result, ({ added, linked, replaced }) => ({ added, linked, replaced })),
    ).toEqual(Option.some({ added: 4, linked: 0, replaced: 0 }));
    expect(await counts(database)).toEqual({ activities: 4, sets: 0 });

    const again = await transfers(database, (repository) =>
      repository.previewSourceImport(file.workouts),
    );
    expect(isNothingFromSource(again)).toBe(true);
    expect(again.unchanged).toBe(4);
    expect(await importAll(database, file)).toEqual(Option.none());
    expect(await counts(database)).toEqual({ activities: 4, sets: 0 });
    expect(await transfers(database, (repository) => repository.listImports)).toHaveLength(1);
  });

  it("saves a run's route, splits and heart rate, and a GPX ride's own heart rate", async () => {
    const database = openTestDatabase();
    const file = await health();
    await importAll(database, file);
    await importAll(database, await gpx());
    const run = file.workouts.find((workout) => workout.kind === "run")!;
    const detail = Option.getOrThrow(
      await activities(database, (repository) => repository.get(sourceActivityId(run))),
    );
    expect(detail.activity).toMatchObject({
      title: "Morning run",
      source: "apple_health",
      energyKcal: 320,
      durationS: 1800,
    });
    expect(detail.track!.distanceM).toBeCloseTo(5020, 6);
    const samples = await activities(database, (repository) =>
      repository.samples(detail.track!.id),
    );
    expect(samples.filter((sample) => sample.kind === "location")).toHaveLength(61);
    expect(
      samples.filter((sample) => sample.kind === "split").map((split) => split.kind),
    ).toHaveLength(6);
    expect(heartRateSummary(samples)).toEqual({ averageBpm: 152, maxBpm: 164 });

    const [ride] = (await gpx()).workouts;
    const rideDetail = Option.getOrThrow(
      await activities(database, (repository) => repository.get(sourceActivityId(ride!))),
    );
    expect(rideDetail.activity).toMatchObject({
      source: "gpx",
      kind: "ride",
      title: "Saturday ride & coffee",
    });
    const rideSamples = await activities(database, (repository) =>
      repository.samples(rideDetail.track!.id),
    );
    expect(heartRateSummary(rideSamples)).toEqual({ averageBpm: 129, maxBpm: 139 });
  });

  it("shows a Health copy of a Hevy workout as one possible duplicate, and links it", async () => {
    const database = openTestDatabase();
    const hevyId = await seedHevy(database);
    const before = await counts(database);
    expect(before).toEqual({ activities: 1, sets: 9 });
    const file = await health();

    const plan = await transfers(database, (repository) =>
      repository.previewSourceImport(file.workouts),
    );
    expect(plan.added).toBe(3);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]).toMatchObject({
      workout: { kind: "strength", startedAt: SAMPLE_STRENGTH_START },
      match: { id: hevyId, title: "Push day", source: "hevy" },
    });

    const result = Option.getOrThrow(await importAll(database, file));
    expect(result).toMatchObject({ added: 3, linked: 1, replaced: 0 });
    expect(await counts(database)).toEqual({ activities: 4, sets: 9 });

    const linked = Option.getOrThrow(
      await activities(database, (repository) => repository.get(hevyId)),
    );
    expect(linked.activity).toMatchObject({ title: "Push day", source: "hevy" });
    expect(linked.exercises.flatMap((exercise) => exercise.sets)).toHaveLength(9);
    const samples = await activities(database, (repository) =>
      repository.samples(linked.track!.id),
    );
    expect(heartRateSummary(samples)).toEqual({ averageBpm: 112, maxBpm: 124 });
    const sources = await activities(database, (repository) => repository.sources(hevyId));
    expect(sources.map(({ source, sourceId }) => ({ source, sourceId }))).toEqual([
      { source: "apple_health", sourceId: plan.duplicates[0]!.workout.identity },
    ]);

    // Neither source imports it again.
    const again = await transfers(database, (repository) =>
      repository.previewSourceImport(file.workouts),
    );
    expect(isNothingFromSource(again)).toBe(true);
    expect(await importAll(database, file)).toEqual(Option.none());
  });

  it("keeps both when asked, and Undo takes a link back to the Hevy workout as it was", async () => {
    const database = openTestDatabase();
    const hevyId = await seedHevy(database);
    const file = await health();
    const duplicate = (
      await transfers(database, (repository) => repository.previewSourceImport(file.workouts))
    ).duplicates[0]!;

    const apart = openTestDatabase();
    await seedHevy(apart);
    const kept = Option.getOrThrow(
      await importAll(apart, file, { take: [], keepBoth: [duplicate.key] }),
    );
    expect(kept).toMatchObject({ added: 4, linked: 0 });
    expect(await counts(apart)).toEqual({ activities: 5, sets: 9 });
    expect(liveRows(apart, "activity_source")).toBe(0);

    const result = Option.getOrThrow(await importAll(database, file));
    const preview = await transfers(database, (repository) =>
      repository.previewUndo(result.importBatchId),
    );
    expect(preview.changes.map(({ change }) => change.change).toSorted()).toEqual([
      "added",
      "added",
      "added",
      "replaced",
    ]);
    const undone = await transfers(database, (repository) =>
      repository.undoImport(result.importBatchId, []),
    );
    expect(undone).toEqual({ removed: 3, restored: 1, left: 0 });
    expect(await counts(database)).toEqual({ activities: 1, sets: 9 });
    const back = Option.getOrThrow(
      await activities(database, (repository) => repository.get(hevyId)),
    );
    expect(back.track).toBeNull();
    expect(liveRows(database, "activity_source")).toBe(0);
    expect(liveRows(database, "activity_sample")).toBe(0);

    // After Undo the duplicate shows again.
    const replanned = await transfers(database, (repository) =>
      repository.previewSourceImport(file.workouts),
    );
    expect(replanned.duplicates).toHaveLength(1);
    expect(replanned.added).toBe(3);
  });

  it("lists a workout whose source changed, and keeps yours unless the new one is taken", async () => {
    const database = openTestDatabase();
    const file = await health();
    await importAll(database, file);
    const yoga = file.workouts.find((workout) => workout.kind === "other")!;
    const longer: SourceWorkout = {
      ...yoga,
      durationS: DurationSeconds.make(1500),
      endedAt: EpochMillis.make(yoga.endedAt + 300_000),
      fingerprint: Fingerprint.make("f".repeat(64)),
    };
    const plan = await transfers(database, (repository) =>
      repository.previewSourceImport([longer]),
    );
    expect(plan.changed.map((item) => item.local)).toEqual([sourceActivityId(yoga)]);

    expect(await importAll(database, { ...file, workouts: [longer] })).toEqual(Option.none());
    const kept = Option.getOrThrow(
      await activities(database, (repository) => repository.get(sourceActivityId(yoga))),
    );
    expect(kept.activity.durationS).toBe(1200);

    const taken = Option.getOrThrow(
      await importAll(
        database,
        { ...file, workouts: [longer] },
        { take: [plan.changed[0]!.key], keepBoth: [] },
      ),
    );
    expect(taken).toMatchObject({ added: 0, linked: 0, replaced: 1 });
    const replaced = Option.getOrThrow(
      await activities(database, (repository) => repository.get(sourceActivityId(yoga))),
    );
    expect(replaced.activity.durationS).toBe(1500);
    await transfers(database, (repository) => repository.undoImport(taken.importBatchId, []));
    const restored = Option.getOrThrow(
      await activities(database, (repository) => repository.get(sourceActivityId(yoga))),
    );
    expect(restored.activity.durationS).toBe(1200);
  });

  it("records two workouts that link to one activity as one change, so Undo takes both back", async () => {
    const database = openTestDatabase();
    const hevyId = await seedHevy(database);
    const file = await health();
    const strength = file.workouts.find((workout) => workout.kind === "strength")!;
    const second: SourceWorkout = {
      ...strength,
      identity: SourceIdentity.make(`${strength.identity} again`),
      heartRate: [],
    };
    const result = Option.getOrThrow(
      await importAll(database, { ...file, workouts: [strength, second] }),
    );
    expect(result).toMatchObject({ added: 0, linked: 2 });
    expect(liveRows(database, "activity_source")).toBe(2);
    const preview = await transfers(database, (repository) =>
      repository.previewUndo(result.importBatchId),
    );
    expect(preview.changes).toHaveLength(1);
    expect(
      await transfers(database, (repository) => repository.undoImport(result.importBatchId, [])),
    ).toEqual({ removed: 0, restored: 1, left: 0 });
    expect(liveRows(database, "activity_source")).toBe(0);
    const back = Option.getOrThrow(
      await activities(database, (repository) => repository.get(hevyId)),
    );
    expect(back.exercises.flatMap((exercise) => exercise.sets)).toHaveLength(9);
  });

  it("deletes and restores an activity's linked sources with it", async () => {
    const database = openTestDatabase();
    const hevyId = await seedHevy(database);
    await importAll(database, await health());
    await activities(database, (repository) => repository.remove(hevyId));
    expect(liveRows(database, "activity_source")).toBe(0);
    await activities(database, (repository) => repository.restore(hevyId));
    expect(liveRows(database, "activity_source")).toBe(1);
  });
});
