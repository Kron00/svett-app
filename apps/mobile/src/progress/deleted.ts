import { ActivityRepository, type ActivityId } from "@svett/core";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

import { currentDatabase, type OpenDatabase, stillOpen, subscribeDatabase } from "../data/current";
import { writeTo } from "../data/store";

export type DeletedWorkout = { readonly id: ActivityId; readonly title: string };

/** A deleted workout, with the database it was deleted from, where only its Undo may write. */
export type UndoableDelete = DeletedWorkout & { readonly database: OpenDatabase };

export const UNDO_SWITCHED =
  "Someone signed in or out since it was deleted, so svett brought nothing back.";

let deleted: UndoableDelete | null = null;
const listeners = new Set<() => void>();

const offer = (workout: UndoableDelete | null) => {
  deleted = workout;
  for (const listener of listeners) listener();
};

// Each account has its own database, so another one opening ends the offer.
subscribeDatabase(() => {
  if (deleted !== null && !stillOpen(deleted.database)) offer(null);
});

/** Closes the offer to bring the deleted workout back. */
export const closeDeletedWorkout = () => offer(null);

/** The workout just deleted, which history offers to bring back until the offer is closed. */
export const deletedWorkout = () => deleted;

export const useDeletedWorkout = (): UndoableDelete | null =>
  useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, deletedWorkout);

/** Deletes a workout and offers Undo at the bottom of history. */
export const deleteWorkout = async (workout: DeletedWorkout) => {
  const database = currentDatabase();
  await writeTo(
    database,
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.remove(workout.id),
    ),
  );
  if (!stillOpen(database)) return;
  offer({ ...workout, database });
  AccessibilityInfo.announceForAccessibility(
    `Deleted ${workout.title}. Undo is at the bottom of history.`,
  );
};

/**
 * Brings the deleted workout back with every exercise and set it had, into the database it was
 * deleted from. It refuses once another one is open, so it never writes into another account.
 */
export const undoDelete = async (workout: UndoableDelete) => {
  if (!stillOpen(workout.database)) {
    if (deleted === workout) offer(null);
    throw new Error(UNDO_SWITCHED);
  }
  await writeTo(
    workout.database,
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.restore(workout.id),
    ),
  );
  if (deleted === workout) offer(null);
};
