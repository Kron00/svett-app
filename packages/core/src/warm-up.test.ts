import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_BARS_AND_PLATES, plateLine, type Plate } from "./plates.ts";
import { warmUpSets } from "./warm-up.ts";

const KG = DEFAULT_BARS_AND_PLATES.kg.plates;
const LB = DEFAULT_BARS_AND_PLATES.lb.plates;

const shown = (working: number, bar: number, plates: ReadonlyArray<Plate>) =>
  warmUpSets(working, bar, plates).map(
    (set) => `${set.weight} × ${set.reps} (${plateLine(set.load)})`,
  );

describe("the warm-up calculator", () => {
  // Each row: the working weight, the bar, your plates, and the warm-up sets before it.
  const examples: ReadonlyArray<{
    readonly name: string;
    readonly working: number;
    readonly bar: number;
    readonly plates: ReadonlyArray<Plate>;
    readonly expected: ReadonlyArray<string>;
  }> = [
    {
      name: "100 kg, every step loads exactly",
      working: 100,
      bar: 20,
      plates: KG,
      expected: ["20 × 10 (No plates)", "40 × 5 (10)", "60 × 3 (20)", "80 × 2 (25 + 5)"],
    },
    {
      name: "60 kg rounds 24, 36 and 48 kg to the nearest loads",
      working: 60,
      bar: 20,
      plates: KG,
      expected: [
        "20 × 10 (No plates)",
        "25 × 5 (2.5)",
        "35 × 3 (5 + 2.5)",
        "47.5 × 2 (10 + 2.5 + 1.25)",
      ],
    },
    {
      name: "225 lb",
      working: 225,
      bar: 45,
      plates: LB,
      expected: [
        "45 × 10 (No plates)",
        "90 × 5 (2 × 10 + 2.5)",
        "135 × 3 (45)",
        "180 × 2 (45 + 2 × 10 + 2.5)",
      ],
    },
    {
      name: "315 lb",
      working: 315,
      bar: 45,
      plates: LB,
      expected: [
        "45 × 10 (No plates)",
        "125 × 5 (35 + 5)",
        "190 × 3 (45 + 25 + 2.5)",
        "250 × 2 (2 × 45 + 10 + 2.5)",
      ],
    },
    {
      name: "only 25 kg plates: steps that round to the bar or repeat are left out",
      working: 100,
      bar: 20,
      plates: [{ weight: 25, pairs: 4 }],
      expected: ["20 × 10 (No plates)", "70 × 3 (25)"],
    },
    {
      name: "a working weight just above the bar keeps only the empty bar",
      working: 25,
      bar: 20,
      plates: KG,
      expected: ["20 × 10 (No plates)"],
    },
    { name: "the bar alone needs no warm-up", working: 20, bar: 20, plates: KG, expected: [] },
    { name: "lighter than the bar needs none", working: 15, bar: 20, plates: KG, expected: [] },
    {
      name: "no bar, as on a plate-loaded machine",
      working: 100,
      bar: 0,
      plates: KG,
      expected: ["40 × 5 (20)", "60 × 3 (25 + 5)", "80 × 2 (25 + 15)"],
    },
  ];

  for (const example of examples) {
    it(`warms up for ${example.name}`, () => {
      expect(shown(example.working, example.bar, example.plates)).toEqual(example.expected);
    });
  }

  it("gives every set lighter than the work and heavier than the set before", () => {
    for (let working = 21; working <= 300; working += 1.25) {
      const sets = warmUpSets(working, 20, KG);
      for (const [index, set] of sets.entries()) {
        expect(set.weight).toBeLessThan(working);
        if (index > 0) expect(set.weight).toBeGreaterThan(sets[index - 1]!.weight);
      }
    }
  });
});
