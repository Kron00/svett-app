import { readFileSync } from "node:fs";

import { Effect, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "../duration.ts";
import { libraryExerciseId } from "../exercise-library.ts";
import {
  SAMPLE_GPX_START,
  sampleExportXml,
  sampleGpx,
  sampleHealthZip,
  sampleHevyDraft,
  SAMPLE_STRENGTH_START,
} from "../health-sample.ts";
import { decodeHevyFile, wallTimeAsUtc } from "../hevy-file.ts";
import { hevyImport } from "../hevy-import.ts";
import { importedId } from "../ids.ts";
import { EpochMillis, Fingerprint, type ImportBatchId, SourceIdentity } from "../schema.ts";
import { readSourceFile, type SourceFile } from "../source-file.ts";
import {
  heartRateSummary,
  isNothingFromSource,
  NO_CHOICES,
  sourceActivityId,
  type SourceWorkout,
} from "../source-import.ts";
import { openTestDatabase } from "../test-database.ts";
import { isNothingToImport } from "../transfer.ts";
import { bytesSource } from "../zip.ts";
import { ActivityRepository } from "./activities.ts";
import { ExerciseAliasRepository } from "./exercises.ts";
import { ImportRepository } from "./records.ts";
import { TransferRepository } from "./transfer.ts";

type Database = ReturnType<typeof openTestDatabase>;

const read = async (bytes: Uint8Array): Promise<SourceFile> =>
  Result.getOrThrow(
    await readSourceFile(bytesSource(bytes), { hourOf: (at) => new Date(at).getUTCHours() }),
  );

const text = (value: string) => read(new TextEncoder().encode(value));
const health = () => read(sampleHealthZip());
const gpx = () => text(sampleGpx());
/** The sample ride with no heart rate in its points, and another name when given one. */
const plainGpx = (name = "Saturday ride & coffee") =>
  text(
    sampleGpx()
      .replaceAll(/<extensions>.*?<\/extensions>/g, "")
      .replace("Saturday ride &amp; coffee", name),
  );

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

const planOf = (database: Database, file: SourceFile) =>
  transfers(database, (repository) => repository.previewSourceImport(file.workouts));

const heartOf = async (database: Database, id: Parameters<typeof sourceActivityId>[0] | string) => {
  const activityId = typeof id === "string" ? id : sourceActivityId(id);
  const detail = Option.getOrThrow(
    await activities(database, (repository) => repository.get(activityId as never)),
  );
  if (detail.track === null) return null;
  return heartRateSummary(
    await activities(database, (repository) => repository.samples(detail.track!.id)),
  );
};

const otherIds = (database: Database) =>
  database.database
    .prepare("SELECT id, duration_s FROM activity WHERE kind = 'other' ORDER BY id")
    .all();

const linkFingerprints = (database: Database) =>
  database.database
    .prepare("SELECT fingerprint FROM activity_source WHERE deleted_at IS NULL ORDER BY id")
    .all()
    .map((row) => row["fingerprint"]);

/** The sample strength workout from Health with its heart rate 10 beats higher. */
const correctedStrength = (file: SourceFile): SourceWorkout => {
  const strength = file.workouts.find((workout) => workout.kind === "strength")!;
  return {
    ...strength,
    heartRate: strength.heartRate.map(({ recordedAt, bpm }) => ({ recordedAt, bpm: bpm + 10 })),
    fingerprint: Fingerprint.make("e".repeat(64)),
  };
};

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
    expect(undone).toEqual({ removed: 3, restored: 1, left: 0, kept: 0 });
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
    ).toEqual({ removed: 0, restored: 1, left: 0, kept: 0 });
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

  it("imports Health workouts that share a source, start and type as two, with the same IDs every time", async () => {
    const yoga = sampleExportXml()
      .split("\n")
      .find((line) => line.includes("HKWorkoutActivityTypeYoga"))!;
    const longer = yoga.replace('duration="20"', 'duration="25"');
    const xml = (order: ReadonlyArray<string>) =>
      text(sampleExportXml().replace(yoga, order.join("\n")));

    const database = openTestDatabase();
    const file = await xml([yoga, longer]);
    const plan = await planOf(database, file);
    expect(plan.added).toBe(5);
    expect(plan.collisions.map((item) => item.workout.durationS).toSorted()).toEqual([1200, 1500]);
    const result = Option.getOrThrow(await importAll(database, file));
    expect(result.added).toBe(5);
    expect(await counts(database)).toEqual({ activities: 5, sets: 0 });
    expect(isNothingFromSource(await planOf(database, file))).toBe(true);

    const swapped = await xml([longer, yoga]);
    expect(isNothingFromSource(await planOf(database, swapped))).toBe(true);
    const other = openTestDatabase();
    await importAll(other, swapped);
    expect(otherIds(other)).toEqual(otherIds(database));
  });

  it("keeps the IDs of Health workouts with the same start as others join, leave and change", async () => {
    const database = openTestDatabase();
    const file = await health();
    const yoga = file.workouts.find((workout) => workout.kind === "other")!;
    // Fingerprint order is a, b, c, so b lands between the other two.
    const shared = (minutes: number, digit: string): SourceWorkout => ({
      ...yoga,
      endedAt: EpochMillis.make(yoga.startedAt + minutes * 60_000),
      durationS: DurationSeconds.make(minutes * 60),
      fingerprint: Fingerprint.make(digit.repeat(64)),
    });
    const [a, b, c] = [shared(20, "1"), shared(25, "2"), shared(30, "3")] as const;
    const only = (...workouts: ReadonlyArray<SourceWorkout>): SourceFile => ({
      ...file,
      workouts,
    });

    await importAll(database, only(a, c));
    const first = otherIds(database);
    expect(await planOf(database, only(a, b, c))).toMatchObject({ added: 1, unchanged: 2 });
    expect(Option.getOrThrow(await importAll(database, only(a, b, c))).added).toBe(1);
    expect(otherIds(database)).toEqual(expect.arrayContaining(first));
    expect(await counts(database)).toEqual({ activities: 3, sets: 0 });
    expect(isNothingFromSource(await planOf(database, only(a, c)))).toBe(true);
    expect(isNothingFromSource(await planOf(database, only(c, b, a)))).toBe(true);

    const changedB = shared(26, "4");
    const plan = await planOf(database, only(a, changedB, c));
    expect(plan).toMatchObject({ added: 0, unchanged: 2 });
    expect(plan.changed).toHaveLength(1);
    await importAll(database, only(a, changedB, c), {
      take: [plan.changed[0]!.key],
      keepBoth: [],
    });
    expect(await counts(database)).toEqual({ activities: 3, sets: 0 });
    expect(
      otherIds(database)
        .map((row) => row["duration_s"])
        .toSorted(),
    ).toEqual([1200, 1560, 1800]);
  });

  it("lists a linked workout whose heart rate was corrected, takes it when asked, and Undo puts the old one back", async () => {
    const database = openTestDatabase();
    const hevyId = await seedHevy(database);
    const file = await health();
    await importAll(database, file);
    expect(await heartOf(database, hevyId)).toEqual({ averageBpm: 112, maxBpm: 124 });
    const linkedBefore = linkFingerprints(database);

    const corrected = { ...file, workouts: [correctedStrength(file)] };
    const plan = await planOf(database, corrected);
    expect(plan.changed).toMatchObject([{ local: hevyId, linked: true }]);
    expect(plan.unchanged).toBe(0);
    // Kept by default.
    expect(await importAll(database, corrected)).toEqual(Option.none());
    expect(await heartOf(database, hevyId)).toEqual({ averageBpm: 112, maxBpm: 124 });

    const taken = Option.getOrThrow(
      await importAll(database, corrected, { take: [plan.changed[0]!.key], keepBoth: [] }),
    );
    expect(taken).toMatchObject({ added: 0, linked: 0, replaced: 1 });
    expect(await heartOf(database, hevyId)).toEqual({ averageBpm: 122, maxBpm: 134 });
    expect(linkFingerprints(database)).toEqual(["e".repeat(64)]);
    expect(await counts(database)).toEqual({ activities: 4, sets: 9 });
    expect(isNothingFromSource(await planOf(database, corrected))).toBe(true);

    expect(
      await transfers(database, (repository) => repository.undoImport(taken.importBatchId, [])),
    ).toEqual({ removed: 0, restored: 1, left: 0, kept: 0 });
    expect(await heartOf(database, hevyId)).toEqual({ averageBpm: 112, maxBpm: 124 });
    expect(linkFingerprints(database)).toEqual(linkedBefore);
    expect(await counts(database)).toEqual({ activities: 4, sets: 9 });
  });

  it("records corrections to two links on one activity as one change, and Undo puts both back", async () => {
    const database = openTestDatabase();
    const hevyId = await seedHevy(database);
    const file = await health();
    const strength = file.workouts.find((workout) => workout.kind === "strength")!;
    const second: SourceWorkout = {
      ...strength,
      identity: SourceIdentity.make(`${strength.identity} again`),
      heartRate: [],
      fingerprint: Fingerprint.make("d".repeat(64)),
    };
    await importAll(database, { ...file, workouts: [strength, second] });
    const linkedBefore = linkFingerprints(database);
    expect(await heartOf(database, hevyId)).toEqual({ averageBpm: 112, maxBpm: 124 });

    const corrected: SourceFile = {
      ...file,
      workouts: [
        correctedStrength(file),
        { ...second, fingerprint: Fingerprint.make("f".repeat(64)) },
      ],
    };
    const plan = await planOf(database, corrected);
    expect(plan.changed).toMatchObject([
      { local: hevyId, linked: true },
      { local: hevyId, linked: true },
    ]);
    const taken = Option.getOrThrow(
      await importAll(database, corrected, {
        take: plan.changed.map((item) => item.key),
        keepBoth: [],
      }),
    );
    expect(taken).toMatchObject({ added: 0, linked: 0, replaced: 2 });
    expect(await heartOf(database, hevyId)).toEqual({ averageBpm: 122, maxBpm: 134 });
    expect(linkFingerprints(database).toSorted()).toEqual(["e".repeat(64), "f".repeat(64)]);

    const preview = await transfers(database, (repository) =>
      repository.previewUndo(taken.importBatchId),
    );
    expect(preview.changes.map(({ edited }) => edited)).toEqual([false]);
    expect(
      await transfers(database, (repository) => repository.undoImport(taken.importBatchId, [])),
    ).toEqual({ removed: 0, restored: 1, left: 0, kept: 0 });
    expect(await heartOf(database, hevyId)).toEqual({ averageBpm: 112, maxBpm: 124 });
    expect(linkFingerprints(database)).toEqual(linkedBefore);
    expect(await counts(database)).toEqual({ activities: 1, sets: 9 });
  });

  it("keeps the heart rate a Health link brought when a GPX ride is replaced by its renamed version", async () => {
    const database = openTestDatabase();
    const ride = await plainGpx();
    await importAll(database, ride);
    const rideWorkout = ride.workouts[0]!;
    expect(await heartOf(database, rideWorkout)).toBeNull();

    const healthRide: SourceWorkout = {
      ...correctedStrength(await health()),
      source: "apple_health",
      identity: SourceIdentity.make("health ride"),
      kind: "ride",
      startedAt: EpochMillis.make(SAMPLE_GPX_START),
      endedAt: EpochMillis.make(SAMPLE_GPX_START + 40 * 60_000),
      heartRate: [0, 1, 2].map((minute) => ({
        recordedAt: EpochMillis.make(SAMPLE_GPX_START + minute * 60_000),
        bpm: 130 + minute,
      })),
    };
    const healthFile: SourceFile = { source: "apple_health", workouts: [healthRide], skipped: 0 };
    expect((await planOf(database, healthFile)).duplicates).toHaveLength(1);
    await importAll(database, healthFile);
    const linkedHeart = { averageBpm: 131, maxBpm: 132 };
    expect(await heartOf(database, rideWorkout)).toEqual(linkedHeart);

    const renamed = await plainGpx("Ride to the lake");
    const plan = await planOf(database, renamed);
    expect(plan.changed).toMatchObject([{ local: sourceActivityId(rideWorkout), linked: false }]);
    const taken = Option.getOrThrow(
      await importAll(database, renamed, { take: [plan.changed[0]!.key], keepBoth: [] }),
    );
    const detail = Option.getOrThrow(
      await activities(database, (repository) => repository.get(sourceActivityId(rideWorkout))),
    );
    expect(detail.activity.title).toBe("Ride to the lake");
    expect(await heartOf(database, rideWorkout)).toEqual(linkedHeart);
    expect(liveRows(database, "activity_source")).toBe(1);
    expect(isNothingFromSource(await planOf(database, healthFile))).toBe(true);

    await transfers(database, (repository) => repository.undoImport(taken.importBatchId, []));
    const back = Option.getOrThrow(
      await activities(database, (repository) => repository.get(sourceActivityId(rideWorkout))),
    );
    expect(back.activity.title).toBe("Saturday ride & coffee");
    expect(await heartOf(database, rideWorkout)).toEqual(linkedHeart);
  });

  it("asks before Undo takes back a link to a workout edited since, and then removes only the link", async () => {
    const linked = async () => {
      const database = openTestDatabase();
      const hevyId = await seedHevy(database);
      const result = Option.getOrThrow(await importAll(database, await health()));
      const change = (
        await transfers(database, (repository) => repository.previewUndo(result.importBatchId))
      ).changes.find((row) => row.change.change === "replaced")!;
      expect(change.edited).toBe(false);
      return { database, hevyId, result, changeId: change.change.id };
    };
    const editedOf = async (database: Database, importBatchId: typeof ImportBatchId.Type) =>
      (
        await transfers(database, (repository) => repository.previewUndo(importBatchId))
      ).changes.find((row) => row.change.change === "replaced")!.edited;

    const titled = await linked();
    await activities(titled.database, (repository) =>
      repository.update(titled.hevyId, { title: "Push day, heavy" }),
    );
    expect(await editedOf(titled.database, titled.result.importBatchId)).toBe(true);
    expect(
      await transfers(titled.database, (repository) =>
        repository.undoImport(titled.result.importBatchId, []),
      ),
    ).toEqual({ removed: 3, restored: 0, left: 1, kept: 0 });
    expect(liveRows(titled.database, "activity_source")).toBe(1);

    const set = await linked();
    const detail = Option.getOrThrow(
      await activities(set.database, (repository) => repository.get(set.hevyId)),
    );
    const firstSet = detail.exercises[0]!.sets[0]!;
    await activities(set.database, (repository) => repository.updateSet(firstSet.id, { reps: 10 }));
    expect(await editedOf(set.database, set.result.importBatchId)).toBe(true);
    expect(
      await transfers(set.database, (repository) =>
        repository.undoImport(set.result.importBatchId, [set.changeId]),
      ),
    ).toEqual({ removed: 3, restored: 1, left: 0, kept: 0 });
    expect(liveRows(set.database, "activity_source")).toBe(0);
    expect(await heartOf(set.database, set.hevyId)).toBeNull();
    const after = Option.getOrThrow(
      await activities(set.database, (repository) => repository.get(set.hevyId)),
    );
    expect(after.exercises[0]!.sets[0]!.reps).toBe(10);
    expect(after.exercises.flatMap((exercise) => exercise.sets)).toHaveLength(9);
  });
});

describe("Apple Health and Hevy's own import", () => {
  // Hevy writes clock times with no zone. Read them in the sample export's +01:00 zone,
  // so Hevy's Push Day, 18:30 to 19:35, overlaps Health's strength workout, 18:05 to 19:00.
  const hevyFile = Result.getOrThrow(
    decodeHevyFile(
      readFileSync(new URL("../../test-data/hevy-sample.csv", import.meta.url), "utf8"),
      (time) => wallTimeAsUtc(time) - 3_600_000,
    ),
  );
  const pushId = importedId("activity", "hevy", "2026-11-03T18:30:00");

  const importHevy = async (database: Database) => {
    await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ExerciseAliasRepository), (repository) =>
        repository.remember("hevy", [
          {
            name: "Chest Supported Machine Row",
            exerciseId: libraryExerciseId("Leverage_Iso_Row"),
          },
        ]),
      ),
    );
    return transfers(database, (repository) => repository.applyImport(hevyImport(hevyFile), []));
  };

  it("links the Health copy of a workout Hevy's import saved, keeping its sets and the Health heart rate", async () => {
    const database = openTestDatabase();
    Option.getOrThrow(await importHevy(database));
    expect(await counts(database)).toEqual({ activities: 3, sets: 25 });
    const file = await health();

    const plan = await planOf(database, file);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]).toMatchObject({
      workout: { source: "apple_health", kind: "strength", startedAt: SAMPLE_STRENGTH_START },
      match: { id: pushId, title: "Push Day", source: "hevy" },
    });
    expect(sourceActivityId(plan.duplicates[0]!.workout)).not.toBe(pushId);

    expect(Option.getOrThrow(await importAll(database, file))).toMatchObject({
      added: 3,
      linked: 1,
    });
    expect(await counts(database)).toEqual({ activities: 6, sets: 25 });
    const push = Option.getOrThrow(
      await activities(database, (repository) => repository.get(pushId as never)),
    );
    expect(push.activity).toMatchObject({ title: "Push Day", source: "hevy" });
    expect(push.exercises.flatMap((exercise) => exercise.sets)).toHaveLength(8);
    expect(await heartOf(database, pushId)).toEqual({ averageBpm: 112, maxBpm: 124 });

    // Importing the Hevy file again finds nothing new and leaves the link and heart rate.
    const again = await transfers(database, (repository) =>
      repository.previewImport(hevyImport(hevyFile)),
    );
    expect(isNothingToImport(again)).toBe(true);
    expect(await importHevy(database)).toEqual(Option.none());
    expect(liveRows(database, "activity_source")).toBe(1);
    expect(await heartOf(database, pushId)).toEqual({ averageBpm: 112, maxBpm: 124 });
  });

  it("holds Hevy's copy of a workout Health already brought back as a possible duplicate", async () => {
    const database = openTestDatabase();
    Option.getOrThrow(await importAll(database, await health()));

    const plan = await transfers(database, (repository) =>
      repository.previewImport(hevyImport(hevyFile)),
    );
    expect(plan.duplicates).toEqual([
      expect.objectContaining({
        key: "hevy/2026-11-03T18:30:00",
        reason: "overlap",
        summary: expect.objectContaining({ title: "Push Day" }),
        other: expect.objectContaining({ at: SAMPLE_STRENGTH_START }),
      }),
    ]);
  });
});
