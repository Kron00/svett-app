import { describe, expect, it } from "vite-plus/test";

import { type AxisLabel, placeAxisLabels } from "./axis-labels.ts";

const PLOT = 300;
const GAP = 4;
const week = (labelWidth: number): ReadonlyArray<AxisLabel> => {
  const slot = PLOT / 7;
  return Array.from({ length: 7 }, (_, index) => ({
    center: slot * (index + 0.5),
    width: labelWidth,
  }));
};

describe("placeAxisLabels", () => {
  it("centres every day of a week on its slot in a 300 point plot", () => {
    const labels = week(24);
    const placed = placeAxisLabels(labels, PLOT, GAP);
    expect(placed.map((label) => label.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const { index, left } of placed) {
      expect(left + 12).toBeCloseTo(labels[index]?.center ?? Number.NaN);
    }
  });

  it("keeps the first, middle and last day at the largest text size, with gaps between them", () => {
    const placed = placeAxisLabels(week(80), PLOT, GAP);
    expect(placed).toEqual([
      { index: 0, left: 0 },
      { index: 3, left: 110 },
      { index: 6, left: 220 },
    ]);
  });

  it("keeps every second label when they do not all fit", () => {
    const placed = placeAxisLabels(week(42), PLOT, GAP);
    expect(placed.map((label) => label.index)).toEqual([0, 2, 4, 6]);
  });

  it("drops the label before the last when keeping it would crowd the last", () => {
    const labels = Array.from({ length: 6 }, (_, index) => ({
      center: 50 * index + 25,
      width: 60,
    }));
    expect(placeAxisLabels(labels, PLOT, GAP).map((label) => label.index)).toEqual([0, 2, 5]);
  });

  it("skips empty labels", () => {
    const labels = week(24).map(({ center }, index) => ({
      center,
      width: index % 2 === 1 ? 0 : 24,
    }));
    expect(placeAxisLabels(labels, PLOT, GAP).map((label) => label.index)).toEqual([0, 2, 4, 6]);
    expect(placeAxisLabels([], PLOT, GAP)).toEqual([]);
  });

  it("shows only the first label when even the first and last would touch", () => {
    const labels = [
      { center: 20, width: 40 },
      { center: 50, width: 40 },
    ];
    expect(placeAxisLabels(labels, 70, GAP)).toEqual([{ index: 0, left: 0 }]);
  });
});
