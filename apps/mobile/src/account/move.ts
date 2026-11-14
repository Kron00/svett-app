import {
  ActivityRepository,
  type AccountId,
  ANONYMOUS,
  anonymousDataLocked,
  copyDatabase,
  databaseFileName,
  type DatabaseOwner,
  finishLeave,
  finishMove,
  type LeaveSteps,
  leaveAccount,
  leavingAccount,
  type MoveCounts,
  type MoveSteps,
  ownRowCount,
  shouldOfferMove,
  Sql,
  startMove,
} from "@svett/core";
import { Effect } from "effect";
import { deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";

import {
  currentDatabase,
  databasesClosed,
  dataChanged,
  reopenDatabase,
  sameOwner,
  switchOwner,
} from "../data/current";
import { type DatabaseRuntime, openDatabaseHandle } from "../data/database";
import { inTurn } from "../data/turns";
import { forgetMoveJournal, storedMoveJournal, storeMoveJournal } from "./journal";

/** Runs `use` on the database of `owner`, sharing the open one when it is that owner's. */
const withDatabase = async <A>(
  owner: DatabaseOwner,
  use: (runtime: DatabaseRuntime) => Promise<A>,
) => {
  const open = currentDatabase().handle;
  if (open.target.kind === "owner" && sameOwner(open.target.owner, owner)) {
    return use(open.runtime);
  }
  const handle = openDatabaseHandle({ kind: "owner", owner });
  try {
    return await use(handle.runtime);
  } finally {
    await handle.close();
  }
};

const sqlOf = (runtime: DatabaseRuntime) => runtime.runPromise(Effect.service(Sql));

const copyInto = (account: AccountId) =>
  withDatabase(ANONYMOUS, async (anonymous) => {
    const from = await sqlOf(anonymous);
    return withDatabase({ kind: "account", accountId: account }, (to) =>
      to.runPromise(Effect.flatMap(Effect.service(Sql), (into) => copyDatabase(from, into))),
    );
  });

const deleteDatabaseOf = async (owner: DatabaseOwner) => {
  // SQLite refuses to delete a file that is still open.
  await databasesClosed();
  const name = databaseFileName(owner);
  // Deleting a file that is gone fails, and a crash may have deleted it already. Opening it
  // first leaves an empty one to delete.
  await (await openDatabaseAsync(name)).closeAsync();
  await deleteDatabaseAsync(name);
};

const steps: MoveSteps<unknown> = {
  read: Effect.sync(storedMoveJournal),
  record: (journal) =>
    Effect.sync(() => {
      storeMoveJournal(journal);
      reopenDatabase();
    }),
  copyInto: (account) => Effect.tryPromise(() => copyInto(account)),
  deleteAnonymous: Effect.tryPromise(() => deleteDatabaseOf(ANONYMOUS)),
};

const copyOut = (account: AccountId) =>
  withDatabase({ kind: "account", accountId: account }, async (from) => {
    const rows = await sqlOf(from);
    return withDatabase(ANONYMOUS, (to) =>
      to.runPromise(Effect.flatMap(Effect.service(Sql), (into) => copyDatabase(rows, into))),
    );
  });

const leaveSteps: LeaveSteps<unknown> = {
  read: Effect.sync(storedMoveJournal),
  record: (journal) =>
    Effect.sync(() => {
      storeMoveJournal(journal);
      reopenDatabase();
    }),
  forget: Effect.sync(() => {
    forgetMoveJournal();
    reopenDatabase();
  }),
  copyToAnonymous: (account) => Effect.tryPromise(() => copyOut(account)),
  deleteAccountData: (account) =>
    Effect.tryPromise(() => deleteDatabaseOf({ kind: "account", accountId: account })),
};

/**
 * Takes a deleted account's data off the phone, once the server deleted the account. The
 * phone's own database opens first, so the account's file is closed. With `keep` the
 * account's rows join the phone's own data, with no account. Without it they are erased.
 */
export const leaveDeletedAccount = (account: AccountId, keep: boolean) =>
  inTurn(async () => {
    try {
      switchOwner(ANONYMOUS);
      await Effect.runPromise(leaveAccount(leaveSteps, account, keep));
    } finally {
      dataChanged();
    }
  });

/**
 * What the phone's own data holds, when svett should offer to move it now. Undefined when it
 * asked before or there is nothing to move.
 */
export const pendingMoveOffer = async (): Promise<MoveCounts | undefined> => {
  if (storedMoveJournal() !== undefined) return undefined;
  const { anonymousRows, counts } = await withDatabase(ANONYMOUS, (anonymous) =>
    anonymous.runPromise(
      Effect.all({
        anonymousRows: Effect.flatMap(Effect.service(Sql), ownRowCount),
        counts: Effect.flatMap(
          Effect.service(ActivityRepository),
          (activities) => activities.counts,
        ),
      }),
    ),
  );
  return shouldOfferMove({ alreadyAsked: false, anonymousRows })
    ? { workouts: counts.activities, sets: counts.sets }
    : undefined;
};

/**
 * Moves every row of the anonymous database into `account`, with their IDs, then deletes the
 * anonymous file, so the data belongs to the account alone. The journal names the account
 * before the copy, so a crash part way finishes into it at the next launch. Each move waits for
 * an import or undo being applied, and for a launch's resume, so no two copy at once.
 */
export const moveIntoAccount = (account: AccountId) =>
  inTurn(async () => {
    try {
      await Effect.runPromise(startMove(steps, account));
    } finally {
      dataChanged();
    }
  });

/**
 * Finishes a move a crash cut short, into the account it named, whoever is signed in now, or
 * the keeping or erasing of a deleted account's data.
 */
export const resumeMove = () =>
  inTurn(async () => {
    const journal = storedMoveJournal();
    const leaving = leavingAccount(journal) !== undefined;
    if (!leaving && !anonymousDataLocked(journal)) return;
    try {
      await Effect.runPromise(leaving ? finishLeave(leaveSteps) : finishMove(steps));
    } finally {
      dataChanged();
    }
  });

/** The account starts empty, and the phone's own data stays for when nobody is signed in. */
export const declineMove = () => {
  if (storedMoveJournal() === undefined) storeMoveJournal({ state: "declined" });
};
