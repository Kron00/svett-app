import {
  type AccountId,
  DELETION_NEEDS_SIGN_IN,
  type DeletionAsked,
  type DeletionOutcome,
  type DeletionSent,
  type DeletionSteps,
  finishDeletion,
  httpSocialApi,
  type SocialFailed,
  socialProblemMessage,
  startDeletion,
} from "@svett/core";
import { Effect } from "effect";

import { ownerOf } from "../data/current";
import { secureRandomBytes } from "../data/database";
import { forgetMoveJournal, storedMoveJournal, storeMoveJournal } from "./journal";
import { finishLeavingAccount, leaveDeletedAccount } from "./move";
import { resetSyncStatus, svettServer } from "./sync";

/** The phone's Clerk session as a deletion sees it. */
export interface Session {
  /** The signed-in account, read when the deletion is sent. */
  readonly signedIn: () => string | null | undefined;
  readonly token: () => Promise<string | null>;
  /** Forgets the session of the deleted account on the phone, when it is the one signed in. */
  readonly signOut: (account: AccountId) => Promise<unknown>;
}

export const PENDING_DELETION =
  "svett saved your choice, and finishes deleting your account the next time it opens.";

/** A new secret for one deletion, which only this phone knows. */
const newReceipt = () =>
  Array.from(secureRandomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sentOf = (error: SocialFailed): DeletionSent => {
  const problem = socialProblemMessage(error);
  switch (error.problem) {
    case "account_deleted":
      return { kind: "deleted" };
    case "wrong_account":
      return { kind: "not_signed_in" };
    case "session_end_failed":
      return { kind: "unfinished", problem };
    // The deletion ends the session, so a session that ended says nothing on its own.
    case "signed_out":
    case "offline":
    case "server":
    case "sign_in_unavailable":
    case "rate_limited":
      return { kind: "unknown", problem };
    default:
      return { kind: "refused", problem };
  }
};

const stepsFor = (session: Session): DeletionSteps<never> => {
  const api = httpSocialApi({ server: svettServer(), token: session.token, fetch });
  return {
    read: Effect.sync(storedMoveJournal),
    record: (journal) => Effect.sync(() => storeMoveJournal(journal)),
    forget: Effect.sync(forgetMoveJournal),
    signedIn: Effect.sync(() => {
      const owner = ownerOf(session.signedIn());
      return owner.kind === "account" ? owner.accountId : undefined;
    }),
    send: (account, receipt) =>
      api.deleteAccount(account, receipt).pipe(
        Effect.map((): DeletionSent => ({ kind: "deleted" })),
        Effect.catch((error) => Effect.succeed(sentOf(error))),
      ),
    ask: (receipt) =>
      api.deletionHappened(receipt).pipe(
        Effect.map(({ deleted }): DeletionAsked => (deleted ? "deleted" : "not_deleted")),
        Effect.orElseSucceed((): DeletionAsked => "unknown"),
      ),
  };
};

/** What the person sees once a deletion ran, or undefined once it is done. */
const settle = async (outcome: DeletionOutcome, session: Session) => {
  switch (outcome.kind) {
    case "none":
      return undefined;
    case "refused":
      return outcome.problem;
    case "pending":
      return outcome.problem === DELETION_NEEDS_SIGN_IN
        ? outcome.problem
        : `${outcome.problem} ${PENDING_DELETION}`;
    case "deleted":
      await leaveDeletedAccount(outcome.account, outcome.keep);
      return left(outcome.account, session);
  }
};

const left = async (account: AccountId, session: Session) => {
  resetSyncStatus();
  // Clerk ended the session on its side already, so this only forgets it on the phone.
  await session.signOut(account).catch(() => undefined);
  return undefined;
};

let turn: Promise<unknown> = Promise.resolve();
/** Runs deletions one at a time, so a press and the launch's finish never overlap. */
const oneAtATime = <A>(run: () => Promise<A>): Promise<A> => {
  const next = turn.then(run, run);
  turn = next.catch(() => undefined);
  return next;
};

/**
 * Deletes `account` on the server, which deletes every row it has there and ends every one of
 * its sessions, then takes its data off the phone: kept as the phone's own data with no account
 * when `keep`, erased otherwise. The choice is saved before the request is sent, so a crash or
 * a lost answer ends the same way at the next launch. An account the server already deleted,
 * from another phone, leaves the phone the same way. Gives back what went wrong, or undefined
 * once it is done. Nothing on the phone changes until the server deleted the account.
 */
export const deleteAccount = (
  account: AccountId,
  keep: boolean,
  session: Session,
): Promise<string | undefined> =>
  oneAtATime(async () =>
    settle(
      await Effect.runPromise(startDeletion(stepsFor(session), account, keep, newReceipt())),
      session,
    ),
  );

/**
 * Finishes a saved deletion that a crash or a lost answer cut short, and the taking of a
 * deleted account's data off the phone. Run at every launch and whenever someone signs in. A
 * deletion is sent again only with a session of the account it deletes. With another account
 * signed in, or none, the phone only asks the server about its receipt, and leaves whoever is
 * signed in as they were.
 */
export const finishPendingDeletion = (session: Session): Promise<string | undefined> =>
  oneAtATime(async () => {
    const leaving = await finishLeavingAccount();
    if (leaving !== undefined) return left(leaving, session);
    return settle(await Effect.runPromise(finishDeletion(stepsFor(session))), session);
  });

/** Whether a deletion of `account` is saved and not finished yet. */
export const deletionPending = (account: AccountId) => {
  const journal = storedMoveJournal();
  return journal?.state === "deleting" && journal.account === account;
};
