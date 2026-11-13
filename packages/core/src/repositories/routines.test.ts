import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { libraryExerciseId } from "../exercise-library.ts";
import type { FolderId } from "../schema.ts";
import { openTestDatabase } from "../test-database.ts";
import { type RoutineDraft, RoutineRepository, type RoutineSetDraft } from "./routines.ts";

const target = (repsMin: number, repsMax: number): RoutineSetDraft => ({
  setType: "normal",
  weightKg: null,
  repsMin,
  repsMax,
  durationS: null,
  distanceM: null,
});

const pushDay = (folderId: FolderId | null): RoutineDraft => ({
  folderId,
  title: "Push",
  notes: "",
  position: 0,
  exercises: [
    {
      exerciseId: libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip"),
      supersetGroup: null,
      restS: null,
      notes: "",
      sets: [target(5, 5), target(5, 5), target(5, 5)],
    },
    {
      exerciseId: libraryExerciseId("Side_Lateral_Raise"),
      supersetGroup: 1,
      restS: null,
      notes: "",
      sets: [target(12, 15)],
    },
  ],
});

const run = <A, E>(
  database: ReturnType<typeof openTestDatabase>,
  body: (repository: typeof RoutineRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(RoutineRepository), body));

describe("RoutineRepository", () => {
  it("creates a routine in a folder and reads it back with its targets", async () => {
    const database = openTestDatabase();
    const folderId = await run(database, (routines) =>
      routines.createFolder({ name: "Program", position: 0 }),
    );
    const id = await run(database, (routines) => routines.createRoutine(pushDay(folderId)));
    const detail = Option.getOrThrow(await run(database, (routines) => routines.getRoutine(id)));
    expect(detail.routine).toMatchObject({ title: "Push", folderId });
    expect(
      detail.exercises.map(({ exercise, sets }) => [exercise.supersetGroup, sets.length]),
    ).toEqual([
      [null, 3],
      [1, 1],
    ]);
    expect((await run(database, (routines) => routines.listFolders)).map((f) => f.name)).toEqual([
      "Program",
    ]);
  });

  it("updates a routine and refuses a rep range that ends below its start", async () => {
    const database = openTestDatabase();
    const id = await run(database, (routines) => routines.createRoutine(pushDay(null)));
    await run(database, (routines) => routines.updateRoutine(id, { title: "Push A" }));
    const detail = Option.getOrThrow(await run(database, (routines) => routines.getRoutine(id)));
    expect(detail.routine.title).toBe("Push A");
    const setId = detail.exercises[1]!.sets[0]!.id;
    const exit = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(RoutineRepository), (routines) =>
        routines.updateRoutineSet(setId, { repsMin: 20 }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("deletes a folder with its routines and their exercises and sets", async () => {
    const database = openTestDatabase();
    const folderId = await run(database, (routines) =>
      routines.createFolder({ name: "Program", position: 0 }),
    );
    const inFolder = await run(database, (routines) => routines.createRoutine(pushDay(folderId)));
    const loose = await run(database, (routines) => routines.createRoutine(pushDay(null)));
    await run(database, (routines) => routines.removeFolder(folderId));

    expect(await run(database, (routines) => routines.listFolders)).toEqual([]);
    expect((await run(database, (routines) => routines.listRoutines)).map((r) => r.id)).toEqual([
      loose,
    ]);
    expect(await run(database, (routines) => routines.getRoutine(inFolder))).toEqual(Option.none());
    const live = database.database
      .prepare(
        "SELECT (SELECT count(*) FROM routine_exercise WHERE deleted_at IS NULL) AS exercises, (SELECT count(*) FROM routine_set WHERE deleted_at IS NULL) AS sets",
      )
      .get();
    expect(live).toEqual({ exercises: 2, sets: 4 });
  });

  it("deletes one routine with its children", async () => {
    const database = openTestDatabase();
    const id = await run(database, (routines) => routines.createRoutine(pushDay(null)));
    await run(database, (routines) => routines.removeRoutine(id));
    expect(await run(database, (routines) => routines.listRoutines)).toEqual([]);
    const live = database.database
      .prepare("SELECT count(*) AS n FROM routine_set WHERE deleted_at IS NULL")
      .get();
    expect(live).toEqual({ n: 0 });
  });
});
