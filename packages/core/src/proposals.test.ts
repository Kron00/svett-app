import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { libraryExerciseId } from "./exercise-library.ts";
import {
  applyProposal,
  createProposal,
  type PlannedRoutine,
  planSummary,
  type ProposalPlan,
  proposalView,
  undoProposal,
  unknownExercises,
} from "./proposals.ts";
import { MADE_HERE } from "./repositories/origin.ts";
import { ExerciseRepository } from "./repositories/exercises.ts";
import { ProposalRepository } from "./repositories/records.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import type { ExerciseId, ProposalId } from "./schema.ts";
import { openTestDatabase, pointersToDeleted } from "./test-database.ts";
import { trainOverview } from "./train-overview.ts";

const BENCH = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");
const ROW = libraryExerciseId("Bent_Over_Barbell_Row");
const SQUAT = libraryExerciseId("Barbell_Squat");

const routine = (title: string, ...exerciseIds: ReadonlyArray<ExerciseId>): PlannedRoutine => ({
  title,
  notes: "",
  exercises: exerciseIds.map((exerciseId) => ({
    exerciseId,
    restS: null,
    notes: "",
    sets: [1, 2, 3].map(() => ({
      setType: "normal" as const,
      weightKg: 60,
      repsMin: 8,
      repsMax: 10,
      durationS: null,
      distanceM: null,
    })),
  })),
});

const upper: ProposalPlan = { kind: "routine", routine: routine("Upper body", BENCH, ROW) };
const program: ProposalPlan = {
  kind: "program",
  folder: "Three-day split",
  routines: [routine("Day 1", BENCH), routine("Day 2", ROW), routine("Day 3", SQUAT)],
};

type Database = ReturnType<typeof openTestDatabase>;

const run = <A, E>(database: Database, effect: Effect.Effect<A, E, any>) =>
  database.runtime.runPromise(effect as Effect.Effect<A, E, never>);

const failure = async <A, E>(database: Database, effect: Effect.Effect<A, E, any>) => {
  const exit = await database.runtime.runPromiseExit(effect as Effect.Effect<A, E, never>);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  return JSON.stringify(exit.cause);
};

/** What the Train tab lists: each folder or "none", and the routine titles under it. */
const train = (database: Database) =>
  run(
    database,
    Effect.map(trainOverview, ({ sections }) =>
      sections.map((section) => [
        section.folder?.name ?? "none",
        section.routines.map((each) => each.title),
      ]),
    ),
  );

const propose = (database: Database, plan: ProposalPlan) =>
  run(database, createProposal(plan, null));

const withRoutines = <A, E>(
  database: Database,
  body: (routines: typeof RoutineRepository.Service) => Effect.Effect<A, E>,
) => run(database, Effect.flatMap(Effect.service(RoutineRepository), body));

/** A database that already holds one routine of the user's own. */
const withOwnRoutine = async () => {
  const database = openTestDatabase();
  const { title, notes, exercises } = routine("My legs", SQUAT);
  await withRoutines(database, (routines) =>
    routines.createRoutine({
      folderId: null,
      title,
      notes,
      position: 0,
      exercises: exercises.map((exercise) => ({ ...exercise, supersetGroup: null })),
    }),
  );
  return database;
};

const status = (database: Database, id: ProposalId) =>
  run(database, Effect.map(proposalView(id), (view) => view.status));

describe("a coach proposal", () => {
  it("writes nothing to routines until Apply, then shows under Train", async () => {
    const database = await withOwnRoutine();
    const id = await propose(database, upper);
    expect(await train(database)).toEqual([["none", ["My legs"]]]);
    expect(await status(database, id)).toBe("pending");

    expect(await run(database, applyProposal(id))).toBe(true);
    expect(await train(database)).toEqual([["none", ["My legs", "Upper body"]]]);
    const view = await run(database, proposalView(id));
    expect(view.status).toBe("applied");
    expect(view.routineIds).toHaveLength(1);
    const detail = await withRoutines(database, (routines) =>
      routines.getRoutine(view.routineIds[0]!),
    );
    expect(
      Option.getOrThrow(detail).exercises.map(({ exercise, sets }) => [
        exercise.exerciseId,
        sets.map((set) => [set.weightKg, set.repsMin, set.repsMax]),
      ]),
    ).toEqual([
      [BENCH, [[60, 8, 10], [60, 8, 10], [60, 8, 10]]],
      [ROW, [[60, 8, 10], [60, 8, 10], [60, 8, 10]]],
    ]);
  });

  it("applies a program as a new folder of its routines in order", async () => {
    const database = await withOwnRoutine();
    const id = await propose(database, program);
    expect(await train(database)).toEqual([["none", ["My legs"]]]);
    await run(database, applyProposal(id));
    expect(await train(database)).toEqual([
      ["none", ["My legs"]],
      ["Three-day split", ["Day 1", "Day 2", "Day 3"]],
    ]);
  });

  it("creates nothing the second time it is applied", async () => {
    const database = openTestDatabase();
    const id = await propose(database, program);
    expect(await run(database, applyProposal(id))).toBe(true);
    expect(await run(database, applyProposal(id))).toBe(false);
    expect(await train(database)).toEqual([["Three-day split", ["Day 1", "Day 2", "Day 3"]]]);
  });

  it("is undone by deleting exactly what Apply created", async () => {
    const database = await withOwnRoutine();
    const routineId = await propose(database, upper);
    const programId = await propose(database, program);
    await run(database, applyProposal(routineId));
    await run(database, applyProposal(programId));

    await run(database, undoProposal(programId));
    expect(await train(database)).toEqual([["none", ["My legs", "Upper body"]]]);
    await run(database, undoProposal(routineId));
    expect(await train(database)).toEqual([["none", ["My legs"]]]);
    expect(await status(database, routineId)).toBe("undone");
    expect(await status(database, programId)).toBe("undone");
    expect(pointersToDeleted(database)).toEqual([]);
    const live = (table: string) =>
      database.database.prepare(`SELECT count(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get();
    expect(live("routine_set")).toEqual({ n: 3 });
    expect(live("folder")).toEqual({ n: 0 });
  });

  it("refuses Undo once the user changed what it created, and says why", async () => {
    const edits: ReadonlyArray<
      readonly [
        string,
        ProposalPlan,
        (
          routines: typeof RoutineRepository.Service,
          created: ReadonlyArray<string>,
        ) => Effect.Effect<unknown, unknown>,
      ]
    > = [
      [
        "a renamed routine",
        upper,
        (routines, [id]) => routines.updateRoutine(id as never, { title: "Upper A" }),
      ],
      [
        "a changed set",
        upper,
        (routines, [id]) =>
          Effect.flatMap(routines.getRoutine(id as never), (detail) =>
            routines.updateRoutineSet(Option.getOrThrow(detail).exercises[0]!.sets[0]!.id, {
              weightKg: 62.5,
            }),
          ),
      ],
      ["a deleted routine", upper, (routines, [id]) => routines.removeRoutine(id as never)],
      [
        "a routine moved out of the program's folder",
        program,
        (routines, [id]) => routines.moveRoutine(id as never, null),
      ],
      [
        "a routine of the user's moved into the program's folder",
        program,
        (routines, [id]) =>
          Effect.gen(function* () {
            const detail = Option.getOrThrow(yield* routines.getRoutine(id as never));
            const own = (yield* routines.listRoutines).find((row) => row.title === "My legs")!;
            yield* routines.moveRoutine(own.id, detail.routine.folderId);
          }),
      ],
    ];
    for (const [name, plan, edit] of edits) {
      const database = await withOwnRoutine();
      const id = await propose(database, plan);
      await run(database, applyProposal(id));
      const created = (await run(database, proposalView(id))).routineIds;
      await database.runtime.runPromise(database.clock.advance(1_000));
      await withRoutines(database, (routines) => edit(routines, created) as Effect.Effect<unknown>);
      const after = await train(database);

      const why = await failure(database, undoProposal(id));
      expect(why, name).toContain("after Apply, so Undo would throw your changes away");
      expect(await train(database), name).toEqual(after);
      expect(await status(database, id), name).toBe("applied");
    }
  });

  it("refuses Undo before Apply", async () => {
    const database = openTestDatabase();
    const id = await propose(database, upper);
    expect(await failure(database, undoProposal(id))).toContain(
      "Only an applied proposal can be undone",
    );
  });

  it("refuses Apply when an exercise it names was deleted since, and creates nothing", async () => {
    const database = openTestDatabase();
    const sled = await run(
      database,
      Effect.flatMap(Effect.service(ExerciseRepository), (exercises) =>
        exercises.create({
          name: "Sled push",
          category: "strongman",
          equipment: "other",
          primaryMuscles: ["quadriceps"],
          secondaryMuscles: [],
          origin: MADE_HERE,
        }),
      ),
    );
    const id = await propose(database, { kind: "routine", routine: routine("Sled day", sled) });
    await run(
      database,
      Effect.flatMap(Effect.service(ExerciseRepository), (exercises) => exercises.remove(sled)),
    );
    expect(await failure(database, applyProposal(id))).toContain("has been deleted since");
    expect(await train(database)).toEqual([["none", []]]);
    expect(await status(database, id)).toBe("pending");
  });

  it("stays linked to the coach message that asked for it", async () => {
    const database = openTestDatabase();
    const id = await propose(database, upper);
    const row = await run(
      database,
      Effect.flatMap(Effect.service(ProposalRepository), (proposals) => proposals.get(id)),
    );
    expect(Option.getOrThrow(row)).toMatchObject({
      origin: "coach",
      kind: "routine",
      title: "Upper body",
      status: "pending",
      coachMessageId: null,
    });
  });
});

describe("the pure proposal rules", () => {
  it("summarizes a routine and a program", () => {
    expect(planSummary(upper)).toBe("A routine of 2 exercises");
    expect(planSummary(program)).toBe("A program of 3 routines in a new folder");
  });

  it("names each exercise that is not known once", () => {
    expect(unknownExercises(program, new Set([BENCH]))).toEqual([ROW, SQUAT]);
    expect(unknownExercises(upper, new Set([BENCH, ROW]))).toEqual([]);
  });
});
