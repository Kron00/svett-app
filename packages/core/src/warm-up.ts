import { nearestLoad, type Plate, type PlateLoad } from "./plates.ts";

/** One warm-up step: a share of the working weight, for some reps. The empty bar is 0. */
export type WarmUpStep = { readonly percent: number; readonly reps: number };

/** The empty bar for 10, then 40, 60 and 80 percent for fewer reps each time. */
export const WARM_UP_STEPS: ReadonlyArray<WarmUpStep> = [
  { percent: 0, reps: 10 },
  { percent: 40, reps: 5 },
  { percent: 60, reps: 3 },
  { percent: 80, reps: 2 },
];

export const WARM_UP_RULE =
  "Warm-ups are the empty bar for 10, then 40%, 60% and 80% of your working weight for 5, 3 and 2, each rounded to the nearest weight your plates make.";

/** A warm-up set to add: its weight in the unit of the plates, its reps, and its plates. */
export type WarmUpSet = {
  readonly percent: number;
  readonly weight: number;
  readonly reps: number;
  readonly load: PlateLoad;
};

/**
 * The warm-up sets before a working weight. Each step takes the load your plates make
 * nearest its share of the working weight. A step that comes out no heavier than the step
 * before, or as heavy as the working weight, is left out, so each set is heavier than the
 * last and lighter than the work. A working weight no heavier than the bar needs none, and
 * without a bar there is no empty-bar set.
 */
export const warmUpSets = (
  working: number,
  bar: number,
  plates: ReadonlyArray<Plate>,
  steps: ReadonlyArray<WarmUpStep> = WARM_UP_STEPS,
): ReadonlyArray<WarmUpSet> => {
  if (!(working > bar)) return [];
  const sets: Array<WarmUpSet> = [];
  for (const step of steps) {
    const load = nearestLoad(Math.max(bar, (working * step.percent) / 100), bar, plates);
    if (load === null || load.total <= 0 || load.total >= working) continue;
    const last = sets.at(-1);
    if (last !== undefined && load.total <= last.weight) continue;
    sets.push({ percent: step.percent, weight: load.total, reps: step.reps, load });
  }
  return sets;
};
