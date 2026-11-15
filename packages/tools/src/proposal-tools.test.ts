import {
  type CoachEvent,
  CoachMessageRepository,
  ConversationId,
  libraryExerciseId,
  PROPOSAL_LIMITS,
  ProposalId,
  ProposalRepository,
  proposalView,
  RoutineRepository,
} from "@svett/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { askCoach, chatEntries, type CoachTransport, toolsRequest } from "./coach.ts";
import { openEmptyDatabase } from "./fixture.ts";
import { COACH_TOOLS, PROPOSAL_TOOLS, runToolCall, type ToolResult } from "./tools.ts";

const NOW = Date.UTC(2026, 10, 13, 17);
const context = { offsetMinutes: -420 };
const BENCH = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");
const ROW = libraryExerciseId("Bent_Over_Barbell_Row");
const SQUAT = libraryExerciseId("Barbell_Squat");

type Database = ReturnType<typeof openEmptyDatabase>;

const run = <A, E>(database: Database, effect: Effect.Effect<A, E, any>) =>
  database.runtime.runPromise(effect as Effect.Effect<A, E, never>);

const call = (database: Database, name: string, input: unknown) =>
  run(
    database,
    runToolCall(name, typeof input === "string" ? input : JSON.stringify(input), context),
  );

const proposals = (database: Database) =>
  run(
    database,
    Effect.flatMap(Effect.service(ProposalRepository), (repository) => repository.list),
  );

const routineCount = (database: Database) =>
  run(
    database,
    Effect.map(
      Effect.flatMap(Effect.service(RoutineRepository), (routines) => routines.listRoutines),
      (rows) => rows.length,
    ),
  );

const routineIn = (title: string, ...ids: ReadonlyArray<string>) => ({
  title,
  exercises: ids.map((exerciseId) => ({
    exerciseId,
    sets: [{ weightKg: 60, repsMin: 8, repsMax: 10 }, { repsMin: 8 }],
    restSeconds: 90,
  })),
});

/** Checks the tool stored nothing, and gives back what the chat shows and the model reads. */
const refused = async (database: Database, result: ToolResult) => {
  expect(result.proposalId).toBeUndefined();
  expect(await proposals(database)).toEqual([]);
  expect(await routineCount(database)).toBe(0);
  return { problem: result.problem ?? "", error: JSON.parse(result.output).error as string };
};

describe("the proposal tools", () => {
  it("are the only tools besides the read tools, and only ever add a proposal", () => {
    expect(PROPOSAL_TOOLS.map((tool) => tool.name)).toEqual(["propose_routine", "propose_program"]);
    expect(
      COACH_TOOLS.filter((tool) => !PROPOSAL_TOOLS.includes(tool)).map((tool) => tool.name),
    ).toEqual([
      "search_exercises",
      "list_workouts",
      "get_workout",
      "best_sets",
      "exercise_history",
      "body_measurements",
      "list_routines",
    ]);
  });

  it("tell the model their limits in the parameters it reads", () => {
    const program = PROPOSAL_TOOLS[1]!.definition.parameters as any;
    expect(program.properties.routines).toMatchObject({
      minItems: 2,
      maxItems: PROPOSAL_LIMITS.routines,
    });
    expect(program.properties.routines.items.properties.exercises.maxItems).toBe(
      PROPOSAL_LIMITS.exercises,
    );
    expect(program.additionalProperties).toBe(false);
  });

  it("store a routine as a pending proposal and write no routine", async () => {
    const database = openEmptyDatabase(NOW);
    const result = await call(database, "propose_routine", routineIn("Upper", BENCH, ROW));
    expect(result.problem).toBeUndefined();
    expect(result.source).toBe('Proposed the routine "Upper"');
    const output = JSON.parse(result.output);
    expect(output.proposalId).toBe(result.proposalId);
    expect(output.shown).toContain("Nothing is saved until they tap Apply");
    expect(await routineCount(database)).toBe(0);

    const view = await run(database, proposalView(ProposalId.make(result.proposalId!)));
    expect(view.status).toBe("pending");
    expect(view.plan).toEqual({
      kind: "routine",
      routine: {
        title: "Upper",
        notes: "",
        exercises: [BENCH, ROW].map((exerciseId) => ({
          exerciseId,
          restS: 90,
          notes: "",
          sets: [
            {
              setType: "normal",
              weightKg: 60,
              repsMin: 8,
              repsMax: 10,
              durationS: null,
              distanceM: null,
            },
            // One rep count is an exact target, as the routine editor saves it.
            {
              setType: "normal",
              weightKg: null,
              repsMin: 8,
              repsMax: 8,
              durationS: null,
              distanceM: null,
            },
          ],
        })),
      },
    });
  });

  it("store a program of three routines as one proposal", async () => {
    const database = openEmptyDatabase(NOW);
    const result = await call(database, "propose_program", {
      folder: "Split",
      routines: [routineIn("A", BENCH), routineIn("B", ROW), routineIn("C", SQUAT)],
    });
    expect(result.source).toBe('Proposed the program "Split" of 3 routines');
    const view = await run(database, proposalView(ProposalId.make(result.proposalId!)));
    expect(view.plan.kind === "program" && view.plan.routines.map((each) => each.title)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(await routineCount(database)).toBe(0);
  });

  it("refuse arguments that do not match the schema and store nothing", async () => {
    const database = openEmptyDatabase(NOW);
    const names = await refused(
      database,
      await call(database, "propose_routine", {
        title: "Leg day",
        exercises: [{ name: "Squat", sets: 3, reps: 8 }],
      }),
    );
    expect(names.problem).toBe('Expected no excess property\n  at ["exercises"][0]["name"]');
    expect(names.error).toBe(names.problem);
    const notJson = await refused(database, await call(database, "propose_routine", "{title:"));
    expect(notJson.problem).toContain("JSON");
  });

  it("refuse exercises that are not in the user's library, naming them", async () => {
    const database = openEmptyDatabase(NOW);
    const unknown = "019a0000-0000-7000-8000-00000000beef";
    const { problem } = await refused(
      database,
      await call(database, "propose_routine", routineIn("Upper", BENCH, unknown)),
    );
    expect(problem).toBe(
      `no exercise has the id ${unknown}. Find exercise ids with search_exercises, then propose again`,
    );
  });

  it("refuse a program with too many routines", async () => {
    const database = openEmptyDatabase(NOW);
    const { problem } = await refused(
      database,
      await call(database, "propose_program", {
        folder: "Every day",
        routines: Array.from({ length: PROPOSAL_LIMITS.routines + 1 }, (_, day) =>
          routineIn(`Day ${day + 1}`, SQUAT),
        ),
      }),
    );
    expect(problem).toContain(`a program holds at most ${PROPOSAL_LIMITS.routines} routines`);
  });

  it("refuse a rep range that runs backwards", async () => {
    const database = openEmptyDatabase(NOW);
    const { problem } = await refused(
      database,
      await call(database, "propose_routine", {
        title: "Upper",
        exercises: [{ exerciseId: BENCH, sets: [{ repsMin: 12, repsMax: 8 }] }],
      }),
    );
    expect(problem).toBe("exercise 0 set 0 has repsMin above repsMax");
  });
});

/** A stand-in for Swift that answers each request in turn. */
const scripted = (answers: ReadonlyArray<ReadonlyArray<CoachEvent>>): CoachTransport => {
  let next = 0;
  return {
    send: (_, onEvent) =>
      Effect.sync(() => {
        const events = answers[next++] ?? [{ type: "failed", code: "nothing scripted" }];
        events.forEach(onEvent);
        return events;
      }),
  };
};

const callEvent = (name: string, args: unknown): ReadonlyArray<CoachEvent> => [
  {
    type: "toolCall",
    callId: `call_${name}`,
    name,
    namespace: "svett",
    arguments: JSON.stringify(args),
  },
  { type: "done" },
];
const textEvent = (text: string): ReadonlyArray<CoachEvent> => [
  { type: "text", delta: text },
  { type: "done" },
];

const askOnce = async (database: Database, answers: ReadonlyArray<ReadonlyArray<CoachEvent>>) => {
  const conversationId = ConversationId.make("019a0000-0000-7000-8000-000000000042");
  const proposed: Array<string> = [];
  const read: Array<string> = [];
  const outcome = await run(
    database,
    askCoach({
      conversationId,
      question: "Plan me something",
      transport: scripted(answers),
      offsetMinutes: context.offsetMinutes,
      hooks: { onProposal: (id) => proposed.push(id), onRead: (source) => read.push(source) },
    }),
  );
  const messages = await run(
    database,
    Effect.flatMap(Effect.service(CoachMessageRepository), (repository) =>
      repository.conversation(conversationId),
    ),
  );
  return { outcome, proposed, read, messages, entries: chatEntries(messages) };
};

describe("a coach answer that proposes", () => {
  it("offers both proposal tools in its request", () => {
    const request = toolsRequest([], NOW, context.offsetMinutes);
    expect(request.tools?.[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["propose_routine", "propose_program"]),
    );
    expect(request.instructions).toContain("never say it was saved");
  });

  it("shows the proposal under the answer, linked to the question, and not as data it read", async () => {
    const database = openEmptyDatabase(NOW);
    const asked = await askOnce(database, [
      callEvent("propose_routine", routineIn("Upper", BENCH)),
      textEvent("Here is a routine."),
    ]);
    expect(asked.outcome).toMatchObject({ type: "answered", sources: [] });
    expect(asked.read).toEqual([]);
    const [stored] = await proposals(database);
    expect(asked.proposed).toEqual([stored!.id]);
    expect(stored!.coachMessageId).toBe(asked.messages[0]!.id);
    expect(asked.entries.at(-1)).toMatchObject({
      role: "assistant",
      text: "Here is a routine.",
      sources: [],
      proposals: [stored!.id],
      problems: [],
    });
  });

  it("shows why a malformed proposal was refused, and keeps nothing of it", async () => {
    const database = openEmptyDatabase(NOW);
    const asked = await askOnce(database, [
      callEvent("propose_program", {
        folder: "Too much",
        routines: Array.from({ length: 8 }, (_, day) => routineIn(`Day ${day}`, SQUAT)),
      }),
      textEvent("That did not work."),
    ]);
    expect(asked.proposed).toEqual([]);
    expect(await proposals(database)).toEqual([]);
    expect(asked.entries.at(-1)).toMatchObject({ sources: [], proposals: [] });
    expect(asked.entries.at(-1)!.problems).toEqual([
      expect.stringContaining("a program holds at most 7 routines"),
    ]);
  });

  it("keeps what a question proposed when it got no answer", async () => {
    const database = openEmptyDatabase(NOW);
    const asked = await askOnce(database, [
      callEvent("propose_routine", routineIn("Upper", BENCH)),
      [{ type: "failed", code: "unreachable" }],
    ]);
    expect(asked.outcome.type).toBe("failed");
    expect(asked.entries).toHaveLength(1);
    expect(asked.entries[0]!.proposals).toHaveLength(1);
  });
});
