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

  it("saves an edited routine with its new exercises and targets in the new order", async () => {
    const database = openTestDatabase();
    const id = await run(database, (routines) => routines.createRoutine(pushDay(null)));
    const [bench, raise] = pushDay(null).exercises;
    await run(database, (routines) =>
      routines.saveRoutine(id, {
        ...pushDay(null),
        title: "Push B",
        exercises: [{ ...raise!, sets: [target(10, 12), target(10, 12)] }, bench!],
      }),
    );
    const detail = Option.getOrThrow(await run(database, (routines) => routines.getRoutine(id)));
    expect(detail.routine.title).toBe("Push B");
    expect(
      detail.exercises.map(({ exercise, sets }) => [
        exercise.exerciseId,
        exercise.position,
        sets.map((set) => [set.position, set.repsMin, set.repsMax]),
      ]),
    ).toEqual([
      [
        raise!.exerciseId,
        0,
        [
          [0, 10, 12],
          [1, 10, 12],
        ],
      ],
      [
        bench!.exerciseId,
        1,
        [
          [0, 5, 5],
          [1, 5, 5],
          [2, 5, 5],
        ],
      ],
    ]);
    const live = database.database
      .prepare(
        "SELECT (SELECT count(*) FROM routine_exercise WHERE deleted_at IS NULL) AS exercises, (SELECT count(*) FROM routine_set WHERE deleted_at IS NULL) AS sets",
      )
      .get();
    expect(live).toEqual({ exercises: 2, sets: 5 });
  });

  it("duplicates a routine with its targets at the end of its folder under a new name", async () => {
    const database = openTestDatabase();
    const folderId = await run(database, (routines) =>
      routines.createFolder({ name: "Program", position: 0 }),
    );
    const id = await run(database, (routines) => routines.createRoutine(pushDay(folderId)));
    await run(database, (routines) =>
      routines.createRoutine({ ...pushDay(folderId), title: "Pull", position: 1 }),
    );
    const copy = await run(database, (routines) => routines.duplicateRoutine(id));
    const again = await run(database, (routines) => routines.duplicateRoutine(id));

    const original = Option.getOrThrow(await run(database, (routines) => routines.getRoutine(id)));
    const copied = Option.getOrThrow(await run(database, (routines) => routines.getRoutine(copy)));
    expect(copied.routine).toMatchObject({ title: "Push copy", folderId, position: 2 });
    const targets = (detail: typeof original) =>
      detail.exercises.map(({ exercise, sets }) => [
        exercise.exerciseId,
        exercise.supersetGroup,
        sets.map((set) => [set.setType, set.repsMin, set.repsMax]),
      ]);
    expect(targets(copied)).toEqual(targets(original));
    expect(copied.exercises[0]?.exercise.id).not.toBe(original.exercises[0]?.exercise.id);
    expect(
      Option.getOrThrow(await run(database, (routines) => routines.getRoutine(again))).routine,
    ).toMatchObject({ title: "Push copy 2", position: 3 });
  });

  it("reorders routines and folders and moves a routine to the end of another folder", async () => {
    const database = openTestDatabase();
    const [a, b] = [
      await run(database, (routines) => routines.createFolder({ name: "A", position: 0 })),
      await run(database, (routines) => routines.createFolder({ name: "B", position: 1 })),
    ];
    const push = await run(database, (routines) => routines.createRoutine(pushDay(a)));
    const pull = await run(database, (routines) =>
      routines.createRoutine({ ...pushDay(a), title: "Pull", position: 1 }),
    );
    const legs = await run(database, (routines) =>
      routines.createRoutine({ ...pushDay(b), title: "Legs", position: 0 }),
    );

    await run(database, (routines) => routines.orderRoutines([pull, push]));
    await run(database, (routines) => routines.orderFolders([b, a]));
    await run(database, (routines) => routines.moveRoutine(push, b));
    await run(database, (routines) => routines.moveRoutine(legs, null));

    const listed = await run(database, (routines) => routines.listRoutines);
    const byTitle = [...listed].sort((x, y) => x.title.localeCompare(y.title));
    expect(byTitle.map((r) => [r.title, r.folderId, r.position])).toEqual([
      ["Legs", null, 0],
      ["Pull", a, 0],
      ["Push", b, 1],
    ]);
    expect((await run(database, (routines) => routines.listFolders)).map((f) => f.name)).toEqual([
      "B",
      "A",
    ]);
  });

  it("refuses to order a routine that does not exist", async () => {
    const database = openTestDatabase();
    const id = await run(database, (routines) => routines.createRoutine(pushDay(null)));
    await run(database, (routines) => routines.removeRoutine(id));
    const exit = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(RoutineRepository), (routines) => routines.orderRoutines([id])),
    );
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "RowNotFoundError", table: "routine" } }] },
    });
  });

  it("lists the exercises of live routines in their order", async () => {
    const database = openTestDatabase();
    const kept = await run(database, (routines) => routines.createRoutine(pushDay(null)));
    const removed = await run(database, (routines) => routines.createRoutine(pushDay(null)));
    await run(database, (routines) => routines.removeRoutine(removed));
    const listed = await run(database, (routines) => routines.listRoutineExercises);
    expect(listed.map((exercise) => [exercise.routineId, exercise.position])).toEqual([
      [kept, 0],
      [kept, 1],
    ]);
  });
});
