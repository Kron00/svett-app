import { Data, Effect, Option, Schema } from "effect";

import { AccountId } from "./database.ts";

/**
 * What the phone did with its own data on the first sign-in. It lives outside every database,
 * so it survives the anonymous database being deleted. `copying` and `cleaning` name the
 * account the data is going to before any row moves, so a move cut short by a crash finishes
 * into that account and no other.
 */
export const MoveJournal = Schema.Union([
  Schema.Struct({ state: Schema.Literal("declined") }),
  Schema.Struct({ state: Schema.Literals(["copying", "cleaning", "moved"]), account: AccountId }),
]);
export type MoveJournal = typeof MoveJournal.Type;

const MoveJournalJson = Schema.fromJsonString(MoveJournal);
const decodeJournal = Schema.decodeUnknownOption(MoveJournalJson);

/**
 * The journal as the phone stored it, or undefined when it never answered. Only svett writes
 * it, through `encodeMoveJournal`, so a value it cannot read counts as answered with nothing to
 * finish.
 */
export const decodeMoveJournal = (stored: string | null): MoveJournal | undefined =>
  stored === null
    ? undefined
    : Option.getOrElse(decodeJournal(stored), (): MoveJournal => ({ state: "declined" }));

export const encodeMoveJournal = Schema.encodeSync(MoveJournalJson);

/**
 * Whether the anonymous database must stay closed. From the moment a move names its account
 * until the anonymous file is gone, its rows already belong to that account, so nobody else
 * may see them, not even someone signed out.
 */
export const anonymousDataLocked = (journal: MoveJournal | undefined) =>
  journal?.state === "copying" || journal?.state === "cleaning";

export class MoveRefused extends Data.TaggedError("MoveRefused")<{
  readonly message: string;
}> {}

/** What a move does to the phone. Each step must be safe to run again after a crash. */
export interface MoveSteps<E> {
  readonly read: Effect.Effect<MoveJournal | undefined, E>;
  readonly record: (journal: MoveJournal) => Effect.Effect<void, E>;
  /** Copies every anonymous row into the account's database, all of them or none. */
  readonly copyInto: (account: AccountId) => Effect.Effect<unknown, E>;
  /** Deletes the anonymous database, and succeeds when it is already gone. */
  readonly deleteAnonymous: Effect.Effect<void, E>;
}

/**
 * Runs whatever the journal says is left of a move, into the account it names. Run at every
 * launch, it finishes a move a crash cut short. With nothing left it changes nothing.
 */
export const finishMove = <E>(steps: MoveSteps<E>) =>
  Effect.gen(function* () {
    const journal = yield* steps.read;
    if (journal?.state === "copying") {
      yield* steps.copyInto(journal.account);
      yield* steps.record({ state: "cleaning", account: journal.account });
    }
    if (journal?.state === "copying" || journal?.state === "cleaning") {
      yield* steps.deleteAnonymous;
      yield* steps.record({ state: "moved", account: journal.account });
    }
    return yield* steps.read;
  });

/**
 * Moves the phone's own data into `account`. The phone moves it once, so this is refused once
 * the offer has an answer, including a move into another account that has not finished.
 */
export const startMove = <E>(steps: MoveSteps<E>, account: AccountId) =>
  Effect.gen(function* () {
    const journal = yield* steps.read;
    if (journal !== undefined) {
      return yield* new MoveRefused({
        message:
          journal.state === "declined"
            ? "This phone's data was kept apart from every account."
            : "This phone's data already belongs to an account.",
      });
    }
    yield* steps.record({ state: "copying", account });
    return yield* finishMove(steps);
  });
