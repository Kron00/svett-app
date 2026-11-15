import {
  type AccountId,
  httpSocialApi,
  httpSyncApi,
  receiveAssistantProposals,
  SyncFailed,
  syncOnce,
  SyncRepository,
  type SyncStatus,
} from "@svett/core";
import { Cause, Effect, Exit, Option } from "effect";
import { Settings } from "react-native";
import { useSyncExternalStore } from "react";

import { currentDatabase, dataChanged, sameOwner, stillOpen } from "../data/current";
import { transferInTurn } from "../data/turns";

const DEFAULT_SERVER = "https://svett-app.jservers.net";

/**
 * The svett server. A proof run passes `-svettServer <url>` at launch, such as an address
 * nothing answers on, to keep the phone offline.
 */
export const svettServer = (): string => {
  const launched: unknown = Settings.get("svettServer");
  if (typeof launched === "string" && /^https?:\/\//.test(launched)) return launched;
  return process.env.EXPO_PUBLIC_SVETT_SERVER || DEFAULT_SERVER;
};

let status: SyncStatus = { kind: "waiting" };
const listeners = new Set<() => void>();
const show = (next: SyncStatus) => {
  status = next;
  for (const listener of listeners) listener();
};

export const useSyncStatus = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => status,
  );

type Token = () => Promise<string | null>;
let running: Promise<void> | undefined;
let last: { readonly accountId: AccountId; readonly token: Token } | undefined;

/**
 * Syncs the open database with the server, as `accountId`. It runs only when the open file is
 * that account's own, never the phone's data without an owner or a proof fixture, and it
 * takes its turn after any import, undo or move. A sync already running is joined.
 */
export const syncNow = (accountId: AccountId, token: Token): Promise<void> => {
  last = { accountId, token };
  running ??= transferInTurn(async () => {
    const open = currentDatabase();
    const owner = { kind: "account", accountId } as const;
    if (open.handle.target.kind !== "owner" || !sameOwner(open.handle.target.owner, owner)) {
      return;
    }
    show({ kind: "syncing" });
    const runtime = open.handle.runtime;
    const exit = await runtime.runPromiseExit(
      syncOnce(httpSyncApi({ server: svettServer(), accountId, token, fetch })),
    );
    const queued = await runtime.runPromise(
      Effect.flatMap(Effect.service(SyncRepository), (sync) => sync.queuedCount),
    );
    if (Exit.isSuccess(exit)) {
      show({ kind: "synced", queued, held: exit.value.held });
      // Proposals a connected app made come with each sync. One that fails comes next time.
      // Both requests are bound to the account this sync started for, so a session that has
      // since changed to another account neither takes nor clears that account's proposals.
      const taken = await runtime.runPromiseExit(
        receiveAssistantProposals(
          httpSocialApi({ server: svettServer(), accountId, token, fetch }).assistantProposals,
        ),
      );
      const proposed = Exit.isSuccess(taken) && taken.value > 0;
      // Only a sync that changed the open file makes screens read it again.
      if ((exit.value.pulled > 0 || proposed) && stillOpen(open)) dataChanged();
      return;
    }
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    show({
      kind: "failed",
      problem: error instanceof SyncFailed ? error.problem : "server",
      queued,
    });
  }).finally(() => {
    running = undefined;
  });
  return running;
};

/**
 * Syncs again as the account the last sync ran for, such as when the coach opens, so the
 * proposals a connected app made arrive. Nothing happens before the first sync.
 */
export const syncAgain = (): Promise<void> =>
  last === undefined ? Promise.resolve() : syncNow(last.accountId, last.token);

/** Forgets the last account's sync status, as signing out does. */
export const resetSyncStatus = () => {
  last = undefined;
  show({ kind: "waiting" });
};
