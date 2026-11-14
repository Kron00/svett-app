// Writes the coach's stand-in fixtures: what OpenAI would stream for "What was my best squat set
// last month?" against the generated 300-workout database, a plan-limit answer, and three
// proposals: a routine, a three-routine program, and a malformed routine svett refuses. The streams
// use the event shapes OpenAI documents for the Responses API. The requests are the ones svett's
// coach really builds, because the coach runs against a scripted model here.
//
// A live run, scripts/sim/coach.sh --live, records the same exchange from OpenAI and replaces
// the stand-in. Usage: pnpm coach-stand-in
import { writeFileSync } from "node:fs";

import {
  type CoachEvent,
  type InputItem,
  libraryExerciseId,
  PLAN_LIMIT_CODE,
  type ResponsesRequest,
} from "@svett/core";
import { askCoach, type CoachTransport } from "@svett/tools";
import {
  type CoachExchange,
  type CoachFixture,
  FIXTURE_CONVERSATION,
  openFixtureDatabase,
} from "@svett/tools/node";
import { Effect } from "effect";

/** The day the stand-in was made, so "last month" is October 2026. */
export const STAND_IN_NOW = Date.UTC(2026, 10, 13, 17);
/** Mountain Standard Time, where svett's simulator runs. */
export const STAND_IN_OFFSET = -420;
export const STAND_IN_QUESTION = "What was my best squat set last month?";

const fixtures = new URL("../packages/tools/fixtures/", import.meta.url).pathname;

type Turn =
  | { readonly kind: "call"; readonly name: string; readonly arguments: string }
  | { readonly kind: "text"; readonly text: string };

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events
    .map((event, sequence) => {
      const data = { ...event, sequence_number: sequence };
      return `event: ${String(event["type"])}\ndata: ${JSON.stringify(data)}\n\n`;
    })
    .join("");

const chunks = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
    text.slice(index * size, (index + 1) * size),
  );

/** The stream OpenAI documents for one response, and the events Swift sends JavaScript for it. */
const streamOf = (turn: Turn, number: number): { body: string; events: Array<CoachEvent> } => {
  const response = { id: `resp_stand_in_${number}`, object: "response", model: "gpt-6.1-sol" };
  const created = {
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  };
  if (turn.kind === "call") {
    const item = {
      type: "function_call",
      id: `fc_stand_in_${number}`,
      call_id: `call_stand_in_${number}`,
      namespace: "svett",
      name: turn.name,
    };
    const done = { ...item, arguments: turn.arguments, status: "completed" };
    return {
      body: sse([
        created,
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, arguments: "", status: "in_progress" },
        },
        ...chunks(turn.arguments, 12).map((delta) => ({
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta,
        })),
        {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          arguments: turn.arguments,
        },
        { type: "response.output_item.done", output_index: 0, item: done },
        {
          type: "response.completed",
          response: { ...response, status: "completed", output: [done] },
        },
      ]),
      events: [
        { type: "started" },
        {
          type: "toolCall",
          callId: item.call_id,
          name: item.name,
          namespace: "svett",
          arguments: turn.arguments,
        },
        { type: "done" },
      ],
    };
  }
  const id = `msg_stand_in_${number}`;
  const part = { type: "output_text", text: turn.text, annotations: [] };
  const message = { type: "message", id, role: "assistant", status: "completed", content: [part] };
  const deltas = chunks(turn.text, 9);
  return {
    body: sse([
      created,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: id,
        output_index: 0,
        content_index: 0,
        part: { ...part, text: "" },
      },
      ...deltas.map((delta) => ({
        type: "response.output_text.delta",
        item_id: id,
        output_index: 0,
        content_index: 0,
        delta,
        logprobs: [],
      })),
      {
        type: "response.output_text.done",
        item_id: id,
        output_index: 0,
        content_index: 0,
        text: turn.text,
        logprobs: [],
      },
      { type: "response.content_part.done", item_id: id, output_index: 0, content_index: 0, part },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: { ...response, status: "completed", output: [message] },
      },
    ]),
    events: [
      { type: "started" },
      ...deltas.map((delta) => ({ type: "text" as const, delta })),
      { type: "done" },
    ],
  };
};

const lastOutput = (request: ResponsesRequest): unknown => {
  const item = request.input.at(-1) as InputItem | undefined;
  return item?.type === "function_call_output" ? JSON.parse(item.output) : undefined;
};

/** What a model that reads the data first would do for the stand-in question. */
const scriptedTurn = (request: ResponsesRequest, number: number): Turn => {
  if (number === 1) {
    return {
      kind: "call",
      name: "search_exercises",
      arguments: JSON.stringify({ query: "squat", limit: 3 }),
    };
  }
  if (number === 2) {
    const found = lastOutput(request) as { exercises: Array<{ id: string }> };
    return {
      kind: "call",
      name: "best_sets",
      arguments: JSON.stringify({
        exerciseId: found.exercises[0]!.id,
        from: "2026-10-01",
        to: "2026-10-31",
        limit: 3,
      }),
    };
  }
  const read = lastOutput(request) as {
    exercise: string;
    best: Array<{
      day: string;
      workout: { userWritten: string };
      weightKg: number;
      reps: number;
    }>;
  };
  const best = read.best[0]!;
  return {
    kind: "text",
    text: `Your best squat set last month was ${best.weightKg} kg for ${best.reps} reps, on ${best.day} in your ${best.workout.userWritten} workout. That was your ${read.exercise}.`,
  };
};

const record = async (
  name: string,
  answer: (request: ResponsesRequest, number: number) => Omit<CoachExchange, "request">,
  question = STAND_IN_QUESTION,
) => {
  const { runtime } = await openFixtureDatabase(STAND_IN_NOW);
  const exchanges: Array<CoachExchange> = [];
  const transport: CoachTransport = {
    send: (request, onEvent) =>
      Effect.sync(() => {
        const exchange = { request, ...answer(request, exchanges.length + 1) };
        exchanges.push(exchange);
        exchange.events.forEach(onEvent);
        return exchange.events;
      }),
  };
  const outcome = await runtime.runPromise(
    askCoach({
      conversationId: FIXTURE_CONVERSATION,
      question,
      transport,
      offsetMinutes: STAND_IN_OFFSET,
    }),
  );
  await runtime.dispose();
  const fixture: CoachFixture = { source: "stand-in", recordedAt: STAND_IN_NOW, exchanges };
  writeFileSync(`${fixtures}${name}`, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${name}: ${exchanges.length} requests, ${outcome.type}`);
};

const PLAN_LIMIT_BODY = JSON.stringify({
  error: {
    message: "You have reached your ChatGPT plan's usage limit for this app.",
    type: "invalid_request_error",
    param: null,
    code: PLAN_LIMIT_CODE,
  },
});

/** The questions the proposal stand-ins answer. scripts/sim/proposals.sh asks them by link. */
export const ROUTINE_QUESTION = "Plan an upper body routine for me";
export const PROGRAM_QUESTION = "Plan a three-day push, pull and legs program for me";
export const MALFORMED_QUESTION = "Plan a leg day for me";

const sets = (count: number, weightKg: number, repsMin: number, repsMax: number) =>
  Array.from({ length: count }, () => ({ weightKg, repsMin, repsMax }));

const exercise = (libraryId: string, set: ReturnType<typeof sets>, restSeconds = 120) => ({
  exerciseId: libraryExerciseId(libraryId),
  sets: set,
  restSeconds,
});

/** A model that proposes once and then says what it proposed. */
const proposing =
  (name: string, args: unknown, text: string) =>
  (_: ResponsesRequest, number: number): Omit<CoachExchange, "request"> => {
    const turn: Turn =
      number === 1
        ? { kind: "call", name, arguments: JSON.stringify(args) }
        : { kind: "text", text };
    return { status: 200, ...streamOf(turn, number) };
  };

if (import.meta.main) {
  await record("coach-best-squat.json", (request, number) => {
    const { body, events } = streamOf(scriptedTurn(request, number), number);
    return { status: 200, body, events };
  });
  await record("coach-plan-limit.json", () => ({
    status: 429,
    body: PLAN_LIMIT_BODY,
    events: [{ type: "failed", code: PLAN_LIMIT_CODE, status: 429 }],
  }));
  await record(
    "coach-propose-routine.json",
    proposing(
      "propose_routine",
      {
        title: "Upper body strength",
        notes: "Heavy presses and rows, twice a week.",
        exercises: [
          exercise("Barbell_Bench_Press_-_Medium_Grip", sets(3, 80, 6, 8), 180),
          exercise("Bent_Over_Barbell_Row", sets(3, 60, 8, 10)),
          exercise("Standing_Military_Press", sets(3, 40, 8, 10)),
        ],
      },
      "Here is an upper body routine: bench press, barbell rows and overhead press, three sets each. Preview it below, and tap Apply to add it to Train.",
    ),
    ROUTINE_QUESTION,
  );
  await record(
    "coach-propose-program.json",
    proposing(
      "propose_program",
      {
        folder: "Coach 3-day split",
        routines: [
          {
            title: "Day 1 Push",
            exercises: [
              exercise("Barbell_Bench_Press_-_Medium_Grip", sets(3, 80, 6, 8), 180),
              exercise("Standing_Military_Press", sets(3, 40, 8, 10)),
              exercise("Dips_-_Triceps_Version", sets(3, 0, 8, 12), 90),
            ],
          },
          {
            title: "Day 2 Pull",
            exercises: [
              exercise("Barbell_Deadlift", sets(3, 140, 5, 5), 180),
              exercise("Pullups", sets(3, 0, 6, 10)),
              exercise("Seated_Cable_Rows", sets(3, 55, 10, 12), 90),
            ],
          },
          {
            title: "Day 3 Legs",
            exercises: [
              exercise("Barbell_Squat", sets(3, 110, 5, 8), 180),
              exercise("Romanian_Deadlift", sets(3, 90, 8, 10)),
              exercise("Lying_Leg_Curls", sets(3, 40, 10, 12), 90),
            ],
          },
        ],
      },
      "Here is a three-day program: push, pull and legs, in a new folder. Preview it below, and tap Apply to add all three routines to Train.",
    ),
    PROGRAM_QUESTION,
  );
  // Names instead of exercise ids, which the tool's schema refuses before anything is stored.
  await record(
    "coach-propose-malformed.json",
    proposing(
      "propose_routine",
      {
        title: "Leg day",
        exercises: [{ name: "Squat", sets: 3, reps: 8 }],
      },
      "That routine did not go through, so there is nothing to apply. Ask me again and I will draft it once more.",
    ),
    MALFORMED_QUESTION,
  );
}
