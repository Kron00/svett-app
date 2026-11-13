import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  distanceUnitFor,
  kgTo,
  METRIC_UNITS,
  metersTo,
  toKg,
  toMeters,
  UnitPreferences,
} from "./units.ts";

describe("weight", () => {
  it.each([
    ["kg", 100, 100],
    ["lb", 100, 220.462_262],
    ["lb", 0.45359237, 1],
  ] as const)("converts to %s: %d kg is %d", (unit, kg, expected) => {
    expect(kgTo(unit, kg)).toBeCloseTo(expected, 6);
    expect(toKg(unit, expected)).toBeCloseTo(kg, 6);
  });

  it("uses the exact international pound", () => {
    expect(toKg("lb", 225)).toBe(102.058_283_25);
  });
});

describe("distance", () => {
  it.each([
    ["m", 42, 42],
    ["km", 5000, 5],
    ["mi", 1609.344, 1],
    ["mi", 42_195, 26.218_757_456],
    ["yd", 0.9144, 1],
  ] as const)("converts to %s: %d m is %d", (unit, meters, expected) => {
    expect(metersTo(unit, meters)).toBeCloseTo(expected, 6);
    expect(toMeters(unit, expected)).toBeCloseTo(meters, 3);
  });
});

describe("UnitPreferences", () => {
  const decode = Schema.decodeUnknownSync(UnitPreferences);

  it("defaults to metric for every kind", () => {
    expect(decode(METRIC_UNITS)).toEqual({
      weight: "kg",
      distance: { strength: "m", run: "km", ride: "km", walk: "km", hike: "km", other: "km" },
    });
  });

  it("keeps a distance unit per sport", () => {
    const prefs = decode({
      weight: "lb",
      distance: { ...METRIC_UNITS.distance, run: "mi", strength: "yd" },
    });
    expect(distanceUnitFor(prefs, "run")).toBe("mi");
    expect(distanceUnitFor(prefs, "ride")).toBe("km");
    expect(distanceUnitFor(prefs, "strength")).toBe("yd");
  });

  it.each([
    { weight: "st", distance: METRIC_UNITS.distance },
    { weight: "kg", distance: { ...METRIC_UNITS.distance, run: "furlong" } },
    { weight: "kg", distance: { run: "km" } },
  ])("rejects %o", (input) => {
    expect(() => decode(input)).toThrow();
  });
});
