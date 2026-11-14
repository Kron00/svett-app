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
import { openTestDatabase, pointersToDeleted, T0 } from "../test-database.ts";
import {
  PARENT,
  REFERENCES,
  TABLE_KEYS,
  type TableRows,
  undoSelection,
  writtenOf,
} from "../transfer.ts";
import { type ActivityDraft, ActivityRepository } from "./activities.ts";
import { ExerciseAliasRepository, ExerciseRepository } from "./exercises.ts";
import { GearRepository } from "./gear.ts";
import { MADE_HERE, type Origin } from "./origin.ts";
import {
  CoachMessageRepository,
  ImportRepository,
  MeasurementRepository,
  ProposalRepository,
} from "./records.ts";
import { RoutineRepository } from "./routines.ts";
import { TransferRepository } from "./transfer.ts";
import { EMPTY_TARGET } from "../routine-plan.ts";
import { startWorkoutFromRoutine } from "../start-workout.ts";

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

/** The live workouts' notes and their sets' reps. */
const workoutNow = (database: Database) => {
  const reps = liveRows(database)["activity_set"]?.map((row) => row["reps"]);
  return {
    notes: database.database
      .prepare("SELECT notes FROM activity WHERE deleted_at IS NULL")
      .all()
      .map((row) => row["notes"]),
    reps: reps?.toSorted(),
  };
};

const liveExercise = (database: Database, name: string) =>
  database.database
    .prepare("SELECT deleted_at FROM exercise WHERE name = ?")
    .all(name)
    .map((row) => row["deleted_at"]);

/** A file from another phone with a custom exercise and a workout that uses it. */
const pushDayFile = async () => {
  const other = openTestDatabase(2);
  await other.runtime.runPromise(
    Effect.gen(function* () {
      const landmine = yield* (yield* ExerciseRepository).create({
        name: "Landmine press",
        category: "strength",
        equipment: "barbell",
        primaryMuscles: ["shoulders"],
        secondaryMuscles: ["triceps"],
        origin: MADE_HERE,
      });
      yield* (yield* ActivityRepository).create(workout("Push Day", landmine));
    }),
  );
  const file = await exportFile(other);
  const landmine = (file.tables.exercise ?? []).find((row) => row["name"] === "Landmine press")!;
  const pushDay = (file.tables.activity ?? []).find((row) => row["title"] === "Push Day")!;
  return { file, landmine: landmine.id as ExerciseId, pushDay: pushDay.id };
};

const editNotes = (database: Database, id: string) =>
  database.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.update(id as never, { notes: "Felt strong" }),
    ),
  );

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
      yield* (yield* ExerciseAliasRepository).remember("hevy", [
        { name: "Sled Push (Heavy)", exerciseId: sled },
      ]);
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
      yield* (yield* GearRepository).save("kg", {
        plates: [{ weight: 20, pairs: 3 }],
        bars: [{ name: "Safety squat bar", weight: 30 }],
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

/** Starts a workout from a new one-exercise routine, as the Train tab does. */
const startRoutine = (database: Database) =>
  database.runtime.runPromise(
    Effect.gen(function* () {
      const routineId = yield* (yield* RoutineRepository).createRoutine({
        folderId: null,
        title: "Push",
        notes: "",
        position: 0,
        exercises: [
          {
            exerciseId: libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip"),
            supersetGroup: null,
            restS: null,
            notes: "",
            sets: [
              { ...EMPTY_TARGET, weightKg: 80, repsMin: 5, repsMax: 5 },
              { ...EMPTY_TARGET, weightKg: 80, repsMin: 5, repsMax: 8 },
            ],
          },
        ],
      });
      return yield* startWorkoutFromRoutine(routineId);
    }),
  );

const workoutInProgress = (database: Database) =>
  database.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.inProgress),
  );

const logged = (database: Database, title: string) =>
  database.runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.create(workout(title)),
    ),
  );

/** The file with every workout in it changed, as a file edited by hand. */
const withWorkouts = (file: SvettFile, fields: Record<string, unknown>): SvettFile => ({
  ...file,
  tables: {
    ...file.tables,
    activity: (file.tables.activity ?? []).map((row) => Object.assign(row, fields)),
  },
});

describe("TransferRepository and a workout in progress", () => {
  it("leaves a workout in progress out of an export taken during it", async () => {
    const phone = openTestDatabase(1);
    await logged(phone, "Legs");
    const draft = await startRoutine(phone);

    const file = await exportFile(phone);
    expect((file.tables.activity ?? []).map((row) => row["title"])).toEqual(["Legs"]);
    expect((file.tables.activityExercise ?? []).map((row) => row["activityId"])).not.toContain(
      draft,
    );
    expect(file.tables.activitySet).toHaveLength(2);
    expect(file.tables.routine).toHaveLength(1);

    const wiped = openTestDatabase(2);
    await transfer(wiped, (repository) => repository.applyImport(file, []));
    expect(await workoutInProgress(wiped)).toEqual(Option.none());
    expect(pointersToDeleted(wiped)).toEqual([]);
  });

  it("skips a workout in progress in a file, counts it, and never puts a workout here in progress", async () => {
    const other = openTestDatabase(2);
    await logged(other, "Back");
    const backInProgress = withWorkouts(await exportFile(other), { status: "in_progress" });
    const phone = openTestDatabase(1);
    const legs = await logged(phone, "Legs");
    const legsInProgress = withWorkouts(await exportFile(phone), { status: "in_progress" });
    const before = allRows(phone);

    expect(
      await transfer(phone, (repository) => repository.previewImport(backInProgress)),
    ).toMatchObject({ added: [], changed: [], deleted: 0, skipped: 1 });
    expect(
      await transfer(phone, (repository) => repository.applyImport(backInProgress, [])),
    ).toEqual(Option.none());
    expect(
      await transfer(phone, (repository) => repository.previewImport(legsInProgress)),
    ).toMatchObject({ added: [], changed: [], skipped: 1 });
    expect(
      await transfer(phone, (repository) =>
        repository.applyImport(legsInProgress, [`activity/${legs}`]),
      ),
    ).toEqual(Option.none());
    expect(allRows(phone)).toEqual(before);
    expect(await workoutInProgress(phone)).toEqual(Option.none());
  });

  it("keeps a workout discarded when Undo would put it back in progress beside another", async () => {
    const phone = openTestDatabase(1);
    const legs = await logged(phone, "Legs");
    const renamed = withWorkouts(await exportFile(phone), { title: "Leg day" });
    const { importBatchId } = Option.getOrThrow(
      await transfer(phone, (repository) => repository.applyImport(renamed, [`activity/${legs}`])),
    );
    // A journal that holds a workout in progress, as one from a hand-edited file can.
    phone.database
      .prepare(
        "UPDATE import_change SET replaced = json_set(replaced, '$.activity[0].status', 'in_progress') WHERE import_batch_id = ?",
      )
      .run(importBatchId);
    const draft = await startRoutine(phone);

    const undone = await transfer(phone, (repository) => repository.undoImport(importBatchId, []));
    expect(undone).toEqual({ removed: 0, restored: 1, left: 0, kept: 0, discarded: 1 });
    expect(Option.getOrThrow(await workoutInProgress(phone)).activity.id).toBe(draft);
    expect(
      phone.database
        .prepare("SELECT title, status, deleted_at IS NOT NULL AS gone FROM activity WHERE id = ?")
        .all(legs),
    ).toEqual([{ title: "Legs", status: "in_progress", gone: 1 }]);
    expect(pointersToDeleted(phone)).toEqual([]);
  });

  it("undoes an import whose journal was written before workouts had a status", async () => {
    const phone = openTestDatabase(1);
    const legs = await logged(phone, "Legs");
    const renamed = withWorkouts(await exportFile(phone), { title: "Leg day" });
    const { importBatchId } = Option.getOrThrow(
      await transfer(phone, (repository) => repository.applyImport(renamed, [`activity/${legs}`])),
    );
    phone.database
      .prepare(
        "UPDATE import_change SET replaced = json_remove(replaced, '$.activity[0].status', '$.activity[0].routineId') WHERE import_batch_id = ?",
      )
      .run(importBatchId);

    const preview = await transfer(phone, (repository) => repository.previewUndo(importBatchId));
    expect(preview.changes.map(({ edited }) => edited)).toEqual([false]);
    expect(await transfer(phone, (repository) => repository.undoImport(importBatchId, []))).toEqual(
      { removed: 0, restored: 1, left: 0, kept: 0, discarded: 0 },
    );
    expect(
      phone.database.prepare("SELECT title, status FROM activity WHERE deleted_at IS NULL").all(),
    ).toEqual([{ title: "Legs", status: "finished" }]);
  });
});

const timedSet = {
  setType: "normal",
  weightKg: null,
  reps: null,
  distanceM: null,
  rpe: null,
} as const;

/** The row as svett wrote it before set fields. */
const withoutSetFieldsKey = <A extends Readonly<Record<string, unknown>>>(row: A): A =>
  Object.fromEntries(Object.entries(row).filter(([field]) => field !== "setFields")) as A;

/** A workout with a lift logged by weight and reps and a plank logged by time. */
const liftAndPlank = (title: string): ActivityDraft => ({
  ...workout(title),
  exercises: [
    ...workout(title).exercises,
    {
      exerciseId: libraryExerciseId("Plank"),
      supersetGroup: null,
      notes: "",
      sets: [
        { ...timedSet, durationS: DurationSeconds.make(60) },
        { ...timedSet, durationS: DurationSeconds.make(45) },
      ],
    },
  ],
});

/** The file as svett wrote it before exercises had set fields. */
const withoutSetFields = (file: SvettFile): string =>
  JSON.stringify({
    format: "svett",
    version: 2,
    exportedAt: file.exportedAt,
    tables: Object.fromEntries(
      TABLE_KEYS.map((key) => [
        TABLES[key].name,
        (file.tables[key] ?? []).map(withoutSetFieldsKey),
      ]),
    ),
  });

describe("TransferRepository and rows made before set fields", () => {
  it("imports a version 2 file into a new install with the set fields migration 5 gave the rows", async () => {
    const original = openTestDatabase(1);
    await logged(original, "Legs");
    await original.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(liftAndPlank("Core")),
      ),
    );
    const old = decodeSvettFile(withoutSetFields(await exportFile(original)));
    if (Result.isFailure(old)) throw new Error(old.failure.message);

    const fresh = openTestDatabase(2);
    const imported = await transfer(fresh, (repository) => repository.applyImport(old.success, []));
    const batch = Option.getOrThrow(imported).importBatchId;
    expect(everyRow(fresh, batch)).toEqual(allRows(original));
    expect(
      fresh.database.prepare("SELECT set_fields FROM activity_exercise ORDER BY position").all(),
    ).toEqual([
      { set_fields: "weight_reps" },
      { set_fields: "weight_reps" },
      { set_fields: "time" },
    ]);
  });

  it("undoes an import whose journal was written before exercises had set fields", async () => {
    const phone = openTestDatabase(1);
    const core = await phone.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(liftAndPlank("Core")),
      ),
    );
    const file = await exportFile(phone);
    const changed: SvettFile = {
      ...file,
      tables: {
        ...file.tables,
        activity: (file.tables.activity ?? []).map((row) =>
          Object.assign({}, row, { title: "Core day" }),
        ),
        activityExercise: (file.tables.activityExercise ?? []).map((row) =>
          Object.assign({}, row, { notes: "Hold longer" }),
        ),
      },
    };
    const { importBatchId } = Option.getOrThrow(
      await transfer(phone, (repository) => repository.applyImport(changed, [`activity/${core}`])),
    );
    // The journal as svett wrote it then: kept exercises without set fields, and the
    // fingerprint of the record's rows without them.
    const record = await exportFile(phone);
    const before: TableRows = {
      activity: record.tables.activity ?? [],
      activityExercise: (record.tables.activityExercise ?? []).map(withoutSetFieldsKey),
      activitySet: record.tables.activitySet ?? [],
    };
    phone.database
      .prepare(
        "UPDATE import_change SET written = ?, replaced = json_remove(replaced, '$.activity_exercise[0].setFields', '$.activity_exercise[1].setFields') WHERE import_batch_id = ?",
      )
      .run(writtenOf(before), importBatchId);
    expect(
      phone.database
        .prepare(
          "SELECT json_extract(replaced, '$.activity_exercise[1]') AS kept FROM import_change",
        )
        .all()
        .map((row) => JSON.parse(String(row["kept"]))),
    ).toEqual([expect.not.objectContaining({ setFields: expect.anything() })]);

    const preview = await transfer(phone, (repository) => repository.previewUndo(importBatchId));
    expect(preview.changes.map(({ edited }) => edited)).toEqual([false]);
    expect(await transfer(phone, (repository) => repository.undoImport(importBatchId, []))).toEqual(
      { removed: 0, restored: 1, left: 0, kept: 0, discarded: 0 },
    );
    expect(
      phone.database
        .prepare(
          "SELECT notes, set_fields FROM activity_exercise WHERE deleted_at IS NULL ORDER BY position",
        )
        .all(),
    ).toEqual([
      { notes: "", set_fields: "weight_reps" },
      { notes: "", set_fields: "time" },
    ]);
    expect(liveTitles(phone)).toEqual(["Core"]);
  });
});

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
      kept: 0,
      discarded: 0,
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
    expect(undone).toEqual({ removed: 1, restored: 1, left: 0, kept: 0, discarded: 0 });

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
      kept: 0,
      discarded: 0,
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

  it("lists a workout whose notes changed after an import that took one of its sets", async () => {
    const takeOneSet = async (database: Database) => {
      const id = await database.runtime.runPromise(
        Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
          activities.create(workout("Legs")),
        ),
      );
      const own = await exportFile(database);
      const sets = own.tables.activitySet ?? [];
      const heavy = sets.find((row) => row["reps"] === 5)!;
      const file: SvettFile = {
        ...own,
        tables: {
          ...own.tables,
          activitySet: [...sets.filter((row) => row !== heavy), { ...heavy, reps: 6 }],
        },
      };
      const taken = await transfer(database, (transfers) =>
        transfers.applyImport(file, [`activity/${id}`]),
      );
      await database.runtime.runPromise(
        Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
          activities.update(id, { notes: "Felt strong" }),
        ),
      );
      return Option.getOrThrow(taken).importBatchId;
    };
    const leave = openTestDatabase(1);
    const leftBatch = await takeOneSet(leave);
    const preview = await transfer(leave, (transfers) => transfers.previewUndo(leftBatch));
    expect(
      preview.changes.map(({ change, edited }) => [change.title, change.change, edited]),
    ).toEqual([["Legs", "replaced", true]]);
    expect(await transfer(leave, (transfers) => transfers.undoImport(leftBatch, []))).toEqual({
      removed: 0,
      restored: 0,
      left: 1,
      kept: 0,
      discarded: 0,
    });
    expect(workoutNow(leave)).toEqual({ notes: ["Felt strong"], reps: [6, 8] });

    const both = openTestDatabase(1);
    const bothBatch = await takeOneSet(both);
    const edited = (await transfer(both, (transfers) => transfers.previewUndo(bothBatch))).changes
      .filter((change) => change.edited)
      .map(({ change }) => change.id);
    expect(await transfer(both, (transfers) => transfers.undoImport(bothBatch, edited))).toEqual({
      removed: 0,
      restored: 1,
      left: 0,
      kept: 0,
      discarded: 0,
    });
    expect(workoutNow(both)).toEqual({ notes: ["Felt strong"], reps: [5, 8] });
  });

  it("lists a workout whose deleted set changed after an import that took another of its sets", async () => {
    const database = openTestDatabase(1);
    const id = await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Legs")),
      ),
    );
    database.database.prepare("UPDATE activity_set SET deleted_at = 1 WHERE reps = 8").run();
    const own = await exportFile(database);
    const sets = own.tables.activitySet ?? [];
    const heavy = sets.find((row) => row["reps"] === 5)!;
    const file: SvettFile = {
      ...own,
      tables: {
        ...own.tables,
        activitySet: [...sets.filter((row) => row !== heavy), { ...heavy, reps: 6 }],
      },
    };
    const taken = await transfer(database, (transfers) =>
      transfers.applyImport(file, [`activity/${id}`]),
    );
    const batch = Option.getOrThrow(taken).importBatchId;
    // A change to a deleted row, as sync can deliver, is an edit the live rows do not show.
    database.database
      .prepare("UPDATE activity_set SET reps = 9, updated_at = updated_at + 1 WHERE reps = 8")
      .run();
    const preview = await transfer(database, (transfers) => transfers.previewUndo(batch));
    expect(preview.changes.map(({ edited }) => edited)).toEqual([true]);
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

  it("keeps an imported exercise that a workout logged after the import uses", async () => {
    const { file, landmine } = await pushDayFile();
    const phone = openTestDatabase(1);
    const imported = await transfer(phone, (transfers) => transfers.applyImport(file, []));
    const batch = Option.getOrThrow(imported).importBatchId;
    await phone.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(workout("Later push", landmine)),
      ),
    );

    const preview = await transfer(phone, (transfers) => transfers.previewUndo(batch));
    expect(undoSelection(preview.changes, [])).toMatchObject({ removing: 1, keeping: 1 });
    expect(await transfer(phone, (transfers) => transfers.undoImport(batch, []))).toEqual({
      removed: 1,
      restored: 0,
      left: 0,
      kept: 1,
      discarded: 0,
    });
    expect(liveTitles(phone)).toEqual(["Later push"]);
    expect(liveExercise(phone, "Landmine press")).toEqual([null]);
    expect(pointersToDeleted(phone)).toEqual([]);
  });

  it("keeps an imported exercise that a workout Undo leaves still uses, unless you undo it too", async () => {
    const { file, pushDay } = await pushDayFile();
    const importAndEdit = async (database: Database) => {
      const imported = await transfer(database, (transfers) => transfers.applyImport(file, []));
      await editNotes(database, pushDay);
      return Option.getOrThrow(imported).importBatchId;
    };

    const leave = openTestDatabase(1);
    const leftBatch = await importAndEdit(leave);
    expect(await transfer(leave, (transfers) => transfers.undoImport(leftBatch, []))).toEqual({
      removed: 0,
      restored: 0,
      left: 1,
      kept: 1,
      discarded: 0,
    });
    expect(liveTitles(leave)).toEqual(["Push Day"]);
    expect(liveExercise(leave, "Landmine press")).toEqual([null]);
    expect(pointersToDeleted(leave)).toEqual([]);

    const both = openTestDatabase(1);
    const bothBatch = await importAndEdit(both);
    const preview = await transfer(both, (transfers) => transfers.previewUndo(bothBatch));
    const edited = preview.changes.filter((entry) => entry.edited).map(({ change }) => change.id);
    expect(undoSelection(preview.changes, edited)).toMatchObject({ removing: 2, keeping: 0 });
    expect(await transfer(both, (transfers) => transfers.undoImport(bothBatch, edited))).toEqual({
      removed: 2,
      restored: 0,
      left: 0,
      kept: 0,
      discarded: 0,
    });
    expect(liveTitles(both)).toEqual([]);
    expect(liveExercise(both, "Landmine press")).toHaveLength(1);
    expect(liveExercise(both, "Landmine press")).not.toEqual([null]);
    expect(pointersToDeleted(both)).toEqual([]);
  });

  it("keeps a re-imported exercise deleted by an earlier Undo when a workout it leaves uses it", async () => {
    const { file, pushDay } = await pushDayFile();
    const phone = openTestDatabase(1);
    const first = await transfer(phone, (transfers) => transfers.applyImport(file, []));
    await transfer(phone, (transfers) =>
      transfers.undoImport(Option.getOrThrow(first).importBatchId, []),
    );
    const plan = await transfer(phone, (transfers) => transfers.previewImport(file));
    // The exercise comes back with the workout that uses it, so it is not listed on its own.
    expect(plan.changed.map((item) => item.title)).toEqual(["Push Day"]);
    const second = await transfer(phone, (transfers) =>
      transfers.applyImport(
        file,
        plan.changed.map((item) => item.key),
      ),
    );
    const batch = Option.getOrThrow(second).importBatchId;
    await editNotes(phone, pushDay);

    expect(await transfer(phone, (transfers) => transfers.undoImport(batch, []))).toEqual({
      removed: 0,
      restored: 0,
      left: 1,
      kept: 1,
      discarded: 0,
    });
    expect(liveTitles(phone)).toEqual(["Push Day"]);
    expect(liveRows(phone)["activity_set"]).toHaveLength(2);
    expect(liveExercise(phone, "Landmine press")).toEqual([null]);
    expect(pointersToDeleted(phone)).toEqual([]);
  });

  it("brings back the import a restored exercise came from when one workout is taken again", async () => {
    const other = openTestDatabase(2);
    await other.runtime.runPromise(
      Effect.gen(function* () {
        const imports = yield* ImportRepository;
        const hevy = yield* imports.create("hevy");
        yield* imports.setStatus(hevy, "applied");
        const landmine = yield* (yield* ExerciseRepository).create({
          name: "Landmine press",
          category: "strength",
          equipment: "barbell",
          primaryMuscles: ["shoulders"],
          secondaryMuscles: ["triceps"],
          origin: {
            source: "hevy",
            sourceId: SourceIdentity.make("Landmine Press"),
            fingerprint: Fingerprint.make(contentFingerprint({ name: "Landmine Press" })),
            importBatchId: hevy,
          },
        });
        const activities = yield* ActivityRepository;
        yield* activities.create(workout("Push Day", landmine));
        yield* activities.create(workout("Pull Day"));
      }),
    );
    const file = await exportFile(other);
    const phone = openTestDatabase(1);
    const first = await transfer(phone, (transfers) => transfers.applyImport(file, []));
    await transfer(phone, (transfers) =>
      transfers.undoImport(Option.getOrThrow(first).importBatchId, []),
    );

    const plan = await transfer(phone, (transfers) => transfers.previewImport(file));
    const push = plan.changed.find((item) => item.title === "Push Day")!;
    await transfer(phone, (transfers) => transfers.applyImport(file, [push.key]));
    expect(liveTitles(phone)).toEqual(["Push Day"]);
    expect(liveExercise(phone, "Landmine press")).toEqual([null]);
    expect(pointersToDeleted(phone)).toEqual([]);
  });

  it("keeps an imported folder that a routine made after the import is in", async () => {
    const other = openTestDatabase(2);
    await other.runtime.runPromise(
      Effect.flatMap(Effect.service(RoutineRepository), (routines) =>
        routines.createFolder({ name: "Strength block", position: 0 }),
      ),
    );
    const file = await exportFile(other);
    const folderId = (file.tables.folder ?? [])[0]!.id;
    const phone = openTestDatabase(1);
    const imported = await transfer(phone, (transfers) => transfers.applyImport(file, []));
    await phone.runtime.runPromise(
      Effect.flatMap(Effect.service(RoutineRepository), (routines) =>
        routines.createRoutine({
          folderId: folderId as never,
          title: "Heavy",
          notes: "",
          position: 0,
          exercises: [],
        }),
      ),
    );

    expect(
      await transfer(phone, (transfers) =>
        transfers.undoImport(Option.getOrThrow(imported).importBatchId, []),
      ),
    ).toEqual({ removed: 0, restored: 0, left: 0, kept: 1, discarded: 0 });
    expect(liveRows(phone)["folder"]).toHaveLength(1);
    expect(pointersToDeleted(phone)).toEqual([]);
  });

  it("lists every key that points at another table as a parent or a reference", () => {
    const listed = new Set([
      ...REFERENCES.map(({ table, key }) => `${table}.${key}`),
      ...TABLE_KEYS.flatMap((table) => {
        const parent = PARENT[table];
        return parent === null ? [] : [`${table}.${parent.key}`];
      }),
    ]);
    // A source's own ID and a conversation are not rows of any table. An import change names
    // its record by table and ID, as a journal that outlives the record.
    const notRows = new Set(["sourceId", "conversationId", "itemId"]);
    const pointers = TABLE_KEYS.flatMap((table) =>
      TABLES[table].keys
        .filter((key) => key.endsWith("Id") && !notRows.has(key))
        .map((key) => `${table}.${key}`),
    );
    expect(pointers.filter((pointer) => !listed.has(pointer))).toEqual([]);
  });
});
