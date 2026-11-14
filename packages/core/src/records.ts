import { DurationSeconds, formatDuration } from "./duration.ts";
import {
  groupByWorkout,
  isWorkingSet,
  isLiftedSet,
  loadsBodyWeight,
  type PerformedSet,
} from "./performed-set.ts";
import type { ActivityId, ActivitySetId, EpochMillis, ExerciseId } from "./schema.ts";
import { formatWeightKg } from "./set-format.ts";

export const RECORD_KINDS = [
  "best_one_rep_max",
  "heaviest_weight",
  "best_set_volume",
  "most_reps",
  "longest_duration",
  "longest_distance",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export type RecordUnit = "kg" | "reps" | "duration" | "metres";

type SetValues = Pick<PerformedSet, "equipment" | "weightKg" | "reps" | "durationS" | "distanceM">;

export interface RecordRule {
  readonly label: string;
  readonly unit: RecordUnit;
  /** How the number is worked out, in words the app shows next to it. */
  readonly rule: string;
  /** The set's value for this record, or null when the set does not take part in it. */
  readonly valueOf: (set: SetValues) => number | null;
}

// Rounding to hundredths keeps 100 × (1 + 3 ÷ 30) = 110.00000000000001 from beating 110.
const hundredths = (value: number) => Math.round(value * 100) / 100;

const ONE_REP_MAX_MAX_REPS = 12;

const ADDED_WEIGHT = "On a bodyweight exercise it counts only the added weight.";

/**
 * Epley's estimate of the most weight lifted once: weight × (1 + reps ÷ 30).
 * A single counts as its weight. Past 12 reps the estimate drifts too far to
 * trust, so those sets give no estimate.
 */
export const estimatedOneRepMax = (weightKg: number, reps: number): number | null => {
  if (weightKg <= 0 || reps < 1 || reps > ONE_REP_MAX_MAX_REPS) return null;
  return reps === 1 ? weightKg : hundredths(weightKg * (1 + reps / 30));
};

export const RECORD_RULES: Readonly<Record<RecordKind, RecordRule>> = {
  best_one_rep_max: {
    label: "Estimated 1RM",
    unit: "kg",
    rule: "Weight × (1 + reps ÷ 30), Epley's formula, from sets of 1 to 12 reps. A single counts as its weight. Bodyweight exercises have none, because svett does not know your body weight at each set.",
    valueOf: (set) =>
      isLiftedSet(set) && !loadsBodyWeight(set)
        ? estimatedOneRepMax(set.weightKg ?? 0, set.reps ?? 0)
        : null,
  },
  heaviest_weight: {
    label: "Heaviest weight",
    unit: "kg",
    rule: `The most weight in one set of at least one rep. ${ADDED_WEIGHT}`,
    valueOf: (set) => (isLiftedSet(set) ? set.weightKg : null),
  },
  best_set_volume: {
    label: "Best set volume",
    unit: "kg",
    rule: `Weight × reps in one set. ${ADDED_WEIGHT}`,
    valueOf: (set) => (isLiftedSet(set) ? hundredths((set.weightKg ?? 0) * (set.reps ?? 0)) : null),
  },
  most_reps: {
    label: "Most reps",
    unit: "reps",
    rule: "The most reps in one set with no added weight.",
    valueOf: (set) =>
      (set.weightKg === null || set.weightKg === 0) && set.reps !== null && set.reps > 0
        ? set.reps
        : null,
  },
  longest_duration: {
    label: "Longest time",
    unit: "duration",
    rule: "The longest time in one set.",
    valueOf: (set) => (set.durationS !== null && set.durationS > 0 ? set.durationS : null),
  },
  longest_distance: {
    label: "Longest distance",
    unit: "metres",
    rule: "The longest distance in one set.",
    valueOf: (set) => (set.distanceM !== null && set.distanceM > 0 ? set.distanceM : null),
  },
};

/** The rule every record follows, shown with the records. */
export const RECORDS_RULE =
  "Warm-up sets never count. A workout's best set sets a record when it beats every earlier workout with that exercise. A tie is not a record. The first workout with an exercise sets the starting point.";

export const formatRecordValue = (unit: RecordUnit, value: number): string => {
  switch (unit) {
    case "kg":
      return `${formatWeightKg(value)} kg`;
    case "reps":
      return `${value} ${value === 1 ? "rep" : "reps"}`;
    case "duration":
      return formatDuration(DurationSeconds.make(value));
    case "metres":
      return value >= 1000 ? `${formatWeightKg(value / 1000)} km` : `${formatWeightKg(value)} m`;
  }
};

/** The best value an exercise has reached for one kind of record, and the set that reached it first. */
export interface PersonalBest {
  readonly kind: RecordKind;
  readonly exerciseId: ExerciseId;
  readonly activityId: ActivityId;
  readonly setId: ActivitySetId;
  readonly achievedAt: EpochMillis;
  readonly value: number;
}

/** A set that beat every earlier workout with its exercise. */
export interface PersonalRecord extends PersonalBest {
  readonly previous: number;
}

export interface RecordHistory {
  /** Each exercise's best for each kind of record it has a value for. */
  readonly bests: ReadonlyArray<PersonalBest>;
  /** Every record, oldest first. */
  readonly records: ReadonlyArray<PersonalRecord>;
}

/**
 * Finds every personal record in a history of sets, following RECORDS_RULE.
 * Within a workout the first of several equal best sets holds the record.
 */
export const personalRecords = (sets: ReadonlyArray<PerformedSet>): RecordHistory => {
  const chronological = [...sets].sort((a, b) => a.startedAt - b.startedAt);
  const bests = new Map<string, PersonalBest>();
  const records: Array<PersonalRecord> = [];

  for (const workout of groupByWorkout(chronological)) {
    const workoutBests = new Map<string, PersonalBest>();
    for (const set of workout) {
      if (!isWorkingSet(set)) continue;
      for (const kind of RECORD_KINDS) {
        const value = RECORD_RULES[kind].valueOf(set);
        if (value === null) continue;
        const key = `${set.exerciseId} ${kind}`;
        const current = workoutBests.get(key);
        if (current === undefined || value > current.value) {
          workoutBests.set(key, {
            kind,
            exerciseId: set.exerciseId,
            activityId: set.activityId,
            setId: set.setId,
            achievedAt: set.startedAt,
            value,
          });
        }
      }
    }
    for (const [key, best] of workoutBests) {
      const earlier = bests.get(key);
      if (earlier === undefined) {
        bests.set(key, best);
      } else if (best.value > earlier.value) {
        bests.set(key, best);
        records.push({ ...best, previous: earlier.value });
      }
    }
  }

  const order = (best: PersonalBest) => RECORD_KINDS.indexOf(best.kind);
  return {
    bests: [...bests.values()].sort(
      (a, b) => a.exerciseId.localeCompare(b.exerciseId) || order(a) - order(b),
    ),
    records,
  };
};

/**
 * The records one workout set, keyed by set ID, as personalRecords finds them,
 * so a workout's badges match its exercises' charts. `sets` holds the workout's
 * sets and the sets of every earlier workout with its exercises.
 */
export const workoutRecords = (
  sets: ReadonlyArray<PerformedSet>,
  activityId: ActivityId,
): ReadonlyMap<ActivitySetId, ReadonlyArray<RecordKind>> => {
  const kinds = new Map<ActivitySetId, Array<RecordKind>>();
  for (const record of personalRecords(sets).records) {
    if (record.activityId !== activityId) continue;
    kinds.set(record.setId, [...(kinds.get(record.setId) ?? []), record.kind]);
  }
  for (const each of kinds.values()) {
    each.sort((a, b) => RECORD_KINDS.indexOf(a) - RECORD_KINDS.indexOf(b));
  }
  return kinds;
};
