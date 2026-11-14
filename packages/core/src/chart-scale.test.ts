import { describe, expect, it } from "vite-plus/test";

import { niceTicks, scaleLinear, timePositions } from "./chart-scale.ts";

describe("niceTicks", () => {
  it("brackets the data with round steps", () => {
    expect(niceTicks([0, 87, 40], 5)).toEqual({ min: 0, max: 100, values: [0, 25, 50, 75, 100] });
  });

  it("starts near the lowest value unless zero is asked for", () => {
    expect(niceTicks([92, 104], 4)).toEqual({ min: 90, max: 105, values: [90, 95, 100, 105] });
    expect(niceTicks([92, 104], 4, { includeZero: true }).values).toEqual([0, 50, 100, 150]);
  });

  it("keeps float noise out of small steps", () => {
    expect(niceTicks([0, 0.9], 4).values).toEqual([0, 0.5, 1]);
    expect(niceTicks([0.1, 0.7], 7).values).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  });

  it("widens a flat series so the line sits inside the axis", () => {
    const ticks = niceTicks([100, 100], 3);
    expect(ticks.min).toBeLessThan(100);
    expect(ticks.max).toBeGreaterThan(100);
  });

  it("gives a week without sets, or no data, an axis from 0 to 1 with no negative tick", () => {
    expect(niceTicks([0, 0, 0], 3, { includeZero: true }).values).toEqual([0, 0.5, 1]);
    expect(niceTicks([], 3).values).toEqual([0, 0.5, 1]);
  });
});

describe("scaleLinear", () => {
  it("maps the domain onto the range, flipped for screen y", () => {
    const y = scaleLinear([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(25)).toBe(150);
    expect(y(100)).toBe(0);
  });
});

describe("timePositions", () => {
  const DAY = 86_400_000;

  it("spaces irregular points by the time between them, not by their order", () => {
    // A day apart, then 179 days later, across a plot from 6 to 186.
    expect(timePositions([0, DAY, 180 * DAY], [6, 186])).toEqual([6, 7, 186]);
    // Twelve weekly workouts and one six months later: the gap takes most of the width.
    const weekly = Array.from({ length: 12 }, (_, week) => week * 7 * DAY);
    const positions = timePositions([...weekly, 11 * 7 * DAY + 182 * DAY], [0, 259]);
    expect(positions[11]).toBe(77);
    expect(positions[12]).toBe(259);
  });

  it("puts a lone point, or points at one time, in the middle", () => {
    expect(timePositions([5 * DAY], [6, 186])).toEqual([96]);
    expect(timePositions([DAY, DAY], [0, 100])).toEqual([50, 50]);
    expect(timePositions([], [0, 100])).toEqual([]);
  });
});
