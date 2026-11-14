import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BARS_AND_PLATES,
  loadPlates,
  nearestLoad,
  type Plate,
  plateLabel,
  plateLine,
  type PlateLoad,
  plateSizeProblem,
  type PlateResult,
} from "./plates.ts";
import { weightIn } from "./weight-unit.ts";

const KG = DEFAULT_BARS_AND_PLATES.kg.plates;
const LB = DEFAULT_BARS_AND_PLATES.lb.plates;

/** One side's plates as a line, with the total, so a table row reads like a gym note. */
const shown = (load: PlateLoad | null) =>
  load === null ? null : `${plateLine(load)} = ${load.total}`;

const outcome = (result: PlateResult) =>
  result.kind === "exact"
    ? { exact: shown(result.load) }
    : { lighter: shown(result.lighter), heavier: shown(result.heavier) };

describe("the plate calculator", () => {
  // Each row: the weight asked for, the bar, your plates, and what goes on each side.
  const examples: ReadonlyArray<{
    readonly name: string;
    readonly target: number;
    readonly bar: number;
    readonly plates: ReadonlyArray<Plate>;
    readonly expected: ReturnType<typeof outcome>;
  }> = [
    {
      name: "kg bar alone",
      target: 20,
      bar: 20,
      plates: KG,
      expected: { exact: "No plates = 20" },
    },
    { name: "60 kg", target: 60, bar: 20, plates: KG, expected: { exact: "20 = 60" } },
    {
      name: "100 kg takes 25 + 15, the fewest plates, heaviest first",
      target: 100,
      bar: 20,
      plates: KG,
      expected: { exact: "25 + 15 = 100" },
    },
    {
      name: "50 kg takes one 15, not 10 + 5",
      target: 50,
      bar: 20,
      plates: KG,
      expected: { exact: "15 = 50" },
    },
    {
      name: "142.5 kg",
      target: 142.5,
      bar: 20,
      plates: KG,
      expected: { exact: "2 × 25 + 10 + 1.25 = 142.5" },
    },
    {
      name: "200 kg on the women's bar",
      target: 200,
      bar: 15,
      plates: KG,
      expected: { exact: "3 × 25 + 15 + 2.5 = 200" },
    },
    {
      name: "101 kg cannot be made with 1.25 kg plates",
      target: 101,
      bar: 20,
      plates: KG,
      expected: { lighter: "25 + 15 = 100", heavier: "25 + 15 + 1.25 = 102.5" },
    },
    {
      name: "no small plates: 102.5 kg rounds to 100 or 110",
      target: 102.5,
      bar: 20,
      plates: KG.filter((plate) => plate.weight >= 5),
      expected: { lighter: "25 + 15 = 100", heavier: "25 + 20 = 110" },
    },
    {
      name: "a missing size: one pair of 15 and two of 10 still make 60 kg",
      target: 60,
      bar: 20,
      plates: [
        { weight: 15, pairs: 1 },
        { weight: 10, pairs: 2 },
      ],
      expected: { exact: "2 × 10 = 60" },
    },
    {
      name: "a size you have none of is never used",
      target: 60,
      bar: 20,
      plates: [
        { weight: 20, pairs: 0 },
        { weight: 10, pairs: 2 },
      ],
      expected: { exact: "2 × 10 = 60" },
    },
    {
      name: "lighter than the bar",
      target: 15,
      bar: 20,
      plates: KG,
      expected: { lighter: null, heavier: "No plates = 20" },
    },
    {
      name: "more than all your plates",
      target: 600,
      bar: 20,
      plates: KG,
      expected: {
        lighter: "6 × 25 + 2 × 20 + 2 × 15 + 2 × 10 + 2 × 5 + 2 × 2.5 + 2 × 1.25 = 535",
        heavier: null,
      },
    },
    {
      name: "no plates at all",
      target: 60,
      bar: 20,
      plates: [],
      expected: { lighter: "No plates = 20", heavier: null },
    },
    {
      name: "lb bar alone",
      target: 45,
      bar: 45,
      plates: LB,
      expected: { exact: "No plates = 45" },
    },
    { name: "135 lb", target: 135, bar: 45, plates: LB, expected: { exact: "45 = 135" } },
    { name: "225 lb", target: 225, bar: 45, plates: LB, expected: { exact: "2 × 45 = 225" } },
    { name: "315 lb", target: 315, bar: 45, plates: LB, expected: { exact: "3 × 45 = 315" } },
    { name: "185 lb", target: 185, bar: 45, plates: LB, expected: { exact: "45 + 25 = 185" } },
    {
      name: "230 lb",
      target: 230,
      bar: 45,
      plates: LB,
      expected: { exact: "2 × 45 + 2.5 = 230" },
    },
    {
      name: "227 lb cannot be made with 2.5 lb plates",
      target: 227,
      bar: 45,
      plates: LB,
      expected: { lighter: "2 × 45 = 225", heavier: "2 × 45 + 2.5 = 230" },
    },
    {
      name: "100 kg read in lb is 220.46 lb, between two loads",
      target: Math.round(weightIn(100, "lb") * 100) / 100,
      bar: 45,
      plates: LB,
      expected: { lighter: "45 + 35 + 5 + 2.5 = 220", heavier: "2 × 45 = 225" },
    },
    {
      name: "the 35 lb women's bar",
      target: 135,
      bar: 35,
      plates: LB,
      expected: { exact: "45 + 5 = 135" },
    },
    {
      name: "a plate size listed twice counts once",
      target: 100,
      bar: 20,
      plates: [
        { weight: 20, pairs: 1 },
        { weight: 20, pairs: 1 },
      ],
      expected: { exact: "2 × 20 = 100" },
    },
  ];

  for (const example of examples) {
    it(`loads ${example.name}`, () => {
      expect(outcome(loadPlates(example.target, example.bar, example.plates))).toEqual(
        example.expected,
      );
    });
  }

  it("takes the nearer of the two loads it cannot match, the lighter on a tie", () => {
    expect(nearestLoad(101, 20, KG)?.total).toBe(100);
    expect(nearestLoad(102, 20, KG)?.total).toBe(102.5);
    expect(nearestLoad(101.25, 20, KG)?.total).toBe(100);
    expect(nearestLoad(10, 20, KG)?.total).toBe(20);
    expect(nearestLoad(60, 20, [])?.total).toBe(20);
  });

  it("reads each side's plates aloud with the unit", () => {
    const result = loadPlates(142.5, 20, KG);
    expect(result.kind === "exact" && plateLabel(result.load, "kg")).toBe(
      "2 plates of 25 kg, 1 plate of 10 kg, 1 plate of 1.25 kg",
    );
  });

  it("refuses a plate size that is empty, zero, or one you have", () => {
    expect(plateSizeProblem(null, KG)).toBe("Enter the plate's weight.");
    expect(plateSizeProblem(0, KG)).toBe("Enter the plate's weight.");
    expect(plateSizeProblem(0.001, KG)).toBe("Enter the plate's weight.");
    expect(plateSizeProblem(1001, KG)).toBe("Enter the plate's weight.");
    expect(plateSizeProblem(2.5, KG)).toBe("You already have that plate size.");
    expect(plateSizeProblem(0.5, KG)).toBeUndefined();
  });
});
