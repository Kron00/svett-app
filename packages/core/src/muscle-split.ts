import type { Muscle, SetType } from "./schema.ts";

export const MUSCLE_LABELS: Readonly<Record<Muscle, string>> = {
  abdominals: "Abs",
  abductors: "Abductors",
  adductors: "Adductors",
  biceps: "Biceps",
  calves: "Calves",
  cardio: "Cardio",
  chest: "Chest",
  forearms: "Forearms",
  full_body: "Full body",
  glutes: "Glutes",
  hamstrings: "Hamstrings",
  lats: "Lats",
  lower_back: "Lower back",
  neck: "Neck",
  quadriceps: "Quads",
  shoulders: "Shoulders",
  traps: "Traps",
  triceps: "Triceps",
  upper_back: "Upper back",
  other: "Other",
};

/** The rule muscleSplit follows, in words, so the screen can show how it counted. */
export const MUSCLE_SPLIT_RULE =
  "Each set counts once for its exercise's main muscle. When an exercise has more than one main muscle, the set is shared equally between them. Warm-up sets are left out.";

export type MuscleSplitExercise = {
  readonly primaryMuscles: ReadonlyArray<Muscle>;
  readonly sets: ReadonlyArray<{ readonly setType: SetType }>;
};

export type MuscleShare = {
  readonly muscle: Muscle;
  /** Sets counted for the muscle. A shared set adds a fraction. */
  readonly sets: number;
  /** Whole percentages that add up to 100 across the split. */
  readonly percent: number;
};

/**
 * Rounds shares to whole percentages that add up to exactly 100, giving the
 * leftover points to the largest remainders, so a split never reads 99 or 101.
 */
export const wholePercentages = (values: ReadonlyArray<number>): ReadonlyArray<number> => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    left--;
  }
  return floors;
};

/** How a workout's sets fall across muscles, most sets first, by MUSCLE_SPLIT_RULE. */
export const muscleSplit = (
  exercises: ReadonlyArray<MuscleSplitExercise>,
): ReadonlyArray<MuscleShare> => {
  const counted = new Map<Muscle, number>();
  for (const exercise of exercises) {
    const muscles = [...new Set(exercise.primaryMuscles)];
    if (muscles.length === 0) continue;
    const working = exercise.sets.filter((set) => set.setType !== "warm_up").length;
    for (const muscle of muscles) {
      counted.set(muscle, (counted.get(muscle) ?? 0) + working / muscles.length);
    }
  }
  const rows = [...counted]
    .filter(([, sets]) => sets > 0)
    .sort(([a, aSets], [b, bSets]) => bSets - aSets || a.localeCompare(b));
  const percents = wholePercentages(rows.map(([, sets]) => sets));
  return rows.map(([muscle, sets], index) => ({ muscle, sets, percent: percents[index] ?? 0 }));
};
