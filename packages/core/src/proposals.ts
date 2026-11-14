import { Data, Effect, Option, Schema } from "effect";

import { DurationSeconds } from "./duration.ts";
import { contentFingerprint } from "./ids.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { ExerciseRepository } from "./repositories/exercises.ts";
import { ProposalRepository } from "./repositories/records.ts";
import { type AppliedRows, RoutineRepository } from "./repositories/routines.ts";
import { endPosition } from "./routine-plan.ts";
import {
  type CoachMessageId,
  type ExerciseId,
  ExerciseId as ExerciseIdSchema,
  Fingerprint,
  FolderId,
  type Proposal,
  type ProposalId,
  type ProposalStatus,
  RoutineId,
  SetType,
} from "./schema.ts";
import { Sql } from "./sql.ts";

// A coach proposal is a plan for routines that nothing has written yet. Apply writes it through
// RoutineRepository and records what it made, so Undo can take back exactly those rows.

/** The most a proposal holds, so one answer can never flood the Train tab. */
export const PROPOSAL_LIMITS = {
  routines: 7,
  exercises: 20,
  sets: 10,
  title: 80,
  folder: 60,
  notes: 500,
} as const;

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProposedSet = Schema.Struct({
  setType: SetType,
  weightKg: Schema.NullOr(NonNegative),
  repsMin: Schema.NullOr(NonNegativeInt),
  repsMax: Schema.NullOr(NonNegativeInt),
  durationS: Schema.NullOr(DurationSeconds),
  distanceM: Schema.NullOr(NonNegative),
}).check(
  Schema.makeFilter(({ repsMin, repsMax }) =>
    repsMin === null || repsMax === null || repsMin <= repsMax
      ? undefined
      : "a rep range starts at or below its end",
  ),
);
export type ProposedSet = typeof ProposedSet.Type;

export const ProposedExercise = Schema.Struct({
  exerciseId: ExerciseIdSchema,
  restS: Schema.NullOr(DurationSeconds),
  notes: Schema.String,
  sets: Schema.Array(ProposedSet),
});
export type ProposedExercise = typeof ProposedExercise.Type;

export const ProposedRoutine = Schema.Struct({
  title: Schema.NonEmptyString,
  notes: Schema.String,
  exercises: Schema.Array(ProposedExercise),
});
export type ProposedRoutine = typeof ProposedRoutine.Type;

/** What a proposal would create: one routine, or a program as a folder of routines. */
export const ProposalPlan = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("routine"), routine: ProposedRoutine }),
  Schema.Struct({
    kind: Schema.Literal("program"),
    folder: Schema.NonEmptyString,
    routines: Schema.Array(ProposedRoutine),
  }),
]);
export type ProposalPlan = typeof ProposalPlan.Type;

/** The rows Apply created, and the fingerprint of them and every row below them as Apply left them. */
const Applied = Schema.Struct({
  folderId: Schema.NullOr(FolderId),
  routineIds: Schema.Array(RoutineId),
  written: Fingerprint,
});

/** A proposal row's payload: the plan, and once applied, what Apply created. */
export const ProposalPayload = Schema.Struct({
  plan: ProposalPlan,
  applied: Schema.NullOr(Applied),
});
export type ProposalPayload = typeof ProposalPayload.Type;

const decodePayload = Schema.decodeUnknownOption(ProposalPayload);
const encodePayload = Schema.encodeSync(ProposalPayload);

/** Apply or Undo could not do what was asked. `message` says why, for the user. */
export class ProposalError extends Data.TaggedError("ProposalError")<{
  readonly message: string;
}> {}

export const planRoutines = (plan: ProposalPlan): ReadonlyArray<ProposedRoutine> =>
  plan.kind === "routine" ? [plan.routine] : plan.routines;

/** The proposal's title: the routine's, or the program's folder name. */
export const planTitle = (plan: ProposalPlan): string =>
  plan.kind === "routine" ? plan.routine.title : plan.folder;

const count = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** What a proposal holds in a few words, such as "A routine of 3 exercises". */
export const planSummary = (plan: ProposalPlan): string =>
  plan.kind === "routine"
    ? `A routine of ${count(plan.routine.exercises.length, "exercise", "exercises")}`
    : `A program of ${count(plan.routines.length, "routine", "routines")} in a new folder`;

/** What a proposal's state means for the user. */
export const PROPOSAL_STATUS_TEXT: Readonly<Record<ProposalStatus, string>> = {
  pending: "Not applied. Nothing is saved until you tap Apply.",
  applied: "Applied. It is on the Train tab.",
  undone: "Undone. svett removed what Apply created.",
  dismissed: "Dismissed. Nothing was saved.",
};

/** The exercises a plan names that are not in `known`, each once, in order. */
export const unknownExercises = (
  plan: ProposalPlan,
  known: ReadonlySet<ExerciseId>,
): ReadonlyArray<ExerciseId> => [
  ...new Set(
    planRoutines(plan)
      .flatMap((routine) => routine.exercises.map((exercise) => exercise.exerciseId))
      .filter((id) => !known.has(id)),
  ),
];

/** The rows Apply left, in a fixed order, so any later change, delete or move shows. */
export const appliedFingerprint = (rows: AppliedRows): Fingerprint =>
  Fingerprint.make(
    contentFingerprint(
      Object.entries(rows).map(([table, list]) => [
        table,
        [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      ]),
    ),
  );

/** What the coach's chat and the preview show of a proposal. */
export interface ProposalView {
  readonly id: ProposalId;
  readonly status: ProposalStatus;
  readonly plan: ProposalPlan;
  /** Exercise names by ID. An exercise deleted since the proposal has none. */
  readonly names: ReadonlyMap<ExerciseId, string>;
  /** The routines Apply created, while they are there. */
  readonly routineIds: ReadonlyArray<RoutineId>;
}

const loadPayload = (proposal: Proposal) =>
  Option.match(decodePayload(proposal.payload), {
    onNone: () =>
      Effect.fail(
        new ProposalError({ message: "This proposal is damaged, so svett cannot show it." }),
      ),
    onSome: Effect.succeed,
  });

const findProposal = (id: ProposalId) =>
  Effect.gen(function* () {
    const found = yield* (yield* ProposalRepository).get(id);
    if (Option.isNone(found)) {
      return yield* new ProposalError({ message: "This proposal is no longer on the phone." });
    }
    return { proposal: found.value, payload: yield* loadPayload(found.value) };
  });

/** Stores a plan as a pending proposal from the coach, linked to the message that asked for it. */
export const createProposal = (plan: ProposalPlan, coachMessageId: CoachMessageId | null) =>
  Effect.flatMap(Effect.service(ProposalRepository), (proposals) =>
    proposals.create({
      origin: "coach",
      kind: plan.kind,
      title: planTitle(plan),
      payload: encodePayload({ plan, applied: null }),
      coachMessageId,
    }),
  );

export const proposalView = (id: ProposalId) =>
  Effect.gen(function* () {
    const { proposal, payload } = yield* findProposal(id);
    const ids = planRoutines(payload.plan).flatMap((routine) =>
      routine.exercises.map((exercise) => exercise.exerciseId),
    );
    return {
      id,
      status: proposal.status,
      plan: payload.plan,
      names: yield* (yield* ExerciseRepository).names(ids),
      routineIds:
        proposal.status === "applied" && payload.applied !== null ? payload.applied.routineIds : [],
    } satisfies ProposalView;
  });

const routineDraft = (routine: ProposedRoutine, folderId: FolderId | null, position: number) => ({
  folderId,
  title: routine.title,
  notes: routine.notes,
  position,
  exercises: routine.exercises.map((exercise) => ({
    exerciseId: exercise.exerciseId,
    supersetGroup: null,
    restS: exercise.restS,
    notes: exercise.notes,
    sets: exercise.sets,
  })),
});

/**
 * Creates what a pending proposal plans, in one transaction, and records what it created.
 * A proposal applied before is left as it is, so applying twice creates nothing the second time.
 * Gives back whether this call applied it.
 */
export const applyProposal = (id: ProposalId) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    return yield* sql.transaction(
      Effect.gen(function* () {
        const { proposal, payload } = yield* findProposal(id);
        if (proposal.status !== "pending") return false;
        const { plan } = payload;
        const exercises = yield* ExerciseRepository;
        const ids = planRoutines(plan).flatMap((routine) =>
          routine.exercises.map((exercise) => exercise.exerciseId),
        );
        const known = new Set((yield* exercises.names(ids)).keys());
        if (unknownExercises(plan, known).length > 0) {
          return yield* new ProposalError({
            message:
              "An exercise in this proposal has been deleted since, so svett cannot apply it. Ask the coach again.",
          });
        }
        const routines = yield* RoutineRepository;
        let folderId: FolderId | null = null;
        const routineIds: Array<RoutineId> = [];
        if (plan.kind === "program") {
          folderId = yield* routines.createFolder({
            name: plan.folder,
            position: endPosition(yield* routines.listFolders),
          });
          for (const [position, routine] of plan.routines.entries()) {
            routineIds.push(
              yield* routines.createRoutine(routineDraft(routine, folderId, position)),
            );
          }
        } else {
          const loose = (yield* routines.listRoutines).filter((row) => row.folderId === null);
          routineIds.push(
            yield* routines.createRoutine(routineDraft(plan.routine, null, endPosition(loose))),
          );
        }
        const written = appliedFingerprint(yield* routines.appliedRows(folderId, routineIds));
        yield* (yield* ProposalRepository).update(id, {
          status: "applied",
          payload: encodePayload({ plan, applied: { folderId, routineIds, written } }),
        });
        return true;
      }),
    );
  });

/**
 * Deletes exactly what Apply created. It is refused when anything Apply created, or anything
 * below or inside it, changed since, because Undo would throw that change away.
 */
export const undoProposal = (id: ProposalId) =>
  Effect.gen(function* () {
    const sql = yield* Sql;
    return yield* sql.transaction(
      Effect.gen(function* () {
        const { proposal, payload } = yield* findProposal(id);
        const { applied } = payload;
        if (proposal.status !== "applied" || applied === null) {
          return yield* new ProposalError({ message: "Only an applied proposal can be undone." });
        }
        const routines = yield* RoutineRepository;
        const now = appliedFingerprint(
          yield* routines.appliedRows(applied.folderId, applied.routineIds),
        );
        if (now !== applied.written) {
          const what = payload.plan.kind === "program" ? "this program" : "this routine";
          return yield* new ProposalError({
            message: `You changed ${what} on the Train tab after Apply, so Undo would throw your changes away. Delete it there if you no longer want it.`,
          });
        }
        // A workout started from one of these routines points at it, so deleting the routine
        // would leave that workout, in progress or finished, naming a deleted routine.
        const used = yield* (yield* ActivityRepository).countStartedFrom(applied.routineIds);
        if (used > 0) {
          const what =
            payload.plan.kind === "program" ? "a routine of this program" : "this routine";
          return yield* new ProposalError({
            message: `You started a workout from ${what} after Apply, so Undo would leave that workout pointing at a deleted routine. Delete the routine on the Train tab if you no longer want it.`,
          });
        }
        if (applied.folderId !== null) yield* routines.removeFolder(applied.folderId);
        else for (const routineId of applied.routineIds) yield* routines.removeRoutine(routineId);
        yield* (yield* ProposalRepository).update(id, { status: "undone" });
      }),
    );
  });
