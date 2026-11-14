import { Schema } from "effect";

import {
  ActivityId,
  ActivitySetId,
  EpochMillis,
  Equipment,
  ExerciseId,
  SetType,
} from "./schema.ts";

/**
 * One logged strength set as progress reads it: what was done, for which
 * exercise, in which workout and when that workout started.
 */
export const PerformedSet = Schema.Struct({
  setId: ActivitySetId,
  activityId: ActivityId,
  exerciseId: ExerciseId,
  equipment: Equipment,
  startedAt: EpochMillis,
  setType: SetType,
  weightKg: Schema.NullOr(Schema.Finite),
  reps: Schema.NullOr(Schema.Int),
  durationS: Schema.NullOr(Schema.Finite),
  distanceM: Schema.NullOr(Schema.Finite),
});
export type PerformedSet = typeof PerformedSet.Type;

/** Warm-ups prepare for the work and never count towards records or volume. */
export const isWorkingSet = (set: Pick<PerformedSet, "setType">): boolean =>
  set.setType !== "warm_up";

/**
 * On an exercise done with body weight, such as a pull-up or a dip, a set's
 * weight is what was added to the body, not the whole load.
 */
export const loadsBodyWeight = (set: Pick<PerformedSet, "equipment">): boolean =>
  set.equipment === "none" || set.equipment === "suspension";

/** Groups sets by workout, keeping the order they arrive in. */
export const groupByWorkout = <S extends Pick<PerformedSet, "activityId">>(
  sets: ReadonlyArray<S>,
): ReadonlyArray<ReadonlyArray<S>> => {
  const groups = new Map<string, Array<S>>();
  for (const set of sets) {
    const group = groups.get(set.activityId);
    if (group) group.push(set);
    else groups.set(set.activityId, [set]);
  }
  return [...groups.values()];
};
