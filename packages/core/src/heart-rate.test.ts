import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  averageBpm,
  estimateMaxBpm,
  HeartRateSample,
  heartRateZones,
  peakBpm,
  timeInZones,
  zoneOf,
  ZoneModel,
} from "./heart-rate.ts";

const max200: ZoneModel = { kind: "max", maxBpm: 200 };

const sample = (seconds: number, bpm: number): HeartRateSample => ({ at: seconds * 1000, bpm });

const ride = [sample(65, 170), sample(0, 130), sample(72, 185), sample(5, 150), sample(70, 90)];

describe("schemas", () => {
  it.each([
    [HeartRateSample, { at: 0, bpm: 0 }],
    [HeartRateSample, { at: 0, bpm: Number.NaN }],
    [HeartRateSample, { at: Number.POSITIVE_INFINITY, bpm: 120 }],
    [ZoneModel, { kind: "max", maxBpm: 0 }],
    [ZoneModel, { kind: "reserve", maxBpm: 190, restingBpm: 190 }],
    [ZoneModel, { kind: "lactate", maxBpm: 190 }],
  ])("rejects %#", (schema, input) => {
    expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow();
  });
});

describe("heartRateZones", () => {
  it.each([
    [
      max200,
      [
        [100, 120],
        [120, 140],
        [140, 160],
        [160, 180],
        [180, 200],
      ],
    ],
    [
      { kind: "reserve", maxBpm: 190, restingBpm: 60 } as const,
      [
        [125, 138],
        [138, 151],
        [151, 164],
        [164, 177],
        [177, 190],
      ],
    ],
  ])("bounds zones for %o", (model, expected) => {
    expect(heartRateZones(model)).toEqual(
      expected.map(([minBpm, maxBpm], index) => ({ zone: index + 1, minBpm, maxBpm })),
    );
  });
});

describe("zoneOf", () => {
  it.each([
    [99, 0],
    [100, 1],
    [119.9, 1],
    [120, 2],
    [179, 4],
    [180, 5],
    [230, 5],
  ])("puts %d bpm in zone %d", (bpm, zone) => {
    expect(zoneOf(bpm, max200)).toBe(zone);
  });
});

describe("timeInZones", () => {
  it("credits each sample until the next, caps dropouts and counts the last as zero", () => {
    expect(timeInZones(ride, max200)).toEqual([2, 0, 5, 10, 5, 0]);
  });

  it("honours a wider gap", () => {
    expect(timeInZones(ride, max200, { maxGapSeconds: 60 })).toEqual([2, 0, 5, 60, 5, 0]);
  });

  it("is all zeros without samples", () => {
    expect(timeInZones([], max200)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("averageBpm", () => {
  it("weights by time with the same gap cap", () => {
    expect(averageBpm(ride)).toBeCloseTo((130 * 5 + 150 * 10 + 170 * 5 + 90 * 2) / 22);
  });

  it.each([[[]], [[sample(0, 140)]]])("is undefined when no time is covered: %o", (samples) => {
    expect(averageBpm(samples)).toBeUndefined();
  });
});

describe("peakBpm", () => {
  it("is the highest reading, or undefined without samples", () => {
    expect(peakBpm(ride)).toBe(185);
    expect(peakBpm([])).toBeUndefined();
  });
});

describe("estimateMaxBpm", () => {
  it.each([
    [20, 194],
    [30, 187],
    [45, 177],
    [50, 173],
  ])("estimates age %d as %d bpm", (age, expected) => {
    expect(estimateMaxBpm(age)).toBe(expected);
  });
});
