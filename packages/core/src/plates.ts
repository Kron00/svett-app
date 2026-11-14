import { Schema } from "effect";

import { formatWeightNumber, type WeightUnit } from "./weight-unit.ts";

const PositiveWeight = Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 1000 }));
const BarWeight = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));

/** A plate size you own, in the unit of the set it belongs to, and how many pairs of it. */
export const Plate = Schema.Struct({
  weight: PositiveWeight,
  pairs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
});
export type Plate = typeof Plate.Type;

export const Bar = Schema.Struct({
  name: Schema.NonEmptyString,
  weight: BarWeight,
});
export type Bar = typeof Bar.Type;

/** The plates and bars of one unit. A kilogram gym and a pound gym keep their own. */
export const BarsAndPlates = Schema.Struct({
  plates: Schema.Array(Plate),
  bars: Schema.Array(Bar).check(Schema.isMinLength(1)),
});
export type BarsAndPlates = typeof BarsAndPlates.Type;

export const BarsAndPlatesByUnit = Schema.Struct({ kg: BarsAndPlates, lb: BarsAndPlates });
export type BarsAndPlatesByUnit = typeof BarsAndPlatesByUnit.Type;

/** What a commercial gym has: plenty of the big plates and a pair of each small one. */
export const DEFAULT_BARS_AND_PLATES: BarsAndPlatesByUnit = {
  kg: {
    plates: [
      { weight: 25, pairs: 6 },
      { weight: 20, pairs: 2 },
      { weight: 15, pairs: 2 },
      { weight: 10, pairs: 2 },
      { weight: 5, pairs: 2 },
      { weight: 2.5, pairs: 2 },
      { weight: 1.25, pairs: 2 },
    ],
    bars: [
      { name: "Barbell", weight: 20 },
      { name: "Women's barbell", weight: 15 },
      { name: "No bar", weight: 0 },
    ],
  },
  lb: {
    plates: [
      { weight: 45, pairs: 6 },
      { weight: 35, pairs: 2 },
      { weight: 25, pairs: 2 },
      { weight: 10, pairs: 2 },
      { weight: 5, pairs: 2 },
      { weight: 2.5, pairs: 2 },
    ],
    bars: [
      { name: "Barbell", weight: 45 },
      { name: "Women's barbell", weight: 35 },
      { name: "No bar", weight: 0 },
    ],
  },
};

/** One plate size on each side of the bar, and how many of it. */
export type PlateCount = { readonly weight: number; readonly count: number };

/** A way to load the bar: the plates on each side, heaviest first, and the total with the bar. */
export type PlateLoad = { readonly perSide: ReadonlyArray<PlateCount>; readonly total: number };

export type PlateResult =
  | { readonly kind: "exact"; readonly load: PlateLoad }
  | {
      /** Your plates cannot make the weight. These are the nearest loads either side of it. */
      readonly kind: "inexact";
      /** Null when the weight is lighter than the bar. */
      readonly lighter: PlateLoad | null;
      /** Null when the weight is more than all your plates make. */
      readonly heavier: PlateLoad | null;
    };

// Weights are worked in hundredths, so 1.25 kg plates and 2.5 lb plates add up exactly.
const hundredths = (weight: number): number => Math.round(weight * 100);

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

// The fewest-plates search does about this much work for a phone's tap. Plate mixes with no
// common step, such as 0.01 and 997, would take far more, and load heaviest first instead.
const MAX_SEARCH_STEPS = 2_000_000;

/**
 * The plates on each side that load `target` on `bar`. Each side takes the fewest plates,
 * and among those the heaviest first, as you would load them. When your plates cannot make
 * the weight, it gives the nearest lighter and heavier loads instead. A plate mix too odd to
 * search loads each side heaviest plate first, and then the loads either side are near ones,
 * not always the nearest.
 */
export const loadPlates = (
  target: number,
  bar: number,
  plates: ReadonlyArray<Plate>,
): PlateResult => {
  // Same sizes listed twice count as one size, and sizes you have none of are left out.
  const pairs = new Map<number, number>();
  for (const plate of plates) {
    const size = hundredths(plate.weight);
    if (size > 0 && plate.pairs > 0) pairs.set(size, (pairs.get(size) ?? 0) + plate.pairs);
  }
  const sizes = [...pairs.keys()].sort((a, b) => b - a);
  const unit = sizes.reduce(gcd, 0) || 1;
  const steps = sizes.map((size) => size / unit);
  const counts = sizes.map((size) => pairs.get(size)!);
  const most = steps.reduce((sum, step, index) => sum + step * counts[index]!, 0);
  const work = most * counts.reduce((sum, count) => sum + count, 0);
  if (work > MAX_SEARCH_STEPS) return loadHeaviestFirst(target, bar, sizes, counts);

  // fewest[i][s]: the fewest plates from the sizes at i and lighter that make s steps a side.
  const fewest: Array<Array<number>> = [];
  let after = Array.from({ length: most + 1 }, (_, s) => (s === 0 ? 0 : Infinity));
  fewest[steps.length] = after;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const here = after.slice();
    for (let s = 1; s <= most; s += 1) {
      for (let k = 1; k <= counts[i]! && k * steps[i]! <= s; k += 1) {
        here[s] = Math.min(here[s]!, k + after[s - k * steps[i]!]!);
      }
    }
    fewest[i] = here;
    after = here;
  }

  const barHundredths = hundredths(bar);
  const loadOf = (side: number): PlateLoad => {
    const perSide: Array<PlateCount> = [];
    let left = side;
    for (const [i, step] of steps.entries()) {
      for (let k = Math.min(counts[i]!, Math.floor(left / step)); k >= 0; k -= 1) {
        if (k + (fewest[i + 1]![left - k * step] as number) === fewest[i]![left]) {
          if (k > 0) perSide.push({ weight: sizes[i]! / 100, count: k });
          left -= k * step;
          break;
        }
      }
    }
    return { perSide, total: (barHundredths + 2 * side * unit) / 100 };
  };

  const reachable = fewest[0]!;
  const difference = hundredths(target) - barHundredths;
  if (difference >= 0 && difference % (2 * unit) === 0) {
    const side = difference / (2 * unit);
    if (side <= most && reachable[side] !== Infinity) return { kind: "exact", load: loadOf(side) };
  }
  let lighter: number | null = null;
  let heavier: number | null = null;
  for (let side = 0; side <= most; side += 1) {
    if (reachable[side] === Infinity) continue;
    const load = 2 * side * unit;
    if (load < difference) lighter = side;
    else if (load > difference && heavier === null) heavier = side;
  }
  return {
    kind: "inexact",
    lighter: lighter === null ? null : loadOf(lighter),
    heavier: heavier === null ? null : loadOf(heavier),
  };
};

/** loadPlates for a plate mix too odd to search: each side takes the heaviest plates that fit. */
const loadHeaviestFirst = (
  target: number,
  bar: number,
  sizes: ReadonlyArray<number>,
  counts: ReadonlyArray<number>,
): PlateResult => {
  const barHundredths = hundredths(bar);
  const loadOf = (taken: ReadonlyArray<number>): PlateLoad => ({
    perSide: taken.flatMap((count, i) => (count > 0 ? [{ weight: sizes[i]! / 100, count }] : [])),
    total: (barHundredths + 2 * taken.reduce((sum, count, i) => sum + count * sizes[i]!, 0)) / 100,
  });
  const difference = hundredths(target) - barHundredths;
  if (difference < 0) {
    return { kind: "inexact", lighter: null, heavier: loadOf(sizes.map(() => 0)) };
  }
  let left = Math.floor(difference / 2);
  const taken = sizes.map((size, i) => {
    const count = Math.min(counts[i]!, Math.floor(left / size));
    left -= count * size;
    return count;
  });
  const lighter = loadOf(taken);
  if (left === 0 && difference % 2 === 0) return { kind: "exact", load: lighter };
  // One more of the lightest plate that has a pair left goes over the target with the heavier
  // plates alone, so the lighter ones come off.
  const spare = sizes.findLastIndex((_, i) => taken[i]! < counts[i]!);
  const heavier =
    spare === -1
      ? null
      : loadOf(taken.map((count, i) => (i < spare ? count : i === spare ? count + 1 : 0)));
  return { kind: "inexact", lighter, heavier };
};

/** The load nearest `target` your plates make, the lighter one on a tie, or null for none. */
export const nearestLoad = (
  target: number,
  bar: number,
  plates: ReadonlyArray<Plate>,
): PlateLoad | null => {
  const result = loadPlates(target, bar, plates);
  if (result.kind === "exact") return result.load;
  const { lighter, heavier } = result;
  if (lighter === null || heavier === null) return lighter ?? heavier;
  return heavier.total - target < target - lighter.total ? heavier : lighter;
};

/** One side's plates as a line, such as "25 + 15" or "2 × 25 + 10", or "No plates". */
export const plateLine = (load: PlateLoad): string =>
  load.perSide.length === 0
    ? "No plates"
    : load.perSide
        .map(({ weight, count }) =>
          count === 1 ? formatWeightNumber(weight) : `${count} × ${formatWeightNumber(weight)}`,
        )
        .join(" + ");

/** What VoiceOver reads for one side's plates, such as "2 plates of 25 kg, 1 plate of 10 kg". */
export const plateLabel = (load: PlateLoad, unit: WeightUnit): string =>
  load.perSide.length === 0
    ? "No plates"
    : load.perSide
        .map(
          ({ weight, count }) =>
            `${count} ${count === 1 ? "plate" : "plates"} of ${formatWeightNumber(weight)} ${unit}`,
        )
        .join(", ");

/** A plate size you can add: 0.01 to 1000, and not one you already have. */
export const plateSizeProblem = (
  weight: number | null,
  plates: ReadonlyArray<Plate>,
): string | undefined => {
  if (weight === null || !(weight >= 0.01 && weight <= 1000)) return "Enter the plate's weight.";
  if (plates.some((plate) => hundredths(plate.weight) === hundredths(weight))) {
    return "You already have that plate size.";
  }
  return undefined;
};

/** Plate sizes heaviest first, so the list reads the way you load a bar. */
export const sortPlates = (plates: ReadonlyArray<Plate>): ReadonlyArray<Plate> =>
  [...plates].sort((a, b) => b.weight - a.weight);
