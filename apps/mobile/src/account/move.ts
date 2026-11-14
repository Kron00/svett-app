import {
  ActivityRepository,
  type AccountId,
  ANONYMOUS,
  anonymousDataLocked,
  copyDatabase,
  databaseFileName,
  type DatabaseOwner,
  finishMove,
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
} from "../data/current";
import { type DatabaseRuntime, openDatabaseHandle } from "../data/database";
import { storedMoveJournal, storeMoveJournal } from "./journal";

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

const deleteAnonymous = async () => {
  // SQLite refuses to delete a file that is still open.
  await databasesClosed();
  const name = databaseFileName(ANONYMOUS);
  // Deleting a file that is gone fails, and a crash may have deleted it already. Opening it
  // first leaves an empty one to delete.
  await (await openDatabaseAsync(name)).closeAsync();
  await deleteDatabaseAsync(name);
};

// One move step at a time, so a launch's resume and the Account screen never copy at once.
let queue: Promise<unknown> = Promise.resolve();
const serially = <A>(task: () => Promise<A>) => {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
};

const steps: MoveSteps<unknown> = {
  read: Effect.sync(storedMoveJournal),
  record: (journal) =>
    Effect.sync(() => {
      storeMoveJournal(journal);
      reopenDatabase();
    }),
  copyInto: (account) => Effect.tryPromise(() => copyInto(account)),
  deleteAnonymous: Effect.tryPromise(deleteAnonymous),
};

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
 * before the copy, so a crash part way finishes into it at the next launch.
 */
export const moveIntoAccount = (account: AccountId) =>
  serially(async () => {
    try {
      await Effect.runPromise(startMove(steps, account));
    } finally {
      dataChanged();
    }
  });

/** Finishes a move a crash cut short, into the account it named, whoever is signed in now. */
export const resumeMove = () =>
  serially(async () => {
    if (!anonymousDataLocked(storedMoveJournal())) return;
    try {
      await Effect.runPromise(finishMove(steps));
    } finally {
      dataChanged();
    }
  });

/** The account starts empty, and the phone's own data stays for when nobody is signed in. */
export const declineMove = () => {
  if (storedMoveJournal() === undefined) storeMoveJournal({ state: "declined" });
};
