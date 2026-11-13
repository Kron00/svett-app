import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { contentFingerprint } from "../ids.ts";
import { ConversationId, EpochMillis, Fingerprint, SourceIdentity } from "../schema.ts";
import { openTestDatabase, T0 } from "../test-database.ts";
import { MADE_HERE } from "./origin.ts";
import {
  CoachMessageRepository,
  ImportRepository,
  MeasurementRepository,
  ProposalRepository,
} from "./records.ts";

const day = (n: number) => EpochMillis.make(T0 + n * 86_400_000);

describe("MeasurementRepository", () => {
  it("creates, lists by kind, updates and deletes measurements", async () => {
    const { runtime } = openTestDatabase();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const measurements = yield* MeasurementRepository;
        const first = yield* measurements.create({
          kind: "body_weight",
          measuredAt: day(0),
          value: 82.4,
          origin: MADE_HERE,
        });
        yield* measurements.create({
          kind: "waist",
          measuredAt: day(0),
          value: 84,
          origin: MADE_HERE,
        });
        const second = yield* measurements.create({
          kind: "body_weight",
          measuredAt: day(7),
          value: 81.9,
          origin: MADE_HERE,
        });
        yield* measurements.update(first, { value: 82.1 });
        yield* measurements.remove(second);
        return {
          weights: (yield* measurements.list("body_weight")).map((m) => m.value),
          count: yield* measurements.count,
        };
      }),
    );
    expect(result).toEqual({ weights: [82.1], count: 2 });
  });

  it("refuses a value of zero", async () => {
    const { runtime } = openTestDatabase();
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(Effect.service(MeasurementRepository), (measurements) =>
        measurements.create({ kind: "body_fat", measuredAt: day(0), value: 0, origin: MADE_HERE }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("ImportRepository", () => {
  it("records a batch, its status, and the rows that name it", async () => {
    const { runtime } = openTestDatabase();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const imports = yield* ImportRepository;
        const measurements = yield* MeasurementRepository;
        const batch = yield* imports.create("hevy");
        yield* measurements.create({
          kind: "body_weight",
          measuredAt: day(1),
          value: 80,
          origin: {
            source: "hevy",
            sourceId: SourceIdentity.make("2026-01-02"),
            fingerprint: Fingerprint.make(contentFingerprint({ weight_kg: 80 })),
            importBatchId: batch,
          },
        });
        yield* imports.setStatus(batch, "applied");
        return {
          batch: Option.getOrThrow(yield* imports.get(batch)),
          imported: (yield* measurements.list()).map((m) => [m.source, m.importBatchId]),
        };
      }),
    );
    expect(result.batch).toMatchObject({ source: "hevy", status: "applied", createdAt: T0 });
    expect(result.imported).toEqual([["hevy", result.batch.id]]);
  });

  it("deletes a batch", async () => {
    const { runtime } = openTestDatabase();
    const listed = await runtime.runPromise(
      Effect.gen(function* () {
        const imports = yield* ImportRepository;
        yield* imports.remove(yield* imports.create("apple_health"));
        return yield* imports.list;
      }),
    );
    expect(listed).toEqual([]);
  });
});

describe("ProposalRepository", () => {
  it("keeps a proposal pending until it is applied, and deletes it", async () => {
    const { runtime } = openTestDatabase();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const proposals = yield* ProposalRepository;
        const id = yield* proposals.create({
          origin: "coach",
          kind: "routine",
          title: "Upper body",
          payload: { exercises: ["Barbell_Bench_Press_-_Medium_Grip"] },
          coachMessageId: null,
        });
        const pending = Option.getOrThrow(yield* proposals.get(id));
        yield* proposals.setStatus(id, "applied");
        const applied = Option.getOrThrow(yield* proposals.get(id));
        yield* proposals.remove(id);
        return { pending, applied, after: yield* proposals.list };
      }),
    );
    expect(result.pending).toMatchObject({
      status: "pending",
      payload: { exercises: ["Barbell_Bench_Press_-_Medium_Grip"] },
    });
    expect(result.applied.status).toBe("applied");
    expect(result.after).toEqual([]);
  });
});

describe("CoachMessageRepository", () => {
  it("keeps a conversation in order and deletes it as a whole", async () => {
    const { runtime, clock } = openTestDatabase();
    const conversationId = ConversationId.make("019b76da-a800-7000-8000-000000000001");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const messages = yield* CoachMessageRepository;
        yield* messages.append({ conversationId, role: "user", content: "Plan my week" });
        yield* clock.advance(1000);
        yield* messages.append({ conversationId, role: "assistant", content: "Here is a plan" });
        const before = (yield* messages.conversation(conversationId)).map((m) => m.role);
        yield* messages.removeConversation(conversationId);
        return { before, after: yield* messages.conversation(conversationId) };
      }),
    );
    expect(result).toEqual({ before: ["user", "assistant"], after: [] });
  });
});
