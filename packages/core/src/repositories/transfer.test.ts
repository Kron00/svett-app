import { Effect, Layer, ManagedRuntime, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { databaseLayer } from "../database.ts";
import { DurationSeconds } from "../duration.ts";
import { exerciseLibrary, libraryExerciseId } from "../exercise-library.ts";
import { buildFixture } from "../fixture.ts";
import { contentFingerprint, Ids } from "../ids.ts";
import { manualClock } from "../manual-clock.ts";
import { openNodeDatabase } from "../node-sqlite.ts";
import {
  ConversationId,
  EpochMillis,
  type ExerciseId,
  Fingerprint,
  type ImportBatchId,
  SourceIdentity,
} from "../schema.ts";
import { MIGRATIONS, migrate } from "../migrations.ts";
import { Sql } from "../sql.ts";
import { decodeSvettFile, type SvettFile } from "../svett-file.ts";
import { TABLES } from "../table.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { type ActivityDraft, ActivityRepository } from "./activities.ts";
import { ExerciseRepository } from "./exercises.ts";
import { MADE_HERE, type Origin } from "./origin.ts";
import {
  CoachMessageRepository,
  ImportRepository,
  MeasurementRepository,
  ProposalRepository,
} from "./records.ts";
import { RoutineRepository } from "./routines.ts";
import { TransferRepository } from "./transfer.ts";

type Database = Pick<ReturnType<typeof openTestDatabase>, "database" | "runtime">;

const workout = (
  title: string,
  exerciseId: ExerciseId = libraryExerciseId("Barbell_Squat"),
  origin: Origin = MADE_HERE,
): ActivityDraft => ({
  kind: "strength",
  startedAt: EpochMillis.make(T0 - 86_400_000),
  durationS: DurationSeconds.make(3_000),
  title,
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: ["weight"],
  origin,
  exercises: [
    {
      exerciseId,
      supersetGroup: null,
      notes: "",
      sets: [
        { setType: "warm_up", weightKg: 60, reps: 8, durationS: null, distanceM: null, rpe: null },
        { setType: "normal", weightKg: 100, reps: 5, durationS: null, distanceM: null, rpe: 8.5 },
      ],
    },
  ],
  track: null,
});

const run = <A, E>(database: Database, effect: Effect.Effect<A, E, TransferRepository>) =>
  database.runtime.runPromise(effect);

const transfer = <A, E>(
  database: Database,
  body: (repository: typeof TransferRepository.Service) => Effect.Effect<A, E>,
) => run(database, Effect.flatMap(Effect.service(TransferRepository), body));

const exportFile = async (database: Database): Promise<SvettFile> => {
  const { text } = await transfer(database, (repository) => repository.exportFile);
  return Result.getOrThrow(decodeSvettFile(text));
};

/** Every row of every table, deleted or not, straight from SQLite. */
const allRows = (database: Database) =>
  Object.fromEntries(
    Object.values(TABLES).map(({ name }) => [
      name,
      database.database.prepare(`SELECT * FROM ${name} ORDER BY id`).all(),
    ]),
  );

/** The live rows of every table, leaving out the batch an import made and its changes. */
const liveRows = (database: Database, without?: ImportBatchId) =>
  Object.fromEntries(
    Object.values(TABLES).map(({ name }) => [
      name,
      database.database
        .prepare(`SELECT * FROM ${name} WHERE deleted_at IS NULL ORDER BY id`)
        .all()
        .filter(
          (row) =>
            without === undefined || (row["id"] !== without && row["import_batch_id"] !== without),
        ),
    ]),
  );

/** Every row of every table, deleted or not, leaving out the batch an import made. */
const everyRow = (database: Database, without: ImportBatchId) =>
  Object.fromEntries(
    Object.entries(allRows(database)).map(([name, rows]) => [
      name,
      rows.filter((row) => row["id"] !== without && row["import_batch_id"] !== without),
    ]),
  );

const liveTitles = (database: Database) =>
  database.database
    .prepare("SELECT title FROM activity WHERE deleted_at IS NULL ORDER BY title")
    .all()
    .map((row) => row["title"]);

/** Puts at least one row in every table, the way the app makes them. */
const fillEveryTable = async (database: Database) => {
  const source = openTestDatabase(9);
  await source.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.create(workout("From another phone")),
    ),
  );
  const fromOtherPhone = await exportFile(source);

  await database.runtime.runPromise(
    Effect.gen(function* () {
      const activities = yield* ActivityRepository;
      const exercises = yield* ExerciseRepository;
      const routines = yield* RoutineRepository;
      const measurements = yield* MeasurementRepository;
      const coach = yield* CoachMessageRepository;
      const proposals = yield* ProposalRepository;
      const imports = yield* ImportRepository;
      const transfers = yield* TransferRepository;

      const sled = yield* exercises.create({
        name: "Sled push",
        category: "strongman",
        equipment: "other",
        primaryMuscles: ["quadriceps"],
        secondaryMuscles: ["glutes", "calves"],
        origin: MADE_HERE,
      });
      yield* activities.create(workout("Legs", sled));
      yield* activities.create({
        ...workout("Easy run"),
        kind: "run",
        exercises: [],
        track: {
          distanceM: 5_000,
          elevationGainM: 20,
          hideStartM: 200,
          hideEndM: 200,
          samples: [
            {
              kind: "location",
              recordedAt: EpochMillis.make(T0 - 86_000_000),
              latitude: 59.33,
              longitude: 18.06,
              altitudeM: 12,
            },
            { kind: "heart_rate", recordedAt: EpochMillis.make(T0 - 86_000_000), bpm: 142 },
            {
              kind: "split",
              recordedAt: EpochMillis.make(T0 - 85_700_000),
              distanceM: 1_000,
              durationS: DurationSeconds.make(330),
            },
          ],
        },
      });
      const folderId = yield* routines.createFolder({ name: "Push pull legs", position: 0 });
      yield* routines.createRoutine({
        folderId,
        title: "Push",
        notes: "Heavy week",
        position: 0,
        exercises: [
          {
            exerciseId: libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip"),
            supersetGroup: null,
            restS: DurationSeconds.make(120),
            notes: "",
            sets: [
              {
                setType: "normal",
                weightKg: 80,
                repsMin: 6,
                repsMax: 8,
                durationS: null,
                distanceM: null,
              },
            ],
          },
        ],
      });
      yield* measurements.create({
        kind: "body_weight",
        measuredAt: EpochMillis.make(T0 - 3_600_000),
        value: 81.4,
        origin: MADE_HERE,
      });
      const messageId = yield* coach.append({
        conversationId: ConversationId.make("01900000-0000-7000-8000-000000000001"),
        role: "user",
        content: "Plan my week",
      });
      yield* proposals.create({
        origin: "coach",
        kind: "routine",
        title: "Leg day",
        payload: { exercises: ["squat", "lunge"] },
        coachMessageId: messageId,
      });
      const hevy = yield* imports.create("hevy");
      yield* imports.setStatus(hevy, "applied");
      yield* activities.create(
        workout("Hevy legs", libraryExerciseId("Barbell_Squat"), {
          source: "hevy",
          sourceId: SourceIdentity.make("2025-12-30T08:00:00Z"),
          fingerprint: Fingerprint.make(contentFingerprint({ title: "Hevy legs" })),
          importBatchId: hevy,
        }),
      );
      yield* transfers.applyImport(fromOtherPhone, []);

      const gone = yield* activities.create(workout("Deleted later"));
      yield* activities.remove(gone);
      yield* exercises.remove(libraryExerciseId("Barbell_Deadlift"));
    }),
  );
};

describe("TransferRepository", () => {
  it("exports every table, and a wiped database that imports the file equals the original row for row", async () => {
    const original = openTestDatabase(1);
    await fillEveryTable(original);
    for (const { name } of Object.values(TABLES)) {
      // A table with no rows here would pass without export or import covering it.
      expect(liveRows(original)[name]?.length, `rows in ${name}`).toBeGreaterThan(0);
    }

    const file = await exportFile(original);
    const wiped = openTestDatabase(2);
    const imported = await transfer(wiped, (repository) => repository.applyImport(file, []));
    const batch = Option.getOrThrow(imported).importBatchId;

    expect(everyRow(wiped, batch)).toEqual(allRows(original));
  });

  it("keeps deletions through export and import, even of a library exercise svett seeds", async () => {
    const original = openTestDatabase(1);
    const deadlift = libraryExerciseId("Barbell_Deadlift");
    await original.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        yield* activities.remove(yield* activities.create(workout("Gone")));
        yield* activities.create(workout("Kept"));
        yield* (yield* ExerciseRepository).remove(deadlift);
      }),
    );
    const file = await exportFile(original);
    const wiped = openTestDatabase(2);

    const plan = await transfer(wiped, (repository) => repository.previewImport(file));
    expect({ added: plan.added, deleted: plan.deleted, changed: plan.changed }).toEqual({
      added: [{ table: "activity", count: 1 }],
      deleted: 2,
      changed: [],
    });
    const imported = await transfer(wiped, (repository) => repository.applyImport(file, []));
    const batch = Option.getOrThrow(imported).importBatchId;

    expect(everyRow(wiped, batch)).toEqual(allRows(original));
    expect(liveTitles(wiped)).toEqual(["Kept"]);
    const exercise = await wiped.runtime.runPromise(
      Effect.flatMap(Effect.service(ExerciseRepository), (exercises) => exercises.get(deadlift)),
    );
    expect(exercise).toEqual(Option.none());

    // Undo puts back the library exercise as svett seeded it.
    await transfer(wiped, (repository) => repository.undoImport(batch, []));
    expect(
      wiped.database.prepare("SELECT deleted_at FROM exercise WHERE id = ?").get(deadlift),
    ).toEqual({ deleted_at: null });
  });

  it("gives an export of a database made before library rows shared one time the same rows in a new install", async () => {
    const { database, driver } = openNodeDatabase();
    const legacy = ManagedRuntime.make(Layer.merge(Sql.layer(driver), manualClock(T0).layer));
    await legacy.runPromise(migrate(MIGRATIONS.slice(0, 1)));
    // The first release seeded the library with the time of each install.
    const bundled = exerciseLibrary();
    const insert = database.prepare(
      "INSERT INTO exercise (id, updated_at, deleted_at, name, category, equipment, primary_muscles, secondary_muscles, source, source_id, fingerprint, import_batch_id) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'library', ?, NULL, NULL)",
    );
    for (const exercise of bundled) {
      insert.run(
        exercise.id,
        T0 - 1_000,
        exercise.name,
        exercise.category,
        exercise.equipment,
        JSON.stringify(exercise.primaryMuscles),
        JSON.stringify(exercise.secondaryMuscles),
        exercise.sourceId,
      );
    }
    const squat = libraryExerciseId("Barbell_Squat");
    database
      .prepare("UPDATE exercise SET name = 'Back squat', updated_at = ? WHERE id = ?")
      .run(T0 - 500, squat);
    const upgraded: Database = {
      database,
      runtime: ManagedRuntime.make(
        Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(5)), manualClock(T0).layer),
      ),
    };

    const file = await exportFile(upgraded);
    const times = new Map((file.tables.exercise ?? []).map((row) => [row.id, row.updatedAt]));
    expect(times.get(squat)).toBe(T0 - 500);
    expect(new Set([...times].filter(([id]) => id !== squat).map(([, at]) => at))).toEqual(
      new Set([0]),
    );

    // The new install's seeded copy is not yours, so the renamed exercise replaces it unasked.
    const fresh = openTestDatabase(6);
    const plan = await transfer(fresh, (repository) => repository.previewImport(file));
    expect({ added: plan.added, changed: plan.changed }).toEqual({
      added: [{ table: "exercise", count: 1 }],
      changed: [],
    });
    const imported = await transfer(fresh, (repository) => repository.applyImport(file, []));
    const batch = Option.getOrThrow(imported).importBatchId;
    expect(everyRow(fresh, batch)).toEqual(allRows(upgraded));
  });

  it("takes a file that holds only an existing set without touching its workout", async () => {
    const phone = openTestDatabase(1);
    await phone.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Legs")),
      ),
    );
    const own = await exportFile(phone);
    const set = (own.tables.activitySet ?? []).find((row) => row["reps"] === 5)!;
    const file: SvettFile = {
      ...own,
      tables: { activitySet: [{ ...set, reps: 6 }] },
      rows: 1,
    };
    const plan = await transfer(phone, (repository) => repository.previewImport(file));
    const key = plan.changed[0]!.key;
    const taken = await transfer(phone, (repository) => repository.applyImport(file, [key]));
    expect(Option.getOrThrow(taken)).toMatchObject({ added: 0, replaced: 1 });

    expect(liveTitles(phone)).toEqual(["Legs"]);
    const live = liveRows(phone);
    expect(live["activity_exercise"]).toHaveLength(1);
    expect(live["activity_set"]?.map((row) => row["reps"]).toSorted()).toEqual([6, 8]);
  });

  it("undoes a set imported without its workout", async () => {
    const other = openTestDatabase(2);
    await other.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Back")),
      ),
    );
    const theirs = await exportFile(other);
    const file: SvettFile = {
      ...theirs,
      tables: { activitySet: theirs.tables.activitySet ?? [] },
      rows: 2,
    };
    const phone = openTestDatabase(1);
    const imported = await transfer(phone, (repository) => repository.applyImport(file, []));
    const batch = Option.getOrThrow(imported).importBatchId;
    expect(liveRows(phone)["activity_set"]).toHaveLength(2);

    const preview = await transfer(phone, (repository) => repository.previewUndo(batch));
    expect(preview.changes.map(({ change, edited }) => [change.change, edited])).toEqual([
      ["added", false],
    ]);
    expect(await transfer(phone, (repository) => repository.undoImport(batch, []))).toEqual({
      removed: 1,
      restored: 0,
      left: 0,
    });
    expect(liveRows(phone)["activity_set"]).toEqual([]);
  });

  it("imports the 300-workout fixture back into an empty database unchanged", async () => {
    const { database, driver } = openNodeDatabase();
    await buildFixture(driver);
    const original: Database = {
      database,
      runtime: ManagedRuntime.make(
        Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(3)), manualClock(T0).layer),
      ),
    };
    const file = await exportFile(original);
    const wiped = openTestDatabase(4);

    const plan = await transfer(wiped, (repository) => repository.previewImport(file));
    expect(plan.added).toEqual([
      { table: "activity", count: 300 },
      { table: "folder", count: 1 },
      { table: "routine", count: 3 },
      { table: "measurement", count: 155 },
    ]);
    expect(plan.changed).toEqual([]);
    expect(plan.unchanged).toBe(876);

    const imported = await transfer(wiped, (repository) => repository.applyImport(file, []));
    const batch = Option.getOrThrow(imported).importBatchId;
    expect(liveRows(wiped, batch)).toEqual(liveRows(original));
  });

  it("adds nothing when the same file is imported twice", async () => {
    const original = openTestDatabase(1);
    await fillEveryTable(original);
    const file = await exportFile(original);
    const other = openTestDatabase(2);
    await transfer(other, (repository) => repository.applyImport(file, []));
    const before = allRows(other);

    const plan = await transfer(other, (repository) => repository.previewImport(file));
    expect({ added: plan.added, changed: plan.changed }).toEqual({ added: [], changed: [] });
    const again = await transfer(other, (repository) => repository.applyImport(file, []));
    expect(again).toEqual(Option.none());
    expect(allRows(other)).toEqual(before);
  });

  it("keeps your version of a changed workout unless you take the file's", async () => {
    const phone = openTestDatabase(1);
    const id = await phone.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Legs")),
      ),
    );
    const file = await exportFile(phone);
    await phone.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.update(id, { title: "Leg day" }),
      ),
    );

    const plan = await transfer(phone, (repository) => repository.previewImport(file));
    expect(plan.changed).toEqual([
      {
        key: `activity/${id}`,
        table: "activity",
        id,
        title: "Legs",
        at: EpochMillis.make(T0 - 86_400_000),
      },
    ]);
    expect(await transfer(phone, (repository) => repository.applyImport(file, []))).toEqual(
      Option.none(),
    );
    expect(liveTitles(phone)).toEqual(["Leg day"]);

    const taken = await transfer(phone, (repository) =>
      repository.applyImport(file, [`activity/${id}`]),
    );
    expect(Option.getOrThrow(taken)).toMatchObject({ added: 0, replaced: 1 });
    expect(liveTitles(phone)).toEqual(["Legs"]);
  });

  it("undoes an import: removes what it added and puts back the version it replaced", async () => {
    const phone = openTestDatabase(1);
    const repository = await phone.runtime.runPromise(Effect.service(ActivityRepository));
    const kept = await phone.runtime.runPromise(repository.create(workout("Legs")));
    const other = openTestDatabase(2);
    await other.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Back")),
      ),
    );
    const otherFile = await exportFile(other);
    const ownFile = await exportFile(phone);
    // The file's copy of Legs gains a set the phone does not have, and lacks one the phone
    // has. Taking it adds the new set and leaves the one the file lacks.
    const legs = ownFile.tables.activitySet ?? [];
    const file: SvettFile = {
      ...ownFile,
      tables: {
        ...ownFile.tables,
        activity: [...(ownFile.tables.activity ?? []), ...(otherFile.tables.activity ?? [])],
        activityExercise: [
          ...(ownFile.tables.activityExercise ?? []),
          ...(otherFile.tables.activityExercise ?? []),
        ],
        activitySet: [
          ...legs.slice(1),
          { ...legs[1]!, id: "01900000-0000-7000-8000-0000000000aa", position: 2 },
          ...(otherFile.tables.activitySet ?? []),
        ],
      },
    };
    const before = liveRows(phone);

    const imported = await transfer(phone, (transfers) =>
      transfers.applyImport(file, [`activity/${kept}`]),
    );
    const { importBatchId, added, replaced } = Option.getOrThrow(imported);
    expect({ added, replaced }).toEqual({ added: 1, replaced: 1 });
    expect(liveTitles(phone)).toEqual(["Back", "Legs"]);

    const preview = await transfer(phone, (transfers) => transfers.previewUndo(importBatchId));
    expect(
      preview.changes.map(({ change, edited }) => [change.title, change.change, edited]),
    ).toEqual([
      ["Back", "added", false],
      ["Legs", "replaced", false],
    ]);
    const undone = await transfer(phone, (transfers) => transfers.undoImport(importBatchId, []));
    expect(undone).toEqual({ removed: 1, restored: 1, left: 0 });

    // Undo writes the restored rows anew, so only their times differ from before.
    const withoutTimes = (rows: ReturnType<typeof liveRows>) =>
      Object.fromEntries(
        Object.entries(rows).map(([name, list]) => [
          name,
          (list ?? []).map((row) => Object.assign(row, { updated_at: null })),
        ]),
      );
    expect(withoutTimes(liveRows(phone, importBatchId))).toEqual(withoutTimes(before));
    expect(liveRows(phone)["import_batch"]).toMatchObject([{ status: "undone" }]);
  });

  it("leaves a workout edited after the import unless you choose to undo it too", async () => {
    const other = openTestDatabase(2);
    await other.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        Effect.all([activities.create(workout("Back")), activities.create(workout("Chest"))]),
      ),
    );
    const file = await exportFile(other);

    const leave = openTestDatabase(1);
    const edit = async (database: Database) => {
      const imported = await transfer(database, (transfers) => transfers.applyImport(file, []));
      const batch = Option.getOrThrow(imported).importBatchId;
      const chest = (file.tables.activity ?? []).find((row) => row["title"] === "Chest");
      await database.runtime.runPromise(
        Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
          activities.update(chest!.id as never, { notes: "Felt strong" }),
        ),
      );
      return batch;
    };

    const leftBatch = await edit(leave);
    const preview = await transfer(leave, (transfers) => transfers.previewUndo(leftBatch));
    expect(preview.changes.map(({ change, edited }) => [change.title, edited])).toEqual([
      ["Back", false],
      ["Chest", true],
    ]);
    expect(await transfer(leave, (transfers) => transfers.undoImport(leftBatch, []))).toEqual({
      removed: 1,
      restored: 0,
      left: 1,
    });
    expect(liveTitles(leave)).toEqual(["Chest"]);

    const both = openTestDatabase(1);
    const bothBatch = await edit(both);
    const edited = (await transfer(both, (transfers) => transfers.previewUndo(bothBatch))).changes
      .filter((change) => change.edited)
      .map(({ change }) => change.id);
    await transfer(both, (transfers) => transfers.undoImport(bothBatch, edited));
    expect(liveTitles(both)).toEqual([]);
  });

  it("refuses to undo an import twice", async () => {
    const other = openTestDatabase(2);
    await other.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Back")),
      ),
    );
    const file = await exportFile(other);
    const phone = openTestDatabase(1);
    const imported = await transfer(phone, (transfers) => transfers.applyImport(file, []));
    const batch = Option.getOrThrow(imported).importBatchId;
    await transfer(phone, (transfers) => transfers.undoImport(batch, []));

    const again = await phone.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(TransferRepository), (transfers) =>
        transfers.undoImport(batch, []),
      ),
    );
    expect(again).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "ImportNotUndoableError", status: "undone" } }] },
    });
  });

  it("lists a workout an undo removed as changed, and brings it back when you take it", async () => {
    const other = openTestDatabase(2);
    await other.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Back")),
      ),
    );
    const file = await exportFile(other);
    const phone = openTestDatabase(1);
    const first = await transfer(phone, (transfers) => transfers.applyImport(file, []));
    await transfer(phone, (transfers) =>
      transfers.undoImport(Option.getOrThrow(first).importBatchId, []),
    );
    expect(liveTitles(phone)).toEqual([]);

    const plan = await transfer(phone, (transfers) => transfers.previewImport(file));
    expect(plan.changed.map((item) => item.title)).toEqual(["Back"]);
    expect(await transfer(phone, (transfers) => transfers.applyImport(file, []))).toEqual(
      Option.none(),
    );
    const second = await transfer(phone, (transfers) =>
      transfers.applyImport(file, [plan.changed[0]!.key]),
    );
    expect(Option.getOrThrow(second)).toMatchObject({ added: 0, replaced: 1 });
    expect(liveTitles(phone)).toEqual(["Back"]);
  });

  it("lists imports that changed something, newest first", async () => {
    const other = openTestDatabase(2);
    await other.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Back")),
      ),
    );
    const file = await exportFile(other);
    const phone = openTestDatabase(1);
    await transfer(phone, (transfers) => transfers.applyImport(file, []));
    await transfer(phone, (transfers) => transfers.applyImport(file, []));
    const imports = await transfer(phone, (transfers) => transfers.listImports);
    expect(imports.map((batch) => [batch.source, batch.status])).toEqual([
      ["svett_file", "applied"],
    ]);
  });
});
