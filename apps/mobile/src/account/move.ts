import {
  ActivityRepository,
  ANONYMOUS,
  copyDatabase,
  databaseFileName,
  type MoveCounts,
  ownRowCount,
  shouldOfferMove,
  Sql,
} from "@svett/core";
import { Effect } from "effect";
import { deleteDatabaseAsync } from "expo-sqlite";
import Storage from "expo-sqlite/kv-store";

import { dataChanged } from "../data/current";
import { type DatabaseHandle, openDatabaseHandle } from "../data/database";

// The phone asks once. The answer is kept outside every owner's database, so it survives
// the anonymous database being moved away.
const ANSWER_KEY = "svett.moveOfferAnswer";

const withAnonymous = async <A>(use: (anonymous: DatabaseHandle) => Promise<A>) => {
  const anonymous = openDatabaseHandle({ kind: "owner", owner: ANONYMOUS });
  try {
    return await use(anonymous);
  } finally {
    await anonymous.close();
  }
};

/**
 * What the phone's own data holds, when svett should offer to move it now. Undefined when it
 * asked before or there is nothing to move.
 */
export const pendingMoveOffer = async (): Promise<MoveCounts | undefined> => {
  const alreadyAsked = Storage.getItemSync(ANSWER_KEY) !== null;
  if (alreadyAsked) return undefined;
  const { anonymousRows, counts } = await withAnonymous((anonymous) =>
    anonymous.runtime.runPromise(
      Effect.all({
        anonymousRows: Effect.flatMap(Effect.service(Sql), ownRowCount),
        counts: Effect.flatMap(
          Effect.service(ActivityRepository),
          (activities) => activities.counts,
        ),
      }),
    ),
  );
  return shouldOfferMove({ alreadyAsked, anonymousRows })
    ? { workouts: counts.activities, sets: counts.sets }
    : undefined;
};

/**
 * Copies every row of the anonymous database into `account`, with their IDs, then deletes the
 * anonymous file, so the data now belongs to the account alone.
 */
export const moveIntoAccount = async (account: DatabaseHandle) => {
  await withAnonymous(async (anonymous) => {
    const from = await anonymous.runtime.runPromise(Effect.service(Sql));
    await account.runtime.runPromise(
      Effect.flatMap(Effect.service(Sql), (to) => copyDatabase(from, to)),
    );
  });
  // The answer is saved last. A crash before the delete asks again, and copying the same rows
  // twice changes nothing. A crash after it finds nothing left to move.
  await deleteDatabaseAsync(databaseFileName(ANONYMOUS));
  Storage.setItemSync(ANSWER_KEY, "moved");
  dataChanged();
};

/** The account starts empty, and the phone's own data stays for when nobody is signed in. */
export const declineMove = () => Storage.setItemSync(ANSWER_KEY, "declined");
