import { readFileSync } from "node:fs";

import { Effect, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { libraryExerciseId } from "../exercise-library.ts";
import { decodeHevyFile, type HevyFile, wallTimeAsUtc } from "../hevy-file.ts";
import { hevyExerciseId, hevyImport } from "../hevy-import.ts";
import { importedId } from "../ids.ts";
import { ActivityId, type ImportBatchId } from "../schema.ts";
import { openTestDatabase } from "../test-database.ts";
import { isNothingToImport } from "../transfer.ts";
import { ActivityRepository } from "./activities.ts";
import { ExerciseAliasRepository } from "./exercises.ts";
import { TransferRepository } from "./transfer.ts";

type Database = ReturnType<typeof openTestDatabase>;

const sampleText = (name: string) =>
  readFileSync(new URL(`../../test-data/${name}`, import.meta.url), "utf8");

const hevy = (text: string): HevyFile => Result.getOrThrow(decodeHevyFile(text, wallTimeAsUtc));

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
    });
    expect(workouts(database)).toEqual(before);
    expect(count(database, "activity_set")).toBe(25);
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

  it("holds back a new start with the same sets as a workout here that day, but not a week later", async () => {
    const { database } = await importSample();
    const legs = sampleText("hevy-sample.csv")
      .split("\n")
      .filter((line, index) => index === 0 || line.startsWith('"Legs"'))
      .join("\n");
    const moved = hevy(
      legs
        .replaceAll("7 Nov 2026, 17:00", "7 Nov 2026, 17:30")
        .replaceAll("7 Nov 2026, 18:10", "7 Nov 2026, 18:40"),
    );
    const plan = await preview(database, moved);
    expect(plan.added).toEqual([]);
    expect(plan.duplicates).toEqual([
      expect.objectContaining({
        reason: "same_sets",
        kept: false,
        summary: expect.objectContaining({ title: "Legs", at: Date.UTC(2026, 10, 7, 17, 30) }),
        other: expect.objectContaining({ title: "Legs", at: Date.UTC(2026, 10, 7, 17) }),
      }),
    ]);

    const nextWeek = hevy(legs.replaceAll("7 Nov 2026", "14 Nov 2026"));
    const later = await preview(database, nextWeek);
    expect(later.duplicates).toEqual([]);
    expect(later.added).toEqual([{ table: "activity", count: 1 }]);
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
});
