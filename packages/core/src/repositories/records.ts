import { Context, Effect, Layer } from "effect";

import { Ids } from "../ids.ts";
import {
  type CoachMessage,
  CoachMessageId,
  type ConversationId,
  ConversationId as ConversationIdSchema,
  EpochMillis,
  type ImportBatchId,
  ImportBatchId as ImportBatchIdSchema,
  type ImportSource,
  type ImportStatus,
  type Measurement,
  MeasurementId,
  type MeasurementKind,
  type Proposal,
  ProposalId,
  type ProposalStatus,
} from "../schema.ts";
import { Sql } from "../sql.ts";
import {
  countRows,
  currentTime,
  insertRows,
  type Patch,
  RowNotFoundError,
  selectById,
  selectRows,
  softDeleteRows,
  TABLES,
  updateRow,
} from "../table.ts";
import { MADE_HERE, type Origin, provenance, rowId } from "./origin.ts";

const makeRunner = Effect.gen(function* () {
  const sql = yield* Sql;
  const ids = yield* Ids;
  return <A, E>(effect: Effect.Effect<A, E, Sql | Ids>) =>
    effect.pipe(Effect.provideService(Sql, sql), Effect.provideService(Ids, ids));
});

const removeById = (target: { readonly name: string }, id: string) =>
  Effect.gen(function* () {
    const removed = yield* softDeleteRows(target, "id = ?", [id], yield* currentTime);
    if (removed === 0) return yield* new RowNotFoundError({ table: target.name, id });
  });

export type MeasurementDraft = Pick<Measurement, "kind" | "measuredAt" | "value"> & {
  readonly origin: Origin;
};

const makeMeasurementRepository = Effect.gen(function* () {
  const run = yield* makeRunner;
  return {
    create: ({ origin, ...draft }: MeasurementDraft) =>
      run(
        Effect.gen(function* () {
          const id = MeasurementId.make(yield* rowId(TABLES.measurement, origin));
          yield* insertRows(TABLES.measurement, [
            { ...draft, ...provenance(origin), id, updatedAt: yield* currentTime, deletedAt: null },
          ]);
          return id;
        }),
      ),
    list: (kind?: MeasurementKind) =>
      run(
        kind === undefined
          ? selectRows(TABLES.measurement, "1 = 1", [], "measured_at, id")
          : selectRows(TABLES.measurement, "kind = ?", [kind], "measured_at, id"),
      ),
    update: (id: MeasurementId, patch: Pick<Patch<Measurement>, "measuredAt" | "value">) =>
      run(updateRow(TABLES.measurement, id, patch)),
    remove: (id: MeasurementId) => run(removeById(TABLES.measurement, id)),
    count: run(countRows(TABLES.measurement)),
  };
});

/** The only writer of the measurement table. */
export class MeasurementRepository extends Context.Service<
  MeasurementRepository,
  Effect.Success<typeof makeMeasurementRepository>
>()("svett/MeasurementRepository") {
  static readonly layer = Layer.effect(MeasurementRepository, makeMeasurementRepository);
}

const makeImportRepository = Effect.gen(function* () {
  const run = yield* makeRunner;
  return {
    create: (source: ImportSource) =>
      run(
        Effect.gen(function* () {
          const id = ImportBatchIdSchema.make(yield* rowId(TABLES.importBatch, MADE_HERE));
          const now = yield* currentTime;
          yield* insertRows(TABLES.importBatch, [
            { id, source, status: "previewed", createdAt: now, updatedAt: now, deletedAt: null },
          ]);
          return id;
        }),
      ),
    get: (id: ImportBatchId) => run(selectById(TABLES.importBatch, id)),
    list: run(selectRows(TABLES.importBatch, "1 = 1", [], "created_at DESC, id")),
    setStatus: (id: ImportBatchId, status: ImportStatus) =>
      run(updateRow(TABLES.importBatch, id, { status })),
    remove: (id: ImportBatchId) => run(removeById(TABLES.importBatch, id)),
  };
});

/** The only writer of import_batch. The imported rows themselves go through their own repository. */
export class ImportRepository extends Context.Service<
  ImportRepository,
  Effect.Success<typeof makeImportRepository>
>()("svett/ImportRepository") {
  static readonly layer = Layer.effect(ImportRepository, makeImportRepository);
}

export type ProposalDraft = Pick<
  Proposal,
  "origin" | "kind" | "title" | "payload" | "coachMessageId"
>;

const makeProposalRepository = Effect.gen(function* () {
  const run = yield* makeRunner;
  return {
    create: (draft: ProposalDraft) =>
      run(
        Effect.gen(function* () {
          const id = ProposalId.make(yield* rowId(TABLES.proposal, MADE_HERE));
          const now = yield* currentTime;
          yield* insertRows(TABLES.proposal, [
            { ...draft, id, status: "pending", createdAt: now, updatedAt: now, deletedAt: null },
          ]);
          return id;
        }),
      ),
    get: (id: ProposalId) => run(selectById(TABLES.proposal, id)),
    list: run(selectRows(TABLES.proposal, "1 = 1", [], "created_at DESC, id")),
    setStatus: (id: ProposalId, status: ProposalStatus) =>
      run(updateRow(TABLES.proposal, id, { status })),
    remove: (id: ProposalId) => run(removeById(TABLES.proposal, id)),
  };
});

/** The only writer of the proposal table. */
export class ProposalRepository extends Context.Service<
  ProposalRepository,
  Effect.Success<typeof makeProposalRepository>
>()("svett/ProposalRepository") {
  static readonly layer = Layer.effect(ProposalRepository, makeProposalRepository);
}

export type CoachMessageDraft = Pick<CoachMessage, "conversationId" | "role" | "content">;

const makeCoachMessageRepository = Effect.gen(function* () {
  const run = yield* makeRunner;
  return {
    /**
     * Adds a message after the conversation's last one. Its time is at least a millisecond after
     * the last message's, so messages written in the same millisecond keep their order.
     */
    append: (draft: CoachMessageDraft) =>
      run(
        Effect.gen(function* () {
          const sql = yield* Sql;
          return yield* sql.transaction(
            Effect.gen(function* () {
              const id = CoachMessageId.make(yield* rowId(TABLES.coachMessage, MADE_HERE));
              const now = yield* currentTime;
              const [last] = yield* sql.all(
                "SELECT max(created_at) AS at FROM coach_message WHERE conversation_id = ?",
                [draft.conversationId],
              );
              const after =
                last?.["at"] === null || last?.["at"] === undefined ? -1 : Number(last["at"]);
              const createdAt = EpochMillis.make(Math.max(now, after + 1));
              yield* insertRows(TABLES.coachMessage, [
                { ...draft, id, createdAt, updatedAt: now, deletedAt: null },
              ]);
              return id;
            }),
          );
        }),
      ),
    conversation: (conversationId: ConversationId) =>
      run(
        selectRows(TABLES.coachMessage, "conversation_id = ?", [conversationId], "created_at, id"),
      ),
    /** The conversation with the newest message, or null when there is none. */
    latestConversation: run(
      Effect.flatMap(Effect.service(Sql), (sql) =>
        Effect.map(
          sql.all(
            "SELECT conversation_id FROM coach_message WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1",
          ),
          (rows) =>
            rows[0] === undefined
              ? null
              : ConversationIdSchema.make(String(rows[0]["conversation_id"])),
        ),
      ),
    ),
    removeConversation: (conversationId: ConversationId) =>
      run(
        Effect.flatMap(currentTime, (at) =>
          softDeleteRows(TABLES.coachMessage, "conversation_id = ?", [conversationId], at),
        ),
      ),
  };
});

/** The only writer of coach_message. Coach chats stay on the phone. */
export class CoachMessageRepository extends Context.Service<
  CoachMessageRepository,
  Effect.Success<typeof makeCoachMessageRepository>
>()("svett/CoachMessageRepository") {
  static readonly layer = Layer.effect(CoachMessageRepository, makeCoachMessageRepository);
}
