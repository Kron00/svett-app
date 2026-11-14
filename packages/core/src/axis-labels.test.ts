import { describe, expect, it } from "vite-plus/test";

import { type AxisLabel, placeAxisLabels, placeMonthLabels } from "./axis-labels.ts";
import { timeScale } from "./chart-scale.ts";
import { monthTicks } from "./progress-dates.ts";

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

const DAY = 86_400_000;
const local = (year: number, month: number, day: number, hour = 0) =>
  new Date(year, month, day, hour).getTime();

/**
 * A time axis as the chart draws it: month ticks on the points' time scale
 * across a plot inset by 6 on each side, each label `labelWidth` wide.
 */
const timeAxis = (times: ReadonlyArray<number>, plotWidth: number, labelWidth: number) => {
  const x = timeScale(times, [6, plotWidth - 6]);
  const ticks = monthTicks(Math.min(...times), Math.max(...times));
  const labels = ticks.map((tick) => ({
    month: tick.month,
    center: x(tick.at),
    width: labelWidth,
  }));
  return placeMonthLabels(labels, plotWidth, GAP).map(({ index, left }) => {
    const tick = ticks[index]!;
    return { label: tick.label, month: tick.month, left, center: x(tick.at) };
  });
};

describe("a time axis", () => {
  // Workouts in bursts with quiet weeks between them, from 14 Nov 2025 to 29 Oct 2026.
  const irregularYear = [
    local(2025, 10, 14, 18),
    ...Array.from({ length: 40 }, (_, index) => local(2025, 11, 2, 7) + (index ** 2 % 331) * DAY),
    local(2026, 9, 29, 7),
  ];

  it("labels a year of irregular workouts every third month, each at its month's start", () => {
    // About 24 points a month, so 62 point labels need three months each.
    const axis = timeAxis(irregularYear, 297, 62);
    expect(axis.map((label) => label.label)).toEqual(["2026", "Apr", "Jul", "Oct"]);
    const x = timeScale(irregularYear, [6, 291]);
    expect(axis.map((label) => label.center)).toEqual([
      x(local(2026, 0, 1)),
      x(local(2026, 3, 1)),
      x(local(2026, 6, 1)),
      x(local(2026, 9, 1)),
    ]);
    for (const { left, center } of axis.slice(0, -1)) expect(left + 31).toBeCloseTo(center);
    // October's label is moved inside the plot's right edge, and still covers its tick.
    const october = axis[3]!;
    expect(october.left).toBe(297 - 62);
    expect(october.center).toBeGreaterThan(october.left);
  });

  it("keeps two years of labels six months apart, so the gaps between them stay even", () => {
    const twoYears = Array.from(
      { length: 120 },
      (_, index) => local(2024, 10, 14) + index * 6 * DAY,
    );
    const axis = timeAxis(twoYears, 297, 62);
    expect(axis.map((label) => label.label)).toEqual(["2025", "Jul", "2026", "Jul"]);
    const gaps = axis.slice(1).map((label, index) => label.center - axis[index]!.center);
    for (const gap of gaps) expect(Math.abs(gap - gaps[0]!)).toBeLessThan(2);
  });

  it("labels the months in a gap of several months where they fall in time", () => {
    const gap = [
      local(2026, 0, 6),
      local(2026, 0, 20),
      local(2026, 1, 3),
      local(2026, 1, 17),
      local(2026, 7, 4),
      local(2026, 7, 18),
      local(2026, 8, 1),
    ];
    const axis = timeAxis(gap, 297, 24);
    expect(axis.map((label) => label.label)).toEqual([
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
    ]);
    const x = timeScale(gap, [6, 291]);
    expect(axis.map((label) => label.center)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((month) => x(local(2026, month, 1))),
    );
    // The points stop in February, and March to July still sit across the empty middle.
    const march = axis[1]!;
    const july = axis[5]!;
    expect(march.center).toBeGreaterThan(x(gap[3]!));
    expect(july.center).toBeLessThan(x(gap[4]!));
  });

  it("keeps only the first month when no step fits two labels", () => {
    const axis = timeAxis([local(2026, 0, 20), local(2026, 3, 10)], 80, 62);
    expect(axis).toHaveLength(1);
  });
});
