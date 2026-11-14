import { isWorkingSet, type PerformedSet } from "./performed-set.ts";
import { addWeeks } from "./progress-dates.ts";
import { Muscle, type ExerciseId } from "./schema.ts";
import { MUSCLE_LABEL } from "./exercise-format.ts";

export const isMuscle = (value: unknown): value is Muscle =>
  Muscle.literals.some((muscle) => muscle === value);

/** The rule behind every weekly set count, shown with the counts. */
export const MUSCLE_SET_RULE =
  "Each set counts 1 for every primary muscle of its exercise and ½ for every secondary muscle. Warm-up sets do not count. Weeks start on Monday.";

export interface ExerciseMuscles {
  readonly primaryMuscles: ReadonlyArray<Muscle>;
  readonly secondaryMuscles: ReadonlyArray<Muscle>;
}

export interface MuscleSets {
  readonly muscle: Muscle;
  /** primarySets + secondarySets ÷ 2. */
  readonly sets: number;
  readonly primarySets: number;
  readonly secondarySets: number;
}

/**
 * Counts sets per muscle following MUSCLE_SET_RULE, most sets first. A muscle
 * listed as both primary and secondary of one exercise counts as primary only.
 * Sets of an exercise `musclesOf` does not know count for no muscle.
 */
export const muscleSets = (
  sets: ReadonlyArray<PerformedSet>,
  musclesOf: (exerciseId: ExerciseId) => ExerciseMuscles | undefined,
): ReadonlyArray<MuscleSets> => {
  const counts = new Map<Muscle, { primarySets: number; secondarySets: number }>();
  const count = (muscle: Muscle) => {
    const found = counts.get(muscle);
    if (found) return found;
    const created = { primarySets: 0, secondarySets: 0 };
    counts.set(muscle, created);
    return created;
  };
  for (const set of sets) {
    if (!isWorkingSet(set)) continue;
    const muscles = musclesOf(set.exerciseId);
    if (muscles === undefined) continue;
    const primary = new Set(muscles.primaryMuscles);
    for (const muscle of primary) count(muscle).primarySets += 1;
    for (const muscle of new Set(muscles.secondaryMuscles)) {
      if (!primary.has(muscle)) count(muscle).secondarySets += 1;
    }
  }
  return [...counts]
    .map(([muscle, { primarySets, secondarySets }]) => ({
      muscle,
      sets: primarySets + secondarySets / 2,
      primarySets,
      secondarySets,
    }))
    .sort(
      (a, b) => b.sets - a.sets || MUSCLE_LABEL[a.muscle].localeCompare(MUSCLE_LABEL[b.muscle]),
    );
};

/** "12", "36.5". Counts are whole or halves, so one decimal is exact. */
export const formatSetCount = (sets: number): string => String(Math.round(sets * 10) / 10);

/** "8 primary, 3 secondary at ½". */
export const describeMuscleSets = ({ primarySets, secondarySets }: MuscleSets): string =>
  [
    primarySets > 0 ? `${primarySets} primary` : null,
    secondarySets > 0 ? `${secondarySets} secondary at ½` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");

/**
 * One muscle's weekly set count for the `weeks` weeks ending with the week
 * that starts at `lastWeekStart`, oldest first. Weeks without sets count 0.
 */
export const weeklyMuscleSets = (
  sets: ReadonlyArray<PerformedSet>,
  musclesOf: (exerciseId: ExerciseId) => ExerciseMuscles | undefined,
  muscle: Muscle,
  lastWeekStart: number,
  weeks: number,
): ReadonlyArray<{ readonly weekStart: number; readonly sets: number }> =>
  Array.from({ length: weeks }, (_, index) => {
    const weekStart = addWeeks(lastWeekStart, index - weeks + 1);
    const weekEnd = addWeeks(weekStart, 1);
    const inWeek = sets.filter((set) => set.startedAt >= weekStart && set.startedAt < weekEnd);
    const found = muscleSets(inWeek, musclesOf).find((entry) => entry.muscle === muscle);
    return { weekStart, sets: found?.sets ?? 0 };
  });
