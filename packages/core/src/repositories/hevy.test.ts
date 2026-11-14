import { readFileSync } from "node:fs";

import { Effect, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { libraryExerciseId } from "../exercise-library.ts";
import { DurationSeconds } from "../duration.ts";
import { decodeHevyFile, type HevyFile, type ToInstant, wallTimeAsUtc } from "../hevy-file.ts";
import { hevyExerciseId, hevyImport } from "../hevy-import.ts";
import { importedId } from "../ids.ts";
import { ActivityId, EpochMillis, ExerciseId, type ImportBatchId } from "../schema.ts";
import { addExercisesToWorkout, loadWorkoutLog, startEmptyWorkout } from "../start-workout.ts";
import { openTestDatabase, pointersToDeleted, T0 } from "../test-database.ts";
import { decodeSvettFile } from "../svett-file.ts";
import { type ImportInput, isNothingToImport } from "../transfer.ts";
import { ActivityRepository } from "./activities.ts";
import { ExerciseAliasRepository } from "./exercises.ts";
import { MADE_HERE } from "./origin.ts";
import { TransferRepository } from "./transfer.ts";

type Database = ReturnType<typeof openTestDatabase>;

const sampleText = (name: string) =>
  readFileSync(new URL(`../../test-data/${name}`, import.meta.url), "utf8");

const hevy = (text: string, toInstant: ToInstant = wallTimeAsUtc): HevyFile =>
  Result.getOrThrow(decodeHevyFile(text, toInstant));

const SAMPLE = hevy(sampleText("hevy-sample.csv"));
const CHANGED = hevy(sampleText("hevy-sample-changed.csv"));

const HEADER =
  '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';

const transfers = <A, E>(
  database: Database,
  body: (repository: typeof TransferRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(TransferRepository), body));

const aliases = <A, E>(
  database: Database,
  body: (repository: typeof ExerciseAliasRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(ExerciseAliasRepository), body));

const preview = (database: Database, file: HevyFile, keep?: ReadonlySet<string>) =>
  transfers(database, (repository) => repository.previewImport(hevyImport(file, keep)));

const apply = async (
  database: Database,
  file: HevyFile,
  take: ReadonlyArray<string> = [],
  keep?: ReadonlySet<string>,
) =>
  Option.getOrUndefined(
    await transfers(database, (repository) => repository.applyImport(hevyImport(file, keep), take)),
  );

const workoutsHere = <A, E>(
  database: Database,
  body: (repository: typeof ActivityRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(ActivityRepository), body));

const undo = (database: Database, batch: ImportBatchId) =>
  transfers(database, (repository) => repository.undoImport(batch, []));

const query = (database: Database, sql: string, ...params: Array<string | number>) =>
  database.database.prepare(sql).all(...params);

const count = (database: Database, table: string) =>
  Number(query(database, `SELECT count(*) AS n FROM ${table} WHERE deleted_at IS NULL`)[0]?.["n"]);

/** The live workouts with their exercises and sets, as a person reading them would see them. */
const workouts = (database: Database) =>
  query(
    database,
    "SELECT id, title, notes, started_at, duration_s, audience FROM activity WHERE deleted_at IS NULL ORDER BY started_at",
  ).map((activity) => ({
    title: activity["title"],
    notes: activity["notes"],
    startedAt: activity["started_at"],
    durationS: activity["duration_s"],
    audience: activity["audience"],
    exercises: query(
      database,
      "SELECT ae.id, e.name, ae.superset_group, ae.notes FROM activity_exercise ae JOIN exercise e ON e.id = ae.exercise_id WHERE ae.activity_id = ? AND ae.deleted_at IS NULL ORDER BY ae.position",
      String(activity["id"]),
    ).map((exercise) => ({
      name: exercise["name"],
      supersetGroup: exercise["superset_group"],
      notes: exercise["notes"],
      sets: query(
        database,
        "SELECT set_type, weight_kg, reps, duration_s, distance_m, rpe FROM activity_set WHERE activity_exercise_id = ? AND deleted_at IS NULL ORDER BY position",
        String(exercise["id"]),
      ).map((set) => Object.values(set).join(" ")),
    })),
  }));

/** Live sets whose exercise is deleted or missing, which no screen could show. */
const setsWithoutExercise = (database: Database) =>
  query(
    database,
    "SELECT s.id FROM activity_set s JOIN activity_exercise ae ON ae.id = s.activity_exercise_id JOIN activity a ON a.id = ae.activity_id LEFT JOIN exercise e ON e.id = ae.exercise_id AND e.deleted_at IS NULL WHERE s.deleted_at IS NULL AND ae.deleted_at IS NULL AND a.deleted_at IS NULL AND e.id IS NULL",
  );

/** The sample's Legs workout alone. */
const LEGS = sampleText("hevy-sample.csv")
  .split("\n")
  .filter((line, index) => index === 0 || line.startsWith('"Legs"'))
  .join("\n");

const pushId = ActivityId.make(importedId("activity", "hevy", "2026-11-03T18:30:00"));
const pullId = ActivityId.make(importedId("activity", "hevy", "2026-11-05T07:15:00"));

/** Matches the sample's machine row to the library, the way the match screen does. */
const matchMachineRow = (database: Database) =>
  aliases(database, (repository) =>
    repository.remember("hevy", [
      { name: "Chest Supported Machine Row", exerciseId: libraryExerciseId("Leverage_Iso_Row") },
    ]),
  );

const importSample = async () => {
  const database = openTestDatabase();
  await matchMachineRow(database);
  const result = await apply(database, SAMPLE);
  if (result === undefined) throw new Error("The sample imported nothing");
  return { database, batch: result.importBatchId };
};

// A draft started at T0 with one set of 100 kg for 5. The file repeats its sets in a
// workout on another day, and has a second workout whose time covers the draft's start.
const DRAFT_SQUAT = '"Squat (Barbell)",,"",0,"normal",100,5,,,';
const DRAFT_FILE = hevy(
  [
    HEADER,
    `"Squat day","1 Feb 2025, 10:00","1 Feb 2025, 11:00","",${DRAFT_SQUAT}`,
    `"New year","1 Jan 2026, 08:30","1 Jan 2026, 09:30","","Plank",,"",0,"normal",,,,60,`,
  ].join("\n"),
);
const startDraft = (database: Database) =>
  workoutsHere(database, (repository) =>
    repository.startWorkout({
      title: "Squats",
      routineId: null,
      exercises: [
        {
          exerciseId: libraryExerciseId("Barbell_Squat"),
          supersetGroup: null,
          notes: "",
          sets: [
            {
              setType: "normal",
              weightKg: 100,
              reps: 5,
              durationS: null,
              distanceM: null,
              targetRepsMin: null,
              targetRepsMax: null,
            },
          ],
        },
      ],
    }),
  );

/** Each live exercise's set fields, by its name. */
const setFieldsByName = (database: Database) =>
  Object.fromEntries(
    query(
      database,
      "SELECT e.name, ae.set_fields FROM activity_exercise ae JOIN exercise e ON e.id = ae.exercise_id WHERE ae.deleted_at IS NULL",
    ).map((row) => [row["name"], row["set_fields"]]),
  );

const exerciseIdOf = (database: Database, name: string) =>
  ExerciseId.make(
    String(query(database, "SELECT id FROM exercise WHERE name = ?", name)[0]?.["id"]),
  );

describe("Hevy import", () => {
  it("imports the sample with the right counts, under IDs from each workout's start", async () => {
    const database = openTestDatabase();
    await matchMachineRow(database);

    const plan = await preview(database, SAMPLE);
    expect(plan.added).toEqual([
      { table: "exercise", count: 1 },
      { table: "activity", count: 3 },
    ]);
    expect(plan.changed).toEqual([]);
    expect(plan.duplicates).toEqual([]);

    const result = await apply(database, SAMPLE);
    expect(result).toMatchObject({ added: 4, replaced: 0 });
    expect(count(database, "activity")).toBe(3);
    expect(count(database, "activity_exercise")).toBe(9);
    expect(count(database, "activity_set")).toBe(25);

    const [push, pull, legs] = workouts(database);
    expect(push).toEqual({
      title: "Push Day",
      notes: "Felt strong",
      startedAt: Date.UTC(2026, 10, 3, 18, 30),
      durationS: 3_900,
      audience: "only_you",
      exercises: [
        {
          name: "Barbell Bench Press - Medium Grip",
          supersetGroup: null,
          notes: "Pause each rep",
          sets: ["warm_up 60 10   ", "normal 100 5   8", "normal 100 5   8.5"],
        },
        {
          name: "Triceps Pushdown - Rope Attachment",
          supersetGroup: null,
          notes: "",
          sets: ["normal 30 12   ", "normal 30 12   ", "failure 30 10   "],
        },
        {
          name: "Landmine Press",
          supersetGroup: null,
          notes: "",
          sets: ["normal 40 10   ", "normal 40 10   "],
        },
      ],
    });
    expect(pull?.exercises.map(({ name, supersetGroup }) => [name, supersetGroup])).toEqual([
      ["Barbell Deadlift", null],
      ["Wide-Grip Lat Pulldown", 0],
      ["Leverage Iso Row", 0],
    ]);
    expect(legs?.exercises.at(-1)).toMatchObject({
      name: "Running, Treadmill",
      sets: ["normal   900 2000 "],
    });

    const [activity] = query(database, "SELECT * FROM activity WHERE id = ?", pushId);
    expect(activity).toMatchObject({
      source: "hevy",
      source_id: "2026-11-03T18:30:00",
      fingerprint: SAMPLE.workouts[0]?.fingerprint,
      import_batch_id: result?.importBatchId,
    });
    const firstSet = importedId("activity_set", "hevy", "2026-11-03T18:30:00/exercise/0/set/0");
    expect(query(database, "SELECT weight_kg FROM activity_set WHERE id = ?", firstSet)).toEqual([
      { weight_kg: 60 },
    ]);
    const [landmine] = query(
      database,
      "SELECT * FROM exercise WHERE id = ?",
      hevyExerciseId("Landmine Press"),
    );
    expect(landmine).toMatchObject({
      name: "Landmine Press",
      category: "strength",
      equipment: "other",
      source: "hevy",
      import_batch_id: result?.importBatchId,
    });
  });

  it("adds nothing when the same file is imported again", async () => {
    const { database } = await importSample();
    const before = query(database, "SELECT * FROM activity_set ORDER BY id");

    const plan = await preview(database, SAMPLE);
    expect(isNothingToImport(plan)).toBe(true);
    expect(plan.unchanged).toBe(3);
    expect(await apply(database, SAMPLE)).toBeUndefined();
    expect(query(database, "SELECT * FROM activity_set ORDER BY id")).toEqual(before);
    expect(query(database, "SELECT id FROM import_batch")).toHaveLength(1);
  });

  it("shows a changed and a renamed workout as changed, and adds no duplicate", async () => {
    const { database } = await importSample();
    const before = workouts(database);

    const plan = await preview(database, CHANGED);
    expect(plan.changed.map(({ title }) => title)).toEqual(["Back Day", "Push Day"]);
    expect(plan.added).toEqual([]);
    expect(plan.duplicates).toEqual([]);
    expect(plan.unchanged).toBe(1);

    expect(await apply(database, CHANGED)).toBeUndefined();
    expect(workouts(database)).toEqual(before);
  });

  it("takes the new versions, and Undo gives back the earlier ones", async () => {
    const { database } = await importSample();
    const before = workouts(database);
    const plan = await preview(database, CHANGED);

    const taken = await apply(
      database,
      CHANGED,
      plan.changed.map(({ key }) => key),
    );
    expect(taken).toMatchObject({ added: 0, replaced: 2 });
    const after = workouts(database);
    expect(after.map(({ title }) => title)).toEqual(["Push Day", "Back Day", "Legs"]);
    expect(after[0]?.exercises[0]?.sets).toEqual([
      "warm_up 60 10   ",
      "normal 102.5 5   8",
      "normal 102.5 5   8.5",
    ]);
    expect(after[0]?.exercises[1]?.sets).toEqual(["normal 30 12   ", "normal 30 12   "]);
    expect(count(database, "activity")).toBe(3);
    expect(count(database, "activity_set")).toBe(24);
    expect(
      query(database, "SELECT import_batch_id FROM activity WHERE id IN (?, ?)", pushId, pullId),
    ).toEqual([
      { import_batch_id: taken?.importBatchId },
      { import_batch_id: taken?.importBatchId },
    ]);

    expect(await undo(database, taken!.importBatchId)).toEqual({
      removed: 0,
      restored: 2,
      left: 0,
      kept: 0,
      discarded: 0,
    });
    expect(workouts(database)).toEqual(before);
    expect(count(database, "activity_set")).toBe(25);
  });

  it("imports again after Undo, bringing back the custom exercises the workouts use", async () => {
    const { database, batch } = await importSample();
    const before = workouts(database);
    await undo(database, batch);
    expect(count(database, "activity")).toBe(0);
    const landmine = () =>
      query(
        database,
        "SELECT deleted_at FROM exercise WHERE id = ?",
        hevyExerciseId("Landmine Press"),
      );
    expect(landmine()).toEqual([{ deleted_at: expect.any(Number) }]);

    const plan = await preview(database, SAMPLE);
    // The exercise is not a choice of its own. It comes back with the workouts that use it.
    expect(plan.changed.map(({ title }) => title)).toEqual(["Legs", "Pull Day", "Push Day"]);
    expect(plan.added).toEqual([]);

    const again = await apply(
      database,
      SAMPLE,
      plan.changed.map(({ key }) => key),
    );
    expect(again).toMatchObject({ added: 0, replaced: 3 });
    expect(workouts(database)).toEqual(before);
    expect(setsWithoutExercise(database)).toEqual([]);
    expect(landmine()).toEqual([{ deleted_at: null }]);
    expect(isNothingToImport(await preview(database, SAMPLE))).toBe(true);

    // Undo of the second import removes the workouts and the exercise together again.
    await undo(database, again!.importBatchId);
    expect(count(database, "activity")).toBe(0);
    expect(landmine()).toEqual([{ deleted_at: expect.any(Number) }]);
  });

  it("brings back a deleted custom exercise only with a workout that uses it", async () => {
    const { database, batch } = await importSample();
    await undo(database, batch);
    const plan = await preview(database, SAMPLE);
    const pull = plan.changed.find(({ title }) => title === "Pull Day");
    // Pull Day uses no custom exercise, so taking it alone leaves Landmine Press deleted.
    await apply(database, SAMPLE, [pull!.key]);
    expect(count(database, "activity")).toBe(1);
    expect(setsWithoutExercise(database)).toEqual([]);
    expect(
      query(
        database,
        "SELECT deleted_at FROM exercise WHERE id = ?",
        hevyExerciseId("Landmine Press"),
      ),
    ).toEqual([{ deleted_at: expect.any(Number) }]);
  });

  it("keeps a custom exercise a workout edited after a re-import still uses when Undo runs", async () => {
    const { database, batch } = await importSample();
    await undo(database, batch);
    const plan = await preview(database, SAMPLE);
    const again = await apply(
      database,
      SAMPLE,
      plan.changed.map(({ key }) => key),
    );
    await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.update(pushId, { notes: "Shoulder felt fine" }),
      ),
    );

    // The other two go back to deleted. Push Day was edited, so it stays, and so does the
    // custom exercise it uses.
    expect(await undo(database, again!.importBatchId)).toEqual({
      removed: 0,
      restored: 2,
      left: 1,
      kept: 1,
      discarded: 0,
    });
    expect(workouts(database).map(({ title, notes }) => ({ title, notes }))).toEqual([
      { title: "Push Day", notes: "Shoulder felt fine" },
    ]);
    expect(setsWithoutExercise(database)).toEqual([]);
    expect(
      query(
        database,
        "SELECT deleted_at FROM exercise WHERE id = ?",
        hevyExerciseId("Landmine Press"),
      ),
    ).toEqual([{ deleted_at: null }]);
  });

  it("brings back the import a restored exercise came from when Push Day alone is imported again", async () => {
    // Import the sample and the changed Hevy files.
    const { database } = await importSample();
    const plan = await preview(database, CHANGED);
    await apply(
      database,
      CHANGED,
      plan.changed.map(({ key }) => key),
    );

    // Export to a svett file, and import that export into an empty database.
    const { text } = await transfers(database, (repository) => repository.exportFile);
    const file = Result.getOrThrow(decodeSvettFile(text));
    const phone = openTestDatabase(2);
    const first = await transfers(phone, (repository) => repository.applyImport(file, []));

    // Undo that import.
    await undo(phone, Option.getOrThrow(first).importBatchId);
    expect(count(phone, "activity")).toBe(0);

    // Re-import only Push Day.
    const again = await transfers(phone, (repository) => repository.previewImport(file));
    const push = again.changed.find(({ title }) => title === "Push Day");
    await transfers(phone, (repository) => repository.applyImport(file, [push!.key]));
    expect(workouts(phone).map(({ title }) => title)).toEqual(["Push Day"]);
    expect(setsWithoutExercise(phone)).toEqual([]);
    expect(
      query(
        phone,
        "SELECT deleted_at FROM exercise WHERE id = ?",
        hevyExerciseId("Landmine Press"),
      ),
    ).toEqual([{ deleted_at: null }]);
    expect(pointersToDeleted(phone)).toEqual([]);
  });

  it("keeps a workout's saved start when its new version is read in another zone", async () => {
    const { database } = await importSample();
    const starts = () => query(database, "SELECT id, started_at FROM activity ORDER BY id");
    const before = starts();
    // The phone moved an hour east, so the same clock time is an hour earlier.
    const east = hevy(
      sampleText("hevy-sample-changed.csv"),
      (time) => wallTimeAsUtc(time) - 3_600_000,
    );
    const plan = await preview(database, east);
    expect(plan.changed.map(({ title }) => title)).toEqual(["Back Day", "Push Day"]);
    expect(plan.duplicates).toEqual([]);

    await apply(
      database,
      east,
      plan.changed.map(({ key }) => key),
    );
    expect(workouts(database).map(({ title }) => title)).toEqual(["Push Day", "Back Day", "Legs"]);
    expect(starts()).toEqual(before);
    expect(workouts(database)[0]?.startedAt).toBe(Date.UTC(2026, 10, 3, 18, 30));
  });

  it("does not list a workout you edited here when Hevy's copy has not changed", async () => {
    const { database } = await importSample();
    await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.update(pushId, { notes: "My own note", audience: "followers" }),
      ),
    );
    expect(isNothingToImport(await preview(database, SAMPLE))).toBe(true);
    const plan = await preview(database, CHANGED);
    // Hevy changed Push Day, so it is listed, and keeping yours keeps your note.
    expect(plan.changed.map(({ title }) => title)).toEqual(["Back Day", "Push Day"]);
    await apply(database, CHANGED);
    expect(workouts(database)[0]).toMatchObject({ notes: "My own note", audience: "followers" });
  });

  it("remembers how each name was matched for the next import", async () => {
    const { database, batch } = await importSample();
    const names = [
      "Chest Supported Machine Row",
      "Bench Press (Barbell)",
      "Landmine Press",
      "Pendlay Row",
    ];
    expect(await aliases(database, (repository) => repository.matchHevyNames(names))).toEqual([
      {
        name: "Chest Supported Machine Row",
        exerciseId: libraryExerciseId("Leverage_Iso_Row"),
        how: "remembered",
      },
      {
        name: "Bench Press (Barbell)",
        exerciseId: libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip"),
        how: "library",
      },
      { name: "Landmine Press", exerciseId: hevyExerciseId("Landmine Press"), how: "imported" },
      { name: "Pendlay Row", exerciseId: null, how: null },
    ]);

    // Undo removes the exercise the import made, so its name is asked again.
    await undo(database, batch);
    expect(
      await aliases(database, (repository) => repository.matchHevyNames(["Landmine Press"])),
    ).toEqual([{ name: "Landmine Press", exerciseId: null, how: null }]);
  });

  it("lets a match you choose replace the bundled one", async () => {
    const database = openTestDatabase();
    const mine = libraryExerciseId("Bench_Press_-_Powerlifting");
    await aliases(database, (repository) =>
      repository.remember("hevy", [{ name: "Bench Press (Barbell)", exerciseId: mine }]),
    );
    await apply(database, SAMPLE);
    expect(workouts(database)[0]?.exercises[0]?.name).toBe("Bench Press - Powerlifting");
  });

  it("holds back a second workout with the same start until you keep it", async () => {
    const database = openTestDatabase();
    const text = [
      HEADER,
      '"Morning","1 Feb 2025, 10:00","1 Feb 2025, 11:00","","Squat (Barbell)",,"",0,"normal",100,5,,,',
      '"Again","1 Feb 2025, 10:00","1 Feb 2025, 10:30","","Squat (Barbell)",,"",0,"normal",80,5,,,',
    ].join("\n");
    const file = hevy(text);

    const plan = await preview(database, file);
    expect(plan.added).toEqual([{ table: "activity", count: 1 }]);
    expect(plan.duplicates).toEqual([
      expect.objectContaining({
        key: "hevy/2025-02-01T10:00:00#1",
        reason: "same_start",
        kept: false,
        summary: expect.objectContaining({ title: "Again" }),
        other: expect.objectContaining({ title: "Morning" }),
      }),
    ]);

    const keep = new Set(["hevy/2025-02-01T10:00:00#1"]);
    expect((await preview(database, file, keep)).added).toEqual([{ table: "activity", count: 2 }]);
    await apply(database, file, [], keep);
    expect(workouts(database).map(({ title }) => title)).toEqual(["Morning", "Again"]);
    expect(query(database, "SELECT source_id FROM activity ORDER BY source_id")).toEqual([
      { source_id: "2025-02-01T10:00:00" },
      { source_id: "2025-02-01T10:00:00#1" },
    ]);
    expect(isNothingToImport(await preview(database, file, keep))).toBe(true);
  });

  const twins = [
    '"Morning","1 Feb 2025, 10:00","1 Feb 2025, 11:00","","Squat (Barbell)",,"",0,"normal",100,5,,,',
    '"Again","1 Feb 2025, 10:00","1 Feb 2025, 10:30","","Squat (Barbell)",,"",0,"normal",80,5,,,',
  ];
  const newer =
    '"Newer","8 Feb 2025, 10:00","8 Feb 2025, 11:00","","Squat (Barbell)",,"",0,"normal",90,5,,,';

  it("knows a kept second workout again after Hevy writes a newer workout above it", async () => {
    const database = openTestDatabase();
    const keep = new Set(["hevy/2025-02-01T10:00:00#1"]);
    await apply(database, hevy([HEADER, ...twins].join("\n")), [], keep);

    const later = hevy([HEADER, newer, ...twins].join("\n"));
    const plan = await preview(database, later);
    expect(plan.duplicates).toEqual([]);
    expect(plan.added).toEqual([{ table: "activity", count: 1 }]);
    await apply(database, later);
    expect(workouts(database).map(({ title }) => title)).toEqual(["Morning", "Again", "Newer"]);
  });

  it("knows a second workout kept under its place in the whole file, as earlier versions did", async () => {
    const database = openTestDatabase();
    const start = "2025-02-01T10:00:00";
    // Earlier versions identified the second workout at a start by its place in the file, so
    // one imported from a file with another workout above the two was #2.
    const legacy = (from: string, to: string): ImportInput => {
      const input = hevyImport(hevy([HEADER, ...twins].join("\n")), new Set([`hevy/${from}`]));
      const moved = new Map<string, string>([
        [importedId("activity", "hevy", from), importedId("activity", "hevy", to)],
        [
          importedId("activity_exercise", "hevy", `${from}/exercise/0`),
          importedId("activity_exercise", "hevy", `${to}/exercise/0`),
        ],
        [
          importedId("activity_set", "hevy", `${from}/exercise/0/set/0`),
          importedId("activity_set", "hevy", `${to}/exercise/0/set/0`),
        ],
      ]);
      const move = (value: unknown) =>
        value === from ? to : typeof value === "string" ? (moved.get(value) ?? value) : value;
      return {
        source: input.source,
        read: (local, at) => {
          const read = input.read(local, at);
          const tables = Object.fromEntries(
            Object.entries(read.tables).map(([table, rows]) => [
              table,
              (rows as ReadonlyArray<Record<string, unknown>>).map((row) =>
                Object.fromEntries(Object.entries(row).map(([key, value]) => [key, move(value)])),
              ),
            ]),
          );
          return { tables: tables as typeof read.tables, duplicates: read.duplicates };
        },
      };
    };
    await transfers(database, (repository) =>
      repository.applyImport(legacy(`${start}#1`, `${start}#2`), []),
    );
    expect(query(database, "SELECT source_id FROM activity ORDER BY source_id")).toEqual([
      { source_id: start },
      { source_id: `${start}#2` },
    ]);

    const plan = await preview(database, hevy([HEADER, ...twins].join("\n")));
    expect(plan.duplicates).toEqual([]);
    expect(isNothingToImport(plan)).toBe(true);
  });

  it.each([
    { start: "7 Nov 2026, 17:30", end: "7 Nov 2026, 18:40", at: Date.UTC(2026, 10, 7, 17, 30) },
    { start: "11 Nov 2026, 17:00", end: "11 Nov 2026, 18:10", at: Date.UTC(2026, 10, 11, 17) },
  ])(
    "holds back a new start with the same sets as a workout here, however far it moved: $start",
    async ({ start, end, at }) => {
      const { database } = await importSample();
      const moved = hevy(
        LEGS.replaceAll("7 Nov 2026, 17:00", start).replaceAll("7 Nov 2026, 18:10", end),
      );
      const plan = await preview(database, moved);
      expect(plan.added).toEqual([]);
      expect(plan.duplicates).toEqual([
        expect.objectContaining({
          reason: "same_sets",
          kept: false,
          summary: expect.objectContaining({ title: "Legs", at }),
          other: expect.objectContaining({ title: "Legs", at: Date.UTC(2026, 10, 7, 17) }),
        }),
      ]);
      const key = plan.duplicates[0]!.key;
      expect((await preview(database, moved, new Set([key]))).added).toEqual([
        { table: "activity", count: 1 },
      ]);
    },
  );

  it("holds back a new workout that overlaps one from another source", async () => {
    const database = openTestDatabase();
    await matchMachineRow(database);
    const run = (startedAt: number, title: string) =>
      database.runtime.runPromise(
        Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
          activities.create({
            origin: MADE_HERE,
            kind: "run",
            startedAt: EpochMillis.make(startedAt),
            durationS: DurationSeconds.make(1_800),
            title,
            notes: "",
            energyKcal: null,
            audience: "only_you",
            hiddenFields: [],
            exercises: [],
            track: null,
          }),
        ),
      );
    // Legs runs from 17:00 to 18:10 on 7 Nov. The first run is inside it, the second after it.
    await run(Date.UTC(2026, 10, 7, 17, 20), "Treadmill run");
    await run(Date.UTC(2026, 10, 7, 18, 10), "Cool down");

    const plan = await preview(database, SAMPLE);
    expect(plan.added).toEqual([
      { table: "exercise", count: 1 },
      { table: "activity", count: 2 },
    ]);
    expect(plan.duplicates).toEqual([
      expect.objectContaining({
        key: "hevy/2026-11-07T17:00:00",
        reason: "overlap",
        kept: false,
        summary: expect.objectContaining({ title: "Legs" }),
        other: expect.objectContaining({ title: "Treadmill run" }),
      }),
    ]);
  });

  it("imports 300 workouts of 20 sets in under 10 seconds", async () => {
    const database = openTestDatabase();
    const lines = [HEADER];
    const names = ["Squat (Barbell)", "Bench Press (Barbell)", "Bent Over Row (Barbell)", "Plank"];
    for (let day = 0; day < 300; day++) {
      const date = new Date(Date.UTC(2024, 0, 1) + day * 2 * 86_400_000);
      const stamp = `${date.getUTCDate()} ${date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${date.getUTCFullYear()}`;
      for (const [position, name] of names.entries()) {
        for (let set = 0; set < 5; set++) {
          lines.push(
            `"Day ${day}","${stamp}, 18:00","${stamp}, 19:00","","${name}",,"",${set},"normal",${60 + position * 10 + set},${5 + set},,,`,
          );
        }
      }
    }
    const file = hevy(lines.join("\n"));
    expect(file.sets).toBe(6_000);

    const started = performance.now();
    const result = await apply(database, file);
    const seconds = (performance.now() - started) / 1_000;
    expect(result?.added).toBe(300);
    expect(count(database, "activity_set")).toBe(6_000);
    expect(seconds).toBeLessThan(10);
  });

  describe("with a workout in progress", () => {
    it("holds back both workouts once the same workout is finished", async () => {
      const database = openTestDatabase();
      const id = await startDraft(database);
      await workoutsHere(database, (repository) => repository.update(id, { status: "finished" }));

      const plan = await preview(database, DRAFT_FILE);
      expect(plan.duplicates.map(({ reason, summary }) => [reason, summary.title])).toEqual([
        ["same_sets", "Squat day"],
        ["overlap", "New year"],
      ]);
    });

    it("never holds a workout back for it, and leaves it untouched", async () => {
      const database = openTestDatabase();
      await startDraft(database);
      const before = await workoutsHere(database, (repository) => repository.inProgress);

      const plan = await preview(database, DRAFT_FILE);
      expect(plan.duplicates).toEqual([]);
      expect(plan.added).toEqual([{ table: "activity", count: 2 }]);
      expect(plan.skipped).toBe(0);
      expect((await apply(database, DRAFT_FILE))?.added).toBe(2);

      const after = await workoutsHere(database, (repository) => repository.inProgress);
      expect(Option.getOrThrow(after).activity.startedAt).toBe(T0);
      expect(after).toEqual(before);
      const exported = Result.getOrThrow(
        decodeSvettFile((await transfers(database, (repository) => repository.exportFile)).text),
      );
      expect(exported.tables.activity?.map((row) => row["title"]).sort()).toEqual([
        "New year",
        "Squat day",
      ]);
    });

    it("shows the imported workouts in history as finished, with every set done", async () => {
      const database = openTestDatabase();
      await startDraft(database);
      await matchMachineRow(database);
      await apply(database, SAMPLE);

      const history = await workoutsHere(database, (repository) => repository.list());
      expect(history.map(({ title, status, routineId }) => [title, status, routineId])).toEqual([
        ["Legs", "finished", null],
        ["Pull Day", "finished", null],
        ["Push Day", "finished", null],
      ]);
      const sets = (
        await workoutsHere(database, (repository) =>
          Effect.forEach(history, ({ id }) => repository.get(id)),
        )
      ).flatMap((detail) =>
        Option.getOrThrow(detail).exercises.flatMap((exercise) => exercise.sets),
      );
      expect(sets).toHaveLength(SAMPLE.sets);
      expect(
        new Set(
          sets.map(({ done, targetRepsMin, targetRepsMax }) =>
            [done, targetRepsMin, targetRepsMax].join(),
          ),
        ),
      ).toEqual(new Set(["true,,"]));
      expect(await workoutsHere(database, (repository) => repository.counts)).toEqual({
        activities: 3,
        sets: SAMPLE.sets,
      });
    });
  });

  describe("and the logger", () => {
    const CORE = hevy(
      [
        HEADER,
        `"Core","9 Nov 2026, 12:00","9 Nov 2026, 12:30","","Pull Up",,"",0,"normal",,8,,,`,
        `"Core","9 Nov 2026, 12:00","9 Nov 2026, 12:30","","Plank",,"",0,"normal",,,,60,`,
      ].join("\n"),
    );

    it("logs each imported exercise by what its sets record, and starts it that way next time", async () => {
      const { database } = await importSample();
      await apply(database, CORE);
      expect(setFieldsByName(database)).toEqual({
        "Barbell Bench Press - Medium Grip": "weight_reps",
        "Triceps Pushdown - Rope Attachment": "weight_reps",
        "Landmine Press": "weight_reps",
        "Barbell Deadlift": "weight_reps",
        "Wide-Grip Lat Pulldown": "weight_reps",
        "Leverage Iso Row": "weight_reps",
        "Barbell Squat": "weight_reps",
        "Seated Leg Curl": "weight_reps",
        "Running, Treadmill": "distance_time",
        Pullups: "reps",
        Plank: "time",
      });

      const names = ["Barbell Squat", "Pullups", "Plank", "Running, Treadmill"];
      const workout = Option.getOrThrow(
        await database.runtime.runPromise(
          Effect.gen(function* () {
            const id = yield* startEmptyWorkout(18);
            yield* addExercisesToWorkout(
              id,
              names.map((name) => exerciseIdOf(database, name)),
            );
            return yield* loadWorkoutLog;
          }),
        ),
      );
      expect(
        workout.exercises.map(({ exercise, row, previous }) => [
          exercise?.name,
          row.setFields,
          previous.map((set) =>
            set === null
              ? null
              : [set.setType, set.weightKg, set.reps, set.durationS, set.distanceM].join(" "),
          ),
        ]),
      ).toEqual([
        [
          "Barbell Squat",
          "weight_reps",
          ["warm_up 60 8  ", "normal 120 5  ", "normal 120 5  ", "normal 120 5  ", "drop 90 8  "],
        ],
        ["Pullups", "reps", ["normal  8  "]],
        ["Plank", "time", ["normal   60 "]],
        ["Running, Treadmill", "distance_time", ["normal   900 2000"]],
      ]);
    });

    it("undoes a Hevy import whose journal was written before exercises had set fields", async () => {
      const { database, batch } = await importSample();
      const sample = { workouts: workouts(database), setFields: setFieldsByName(database) };
      // New notes on the treadmill replace its exercise row, so the journal keeps that row.
      const easier = hevy(sampleText("hevy-sample.csv").replace('"Cool down"', '"Easy pace"'));
      const plan = await preview(database, easier);
      expect(plan.changed.map(({ title }) => title)).toEqual(["Legs"]);
      const taken = await apply(
        database,
        easier,
        plan.changed.map(({ key }) => key),
      );
      // Each journal as svett wrote it then, with no set fields on the exercises it kept.
      const stripped: Array<unknown> = [];
      for (const change of query(database, "SELECT id, replaced FROM import_change")) {
        if (change["replaced"] === null) continue;
        const replaced = JSON.parse(String(change["replaced"])) as Record<
          string,
          Array<Record<string, unknown>>
        >;
        for (const row of replaced["activity_exercise"] ?? []) {
          stripped.push(row["setFields"]);
          delete row["setFields"];
        }
        database.database
          .prepare("UPDATE import_change SET replaced = ? WHERE id = ?")
          .run(JSON.stringify(replaced), String(change["id"]));
      }
      expect(stripped).toEqual(["distance_time"]);
      expect(
        query(database, "SELECT replaced FROM import_change WHERE replaced IS NOT NULL").some(
          ({ replaced }) => String(replaced).includes("setFields"),
        ),
      ).toBe(false);

      const editedIn = async (importBatchId: ImportBatchId) =>
        (
          await transfers(database, (repository) => repository.previewUndo(importBatchId))
        ).changes.map(({ edited }) => edited);
      expect(await editedIn(taken!.importBatchId)).toEqual([false]);
      expect(await undo(database, taken!.importBatchId)).toEqual({
        removed: 0,
        restored: 1,
        left: 0,
        kept: 0,
        discarded: 0,
      });
      expect({ workouts: workouts(database), setFields: setFieldsByName(database) }).toEqual(
        sample,
      );
      expect(await editedIn(batch)).not.toContain(true);
      await undo(database, batch);
      expect(count(database, "activity")).toBe(0);
      expect(count(database, "activity_exercise")).toBe(0);
    });
  });
});
