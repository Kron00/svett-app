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

import type { OpenDatabase } from "../data/current";
import { useOnFocus } from "../data/loaded";
import { readFrom, writeTo } from "../data/store";

/** What Apply or Undo came to: done, or the reason the user sees. */
export type ProposalOutcome =
  | { readonly done: true }
  | { readonly done: false; readonly why: string };

const shown = (error: ProposalError) =>
  Effect.succeed<ProposalOutcome>({ done: false, why: error.message });

/** A proposal with its exercise names, or null when a link names no proposal. */
export function useProposal(id: string) {
  const load = useCallback(
    (database: OpenDatabase): Promise<ProposalView | null> =>
      Schema.is(ProposalId)(id)
        ? readFrom(
            database,
            proposalView(id).pipe(Effect.catchTag("ProposalError", () => Effect.succeed(null))),
          )
        : Promise.resolve(null),
    [id],
  );
  return useOnFocus(load);
}

/**
 * Creates what the proposal plans in `database`, the one the preview was read from. Applying
 * an applied proposal again creates nothing. It refuses once someone signed in or out.
 */
export const apply = (database: OpenDatabase, id: ProposalId) =>
  writeTo(
    database,
    applyProposal(id).pipe(
      Effect.as<ProposalOutcome>({ done: true }),
      Effect.catchTag("ProposalError", shown),
    ),
  );

/** Deletes what Apply created in `database`, unless the user changed it since. */
export const undo = (database: OpenDatabase, id: ProposalId) =>
  writeTo(
    database,
    undoProposal(id).pipe(
      Effect.as<ProposalOutcome>({ done: true }),
      Effect.catchTag("ProposalError", shown),
    ),
  );
