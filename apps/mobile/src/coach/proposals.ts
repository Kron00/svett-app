import {
  applyProposal,
  type ProposalError,
  ProposalId,
  type ProposalView,
  proposalView,
  undoProposal,
} from "@svett/core";
import { Effect, Schema } from "effect";
import { useCallback } from "react";

import { appDatabase } from "../data/database";
import { useOnFocus } from "../data/loaded";

/** What Apply or Undo came to: done, or the reason the user sees. */
export type ProposalOutcome =
  | { readonly done: true }
  | { readonly done: false; readonly why: string };

const shown = (error: ProposalError) =>
  Effect.succeed<ProposalOutcome>({ done: false, why: error.message });

/** A proposal with its exercise names, or null when a link names no proposal. */
export function useProposal(id: string) {
  const load = useCallback(
    (): Promise<ProposalView | null> =>
      Schema.is(ProposalId)(id)
        ? appDatabase().runPromise(
            proposalView(id).pipe(Effect.catchTag("ProposalError", () => Effect.succeed(null))),
          )
        : Promise.resolve(null),
    [id],
  );
  return useOnFocus(load);
}

/** Creates what the proposal plans. Applying an applied proposal again creates nothing. */
export const apply = (id: ProposalId) =>
  appDatabase().runPromise(
    applyProposal(id).pipe(
      Effect.as<ProposalOutcome>({ done: true }),
      Effect.catchTag("ProposalError", shown),
    ),
  );

/** Deletes what Apply created, unless the user changed it since. */
export const undo = (id: ProposalId) =>
  appDatabase().runPromise(
    undoProposal(id).pipe(
      Effect.as<ProposalOutcome>({ done: true }),
      Effect.catchTag("ProposalError", shown),
    ),
  );
