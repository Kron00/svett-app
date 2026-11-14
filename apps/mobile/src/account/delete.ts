import { type AccountId, httpSocialApi, SocialFailed, socialProblemMessage } from "@svett/core";
import { Cause, Effect, Exit, Option } from "effect";

import { leaveDeletedAccount } from "./move";
import { resetSyncStatus, svettServer } from "./sync";

/**
 * Deletes `account` on the server, which deletes every row it has there and ends every one of
 * its sessions, then takes its data off the phone: kept as the phone's own data with no account
 * when `keep`, erased otherwise. An account the server already deleted, from another phone,
 * leaves the phone the same way. Gives back what went wrong, or undefined once it is done.
 * Nothing on the phone changes when the server did not delete the account.
 */
export const deleteAccount = async (
  account: AccountId,
  keep: boolean,
  token: () => Promise<string | null>,
  signOut: () => Promise<unknown>,
): Promise<string | undefined> => {
  const api = httpSocialApi({ server: svettServer(), token, fetch });
  const exit = await Effect.runPromiseExit(api.deleteAccount());
  if (Exit.isFailure(exit)) {
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (!(error instanceof SocialFailed)) return "Something went wrong. Nothing was deleted.";
    if (error.problem !== "account_deleted") return socialProblemMessage(error);
  }
  await leaveDeletedAccount(account, keep);
  resetSyncStatus();
  // Clerk ended the session on its side already, so this only forgets it on the phone.
  await signOut().catch(() => undefined);
  return undefined;
};
