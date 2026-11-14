import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { databaseLayer } from "../database.ts";
import { exerciseLibrary, fromLibraryEntry, libraryExerciseId } from "../exercise-library.ts";
import { NO_FILTER, searchExercises } from "../exercise-search.ts";
import { Ids } from "../ids.ts";
import { manualClock } from "../manual-clock.ts";
import { openNodeDatabase } from "../node-sqlite.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { ExerciseRepository } from "./exercises.ts";
import { MADE_HERE } from "./origin.ts";

const run = <A, E>(
  database: ReturnType<typeof openTestDatabase>,
  body: (repository: typeof ExerciseRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(ExerciseRepository), body));

describe("exercise library", () => {
  it("bundles every free-exercise-db exercise and maps each to svett's enums", () => {
    const library = exerciseLibrary();
    expect(library).toHaveLength(876);
    expect(new Set(library.map((exercise) => exercise.id)).size).toBe(876);
    expect(library.every((exercise) => exercise.primaryMuscles.length > 0)).toBe(true);
  });

  it("maps the library's own names for muscles, equipment and categories", () => {
    expect(
      fromLibraryEntry({
        id: "Bent_Over_Barbell_Row",
        name: "Bent Over Barbell Row",
        category: "olympic weightlifting",
        equipment: "e-z curl bar",
        primaryMuscles: ["middle back"],
        secondaryMuscles: ["lower back", "lats", "middle back"],
      }),
    ).toMatchObject({
      category: "olympic_weightlifting",
      equipment: "ez_bar",
      primaryMuscles: ["upper_back"],
      secondaryMuscles: ["lower_back", "lats", "upper_back"],
    });
    expect(
      fromLibraryEntry({
        id: "x",
        name: "x",
        category: "strength",
        equipment: null,
        primaryMuscles: ["abdominals"],
        secondaryMuscles: [],
      }).equipment,
    ).toBe("none");
  });

  it("gives a library exercise the same ID on every device", () => {
    expect(libraryExerciseId("Barbell_Squat")).toBe(libraryExerciseId("Barbell_Squat"));
    expect(libraryExerciseId("Barbell_Squat")).not.toBe(libraryExerciseId("Barbell_Deadlift"));
  });
});

describe("ExerciseRepository", () => {
  it("seeds the library on first open and finds nothing to add after that", async () => {
    const database = openTestDatabase();
    expect(await run(database, (exercises) => exercises.count)).toBe(876);
    expect(await run(database, (exercises) => exercises.seedLibrary())).toBe(0);
    const squat = Option.getOrThrow(
      await run(database, (exercises) => exercises.get(libraryExerciseId("Barbell_Squat"))),
    );
    expect(squat).toMatchObject({
      name: "Barbell Squat",
      source: "library",
      sourceId: "Barbell_Squat",
      equipment: "barbell",
    });
  });

  it("adds back only the library exercises a database lacks", async () => {
    const database = openTestDatabase();
    expect(await run(database, (exercises) => exercises.count)).toBe(876);
    database.database.exec("DELETE FROM exercise WHERE source_id = 'Barbell_Squat'");
    expect(await run(database, (exercises) => exercises.seedLibrary())).toBe(1);
    expect(await run(database, (exercises) => exercises.count)).toBe(876);
    expect(await run(database, (exercises) => exercises.seedLibrary())).toBe(0);
  });

  it("opens the same file twice without adding rows", async () => {
    const { driver } = openNodeDatabase();
    const open = () =>
      ManagedRuntime.make(
        Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(1)), manualClock(T0).layer),
      ).runPromise(Effect.flatMap(Effect.service(ExerciseRepository), (e) => e.count));
    expect(await open()).toBe(876);
    expect(await open()).toBe(876);
  });

  it("creates, edits and deletes a custom exercise", async () => {
    const database = openTestDatabase();
    const id = await run(database, (exercises) =>
      exercises.create({
        name: "Landmine press",
        category: "strength",
        equipment: "barbell",
        primaryMuscles: ["shoulders"],
        secondaryMuscles: ["triceps", "chest"],
        origin: MADE_HERE,
      }),
    );
    await run(database, (exercises) =>
      exercises.update(id, { name: "Half-kneeling landmine press" }),
    );
    const listed = await run(database, (exercises) => exercises.list);
    expect(listed.find((exercise) => exercise.id === id)).toMatchObject({
      name: "Half-kneeling landmine press",
      source: "svett",
      secondaryMuscles: ["triceps", "chest"],
    });

    await run(database, (exercises) => exercises.remove(id));
    expect(await run(database, (exercises) => exercises.get(id))).toEqual(Option.none());
    expect(await run(database, (exercises) => exercises.count)).toBe(876);
  });

  it("keeps any number of custom exercises with their own IDs across a reopen", async () => {
    const { driver } = openNodeDatabase();
    const open = () =>
      ManagedRuntime.make(
        Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(1)), manualClock(T0).layer),
      );
    const created = await open().runPromise(
      Effect.flatMap(Effect.service(ExerciseRepository), (exercises) =>
        Effect.forEach(
          Array.from({ length: 300 }, (_, index) => index),
          (index) =>
            exercises.create({
              name: `Custom press ${index}`,
              category: "strength",
              equipment: "cable",
              primaryMuscles: ["chest"],
              secondaryMuscles: [],
              origin: MADE_HERE,
            }),
        ),
      ),
    );
    expect(new Set(created).size).toBe(300);
    // A custom exercise gets a random version 7 UUID, not one derived from its name.
    expect(created.every((id) => id[14] === "7")).toBe(true);

    const listed = await open().runPromise(
      Effect.flatMap(Effect.service(ExerciseRepository), (exercises) => exercises.list),
    );
    expect(listed).toHaveLength(876 + 300);
    const found = searchExercises(listed, { ...NO_FILTER, text: "custom press 299" });
    expect(found[0]).toMatchObject({ id: created[299], source: "svett", sourceId: null });
  });
});
