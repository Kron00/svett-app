import { ActivityRepository, type ActivityId } from "@svett/core";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

import { write } from "../data/store";

export type DeletedWorkout = { readonly id: ActivityId; readonly title: string };

let deleted: DeletedWorkout | null = null;
const listeners = new Set<() => void>();

/** The workout just deleted, which history offers to bring back until the offer is closed. */
export const setDeletedWorkout = (workout: DeletedWorkout | null) => {
  deleted = workout;
  for (const listener of listeners) listener();
};

export const useDeletedWorkout = (): DeletedWorkout | null =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => deleted,
  );

/** Deletes a workout and offers Undo at the bottom of history. */
export const deleteWorkout = async (workout: DeletedWorkout) => {
  await write(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.remove(workout.id),
    ),
  );
  setDeletedWorkout(workout);
  AccessibilityInfo.announceForAccessibility(
    `Deleted ${workout.title}. Undo is at the bottom of history.`,
  );
};

/** Brings the deleted workout back with every exercise and set it had. */
export const undoDelete = async (workout: DeletedWorkout) => {
  await write(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.restore(workout.id),
    ),
  );
  setDeletedWorkout(null);
};
