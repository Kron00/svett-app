import { Data, Effect, Option, Schema } from "effect";

import { AccountId } from "./owner.ts";

/**
 * What the phone did with its own data on the first sign-in. It lives outside every database,
 * so it survives the anonymous database being deleted. `copying` and `cleaning` name the
 * account the data is going to before any row moves, so a move cut short by a crash finishes
 * into that account and no other. `keeping` and `erasing` name an account deleted on the
 * server whose data is leaving the phone's account file, copied to the phone's own database
 * first when the person kept a copy.
 */
const SettledJournal = Schema.Union([
  Schema.Struct({ state: Schema.Literal("declined") }),
  Schema.Struct({ state: Schema.Literals(["copying", "cleaning", "moved"]), account: AccountId }),
  Schema.Struct({ state: Schema.Literals(["keeping", "erasing"]), account: AccountId }),
]);

/**
 * `deleting` is saved before the phone asks the server to delete `account`, with the choice to
 * keep a copy and the receipt sent with the request, so a crash or a lost answer still ends as
 * the person chose. `before` is the journal it replaced, put back if the server refuses.
 */
export const MoveJournal = Schema.Union([
  ...SettledJournal.members,
  Schema.Struct({
    state: Schema.Literal("deleting"),
    account: AccountId,
    keep: Schema.Boolean,
    receipt: Schema.String,
    before: Schema.NullOr(SettledJournal),
  }),
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
export const anonymousDataLocked = (journal: MoveJournal | undefined): boolean =>
  journal?.state === "deleting"
    ? anonymousDataLocked(journal.before ?? undefined)
    : journal?.state === "copying" || journal?.state === "cleaning" || journal?.state === "keeping";

/** The deleted account whose data is still leaving the phone, if any. Its file stays closed. */
export const leavingAccount = (journal: MoveJournal | undefined): AccountId | undefined =>
  journal?.state === "keeping" || journal?.state === "erasing" ? journal.account : undefined;

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

/** What leaving a deleted account does to the phone. Each step must be safe to run again. */
export interface LeaveSteps<E> {
  readonly read: Effect.Effect<MoveJournal | undefined, E>;
  readonly record: (journal: MoveJournal) => Effect.Effect<void, E>;
  /** Forgets the journal, so the next sign-in offers to move the phone's own data again. */
  readonly forget: Effect.Effect<void, E>;
  /** Copies every row of the account's database into the anonymous one, all or none. */
  readonly copyToAnonymous: (account: AccountId) => Effect.Effect<unknown, E>;
  /** Deletes the account's database, and succeeds when it is already gone. */
  readonly deleteAccountData: (account: AccountId) => Effect.Effect<void, E>;
}

/**
 * Runs whatever the journal says is left of leaving a deleted account. Run at every launch,
 * it finishes one a crash cut short. With nothing left it changes nothing.
 */
export const finishLeave = <E>(steps: LeaveSteps<E>) =>
  Effect.gen(function* () {
    const journal = yield* steps.read;
    if (journal?.state === "keeping") {
      yield* steps.copyToAnonymous(journal.account);
      yield* steps.record({ state: "erasing", account: journal.account });
    }
    if (journal?.state === "keeping" || journal?.state === "erasing") {
      yield* steps.deleteAccountData(journal.account);
      yield* steps.forget;
    }
    return yield* steps.read;
  });

/**
 * Takes a deleted account's data off the phone. With `keep` its rows become the phone's own,
 * with no account, as if they had been logged signed out. Without it they are erased. The
 * journal names the account first, so a crash part way finishes the same choice at launch.
 */
export const leaveAccount = <E>(steps: LeaveSteps<E>, account: AccountId, keep: boolean) =>
  Effect.gen(function* () {
    yield* steps.record({ state: keep ? "keeping" : "erasing", account });
    return yield* finishLeave(steps);
  });

/** What the server answered a request to delete the account. */
export type DeletionSent =
  | { readonly kind: "deleted" }
  /** The server answered, and did not delete the account. */
  | { readonly kind: "refused"; readonly problem: string }
  /** No answer says whether the server deleted it. */
  | { readonly kind: "unknown"; readonly problem: string }
  /** The server may have deleted the rows, but the sessions did not end, so send it again. */
  | { readonly kind: "unfinished"; readonly problem: string }
  /** The phone holds no session of the account, so the deletion was not sent. */
  | { readonly kind: "not_signed_in" };

/** What a deletion's receipt says when the phone asks the server about it. */
export type DeletionAsked = "deleted" | "not_deleted" | "unknown";

/** What deleting the account does, beside the journal. Each step must be safe to run again. */
export interface DeletionSteps<E> {
  readonly read: Effect.Effect<MoveJournal | undefined, E>;
  readonly record: (journal: MoveJournal) => Effect.Effect<void, E>;
  readonly forget: Effect.Effect<void, E>;
  /** The account the phone holds a session of now, if any. */
  readonly signedIn: Effect.Effect<AccountId | undefined, E>;
  /**
   * Asks the server to delete `account` with the deletion's receipt and the signed-in session,
   * which the server refuses when the session is another account's.
   */
  readonly send: (account: AccountId, receipt: string) => Effect.Effect<DeletionSent, E>;
  /** Asks the server whether it deleted an account with this receipt, with no session. */
  readonly ask: (receipt: string) => Effect.Effect<DeletionAsked, E>;
}

export type DeletionOutcome =
  | { readonly kind: "none" }
  /** The server deleted the account. Its data now leaves the phone as `keep` says. */
  | { readonly kind: "deleted"; readonly account: AccountId; readonly keep: boolean }
  | { readonly kind: "refused"; readonly problem: string }
  /** The deletion stays saved, and the next launch tries to finish it. */
  | { readonly kind: "pending"; readonly problem: string };

/** Why a deletion stays saved while the phone holds no session of its account. */
export const DELETION_NEEDS_SIGN_IN =
  "Sign in to the account you asked to delete, and svett finishes deleting it.";

/**
 * Finishes the deletion the journal holds. Run at every launch, it finishes one that a crash or
 * a lost answer cut short. It sends the deletion again, only with a session of the account the
 * journal names, which also finishes one whose sessions did not end. When that does not say
 * the account is gone, or the phone holds no session of it, it asks the server with the
 * receipt, as the deletion ends the session the request needs. A refusal puts the journal back
 * as it was only when the server says it deleted nothing. With nothing to finish it changes
 * nothing.
 */
export const finishDeletion = <E>(steps: DeletionSteps<E>) =>
  Effect.gen(function* () {
    const journal = yield* steps.read;
    if (journal?.state !== "deleting") return { kind: "none" } satisfies DeletionOutcome;
    const deleted = {
      kind: "deleted",
      account: journal.account,
      keep: journal.keep,
    } satisfies DeletionOutcome;
    const sent: DeletionSent =
      (yield* steps.signedIn) === journal.account
        ? yield* steps.send(journal.account, journal.receipt)
        : { kind: "not_signed_in" };
    if (sent.kind === "deleted") return deleted;
    const asked = yield* steps.ask(journal.receipt);
    // Sessions that did not end need the deletion sent again, so it stays saved.
    if (asked === "deleted" && sent.kind !== "unfinished") return deleted;
    if (asked === "not_deleted" && sent.kind === "refused") {
      yield* journal.before === null ? steps.forget : steps.record(journal.before);
      return { kind: "refused", problem: sent.problem } satisfies DeletionOutcome;
    }
    return {
      kind: "pending",
      problem: sent.kind === "not_signed_in" ? DELETION_NEEDS_SIGN_IN : sent.problem,
    } satisfies DeletionOutcome;
  });

/**
 * Deletes `account` on the server. The journal saves the deletion, the choice to keep a copy
 * and `receipt` before anything is sent. A deletion of the same account already saved keeps
 * its receipt and takes the new choice. Refused while a move, another deletion or the leaving
 * of a deleted account is unfinished.
 */
export const startDeletion = <E>(
  steps: DeletionSteps<E>,
  account: AccountId,
  keep: boolean,
  receipt: string,
) =>
  Effect.gen(function* () {
    const journal = yield* steps.read;
    if (journal?.state === "deleting" && journal.account !== account) {
      return {
        kind: "refused",
        problem: `svett is still deleting another account on this phone. ${DELETION_NEEDS_SIGN_IN}`,
      } satisfies DeletionOutcome;
    }
    if (
      journal?.state !== "deleting" &&
      (anonymousDataLocked(journal) || leavingAccount(journal) !== undefined)
    ) {
      return {
        kind: "refused",
        problem: "svett is still moving the data on this phone. Try again in a moment.",
      } satisfies DeletionOutcome;
    }
    yield* steps.record(
      journal?.state === "deleting"
        ? { ...journal, keep }
        : { state: "deleting", account, keep, receipt, before: journal ?? null },
    );
    return yield* finishDeletion(steps);
  });
