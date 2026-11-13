import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { ActivityKind } from "./activity-kind.ts";
import {
  cleanTrack,
  distanceMeters,
  elapsedSeconds,
  locationPlan,
  movingSeconds,
  paceSecondsPerKm,
  splits,
  trackDistanceMeters,
  TrackPoint,
} from "./track.ts";

const METERS_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;

const point = (seconds: number, north: number, extra: Partial<TrackPoint> = {}): TrackPoint => ({
  at: seconds * 1000,
  lat: north / METERS_PER_DEGREE,
  lon: 0,
  ...extra,
});

const tenSecondRun = (from: number, start: number): Array<TrackPoint> =>
  Array.from({ length: 11 }, (_, i) => point(from + i, start + i * 3, { accuracyMeters: 1 }));

const sum = (values: ReadonlyArray<number>): number => values.reduce((a, b) => a + b, 0);

describe("TrackPoint", () => {
  const decode = Schema.decodeUnknownSync(TrackPoint);

  it("accepts a point with optional accuracy and altitude", () => {
    expect(decode({ at: 0, lat: 59.9, lon: 10.7, accuracyMeters: 5, altitudeMeters: 12 })).toEqual({
      at: 0,
      lat: 59.9,
      lon: 10.7,
      accuracyMeters: 5,
      altitudeMeters: 12,
    });
  });

  it.each([
    { at: 0, lat: 91, lon: 0 },
    { at: 0, lat: 0, lon: -181 },
    { at: 0, lat: 0, lon: 0, accuracyMeters: -1 },
    { at: Number.NaN, lat: 0, lon: 0 },
  ])("rejects %o", (input) => {
    expect(() => decode(input)).toThrow();
  });
});

describe("distanceMeters", () => {
  it.each([
    [{ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 }, 111.195],
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }, 111.195],
    [{ lat: 60, lon: 10 }, { lat: 60, lon: 10.001 }, 55.598],
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 180 }, 20_015_114.44],
  ])("from %o to %o is %d m", (a, b, expected) => {
    expect(distanceMeters(a, b)).toBeCloseTo(expected, 2);
  });
});

describe("cleanTrack", () => {
  it("drops a 500 m jump in 1 s during a run and keeps the points after it", () => {
    const track = [point(0, 0), point(1, 3), point(2, 503), point(3, 6)];
    expect(cleanTrack(track, "run")).toEqual([point(0, 0), point(1, 3), point(3, 6)]);
  });

  it("drops points that repeat a timestamp or go back in time", () => {
    const track = [point(0, 0), point(10, 20), point(10, 21), point(5, 10), point(20, 40)];
    expect(cleanTrack(track, "run")).toEqual([point(0, 0), point(10, 20), point(20, 40)]);
  });

  it("drops points less accurate than 30 m and keeps 30 m", () => {
    const track = [
      point(0, 0, { accuracyMeters: 31 }),
      point(10, 20, { accuracyMeters: 5 }),
      point(20, 40, { accuracyMeters: 30.5 }),
      point(30, 60, { accuracyMeters: 30 }),
    ];
    expect(cleanTrack(track, "run")).toEqual([track[1], track[3]]);
  });

  it("drops a stale first fix 2 km away instead of every real point after it", () => {
    const track = [point(0, 2000), point(1, 0), point(2, 3), point(3, 6)];
    expect(cleanTrack(track, "run")).toEqual([point(1, 0), point(2, 3), point(3, 6)]);
  });

  it("drops two agreeing offset fixes in the middle of a run", () => {
    const track = [0, 3, 6, 506, 509, 15, 18].map((north, second) => point(second, north));
    expect(trackDistanceMeters(cleanTrack(track, "run"))).toBeCloseTo(18, 6);
  });

  it("drops two stale cached fixes 3 km away at the start of a run", () => {
    const stale = [point(0, 3000), point(1, 3000)];
    const run = Array.from({ length: 601 }, (_, i) => point(2 + i, i * 3));
    expect(trackDistanceMeters(cleanTrack([...stale, ...run], "run"))).toBeCloseTo(1800, 6);
  });

  it("counts a phone standing still mid-run as no distance and no moving time", () => {
    const still = Array.from({ length: 60 }, (_, i) =>
      point(11 + i * 5, 30 + (i % 2) * 4, { accuracyMeters: 5 }),
    );
    const cleaned = cleanTrack([...tenSecondRun(0, 0), ...still, ...tenSecondRun(311, 33)], "run");
    expect(trackDistanceMeters(cleaned)).toBeCloseTo(63, 6);
    expect(movingSeconds(cleaned)).toBe(20);
  });

  it("counts a phone standing still with 5 m jitter as no distance and no moving time", () => {
    const jitter = Array.from({ length: 121 }, (_, i) =>
      point(i * 5, i % 2 === 0 ? 0 : 5, { accuracyMeters: 5 }),
    );
    const cleaned = cleanTrack(jitter, "run");
    expect(trackDistanceMeters(cleaned)).toBe(0);
    expect(movingSeconds(cleaned)).toBe(0);
    expect(elapsedSeconds(cleaned)).toBe(600);
  });

  it.each([
    ["walk", 1.5, 5],
    ["run", 3, 5],
    ["run", 3, 8],
  ] as const)(
    "keeps moving time and pace for a %s at %d m/s with %d m accuracy",
    (kind, speed, accuracyMeters) => {
      const track = Array.from({ length: 601 }, (_, i) => point(i, i * speed, { accuracyMeters }));
      const cleaned = cleanTrack(track, kind);
      const meters = trackDistanceMeters(cleaned);
      expect(meters).toBeGreaterThan(600 * speed - 2 * accuracyMeters);
      expect(meters).toBeLessThan(600 * speed + 1e-6);
      expect(movingSeconds(cleaned)).toBeGreaterThan(600 - (2 * accuracyMeters) / speed - 1);
      expect(elapsedSeconds(cleaned)).toBe(600);
    },
  );

  it("adds no distance for random jitter within the accuracy while standing still", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const still = Array.from({ length: 600 }, (_, i) => {
      const angle = random() * 2 * Math.PI;
      const radius = random() * 5;
      return point(i, Math.cos(angle) * radius, { accuracyMeters: 5 });
    });
    const cleaned = cleanTrack(still, "run");
    expect(trackDistanceMeters(cleaned)).toBe(0);
    expect(movingSeconds(cleaned)).toBe(0);
  });

  it("keeps a genuine first fix when only two bad fixes follow it", () => {
    const track = [point(0, 0), point(1, 500), point(2, 503), point(3, 3), point(4, 6)];
    expect(cleanTrack(track, "run")).toEqual([point(0, 0), point(3, 3), point(4, 6)]);
  });

  it("keeps the first good point even when every later point is implausible", () => {
    expect(cleanTrack([point(0, 0), point(1, 1000), point(2, 2000)], "walk")).toEqual([
      point(0, 0),
    ]);
  });

  it.each<[ActivityKind, number]>([
    ["walk", 4],
    ["hike", 4],
    ["run", 12],
    ["ride", 30],
    ["strength", 4],
    ["other", 30],
  ])("caps %s at %d m/s", (kind, maxMps) => {
    const under = [point(0, 0), point(10, maxMps * 10 * 0.99)];
    const over = [point(0, 0), point(10, maxMps * 10 * 1.01)];
    expect(cleanTrack(under, kind)).toHaveLength(2);
    expect(cleanTrack(over, kind)).toHaveLength(1);
  });
});

describe("distance, time and pace", () => {
  const track = [point(0, 0), point(100, 300), point(200, 310), point(300, 610)];

  it("measures distance along the track", () => {
    expect(trackDistanceMeters(track)).toBeCloseTo(610, 6);
  });

  it("counts elapsed time from the first point to the last", () => {
    expect(elapsedSeconds(track)).toBe(300);
  });

  it("leaves a stretch slower than 0.5 m/s out of moving time", () => {
    expect(movingSeconds(track)).toBe(200);
    expect(movingSeconds(track, { minSpeedMps: 0.05 })).toBe(300);
  });

  it("gives pace from either elapsed or moving time", () => {
    const meters = trackDistanceMeters(track);
    expect(paceSecondsPerKm(elapsedSeconds(track), meters)).toBeCloseTo(300 / 0.61, 6);
    expect(paceSecondsPerKm(movingSeconds(track), meters)).toBeCloseTo(200 / 0.61, 6);
  });

  it.each([[[]], [[point(0, 0)]]])("is zero for a track of %j", (points) => {
    expect(trackDistanceMeters(points)).toBe(0);
    expect(elapsedSeconds(points)).toBe(0);
    expect(movingSeconds(points)).toBe(0);
  });

  it.each([
    [300, 1000, 300],
    [1500, 5000, 300],
    [60, 0, undefined],
  ])("paces %d s over %d m at %s s/km", (seconds, meters, expected) => {
    expect(paceSecondsPerKm(seconds, meters)).toBe(expected);
  });
});

describe("splits", () => {
  it("interpolates the time at each 1 km boundary of a 2.5 km run", () => {
    const run = [point(0, 0), point(300, 1500), point(800, 2500)];
    const result = splits(run, 1000);
    expect(result.map((split) => split.index)).toEqual([0, 1, 2]);
    expect(result.map((split) => split.meters)).toEqual([1000, 1000, expect.closeTo(500, 6)]);
    expect(result.map((split) => split.seconds)).toEqual([
      expect.closeTo(200, 6),
      expect.closeTo(350, 6),
      expect.closeTo(250, 6),
    ]);
  });

  it("does not add an empty split when the run ends on a boundary", () => {
    const result = splits([point(0, 0), point(400, 1000), point(800, 2000)], 1000);
    expect(result).toHaveLength(2);
    expect(result[1]?.meters).toBeCloseTo(1000, 6);
    expect(result[1]?.seconds).toBeCloseTo(400, 6);
  });

  it("puts a stop after the last boundary into the final split", () => {
    const result = splits([point(0, 0), point(400, 1000), point(500, 1000)], 1000);
    expect(result).toEqual([{ index: 0, meters: expect.closeTo(1000, 6), seconds: 500 }]);
  });

  it("sums to the total distance and elapsed time of a winding route", () => {
    const route = Array.from({ length: 60 }, (_, i) => ({
      at: i * 7_300 + (i % 3) * 900,
      lat: 59.9 + i * 0.00031,
      lon: 10.7 + Math.sin(i) * 0.0009,
    }));
    for (const splitMeters of [1000, 1609.344, 333]) {
      const result = splits(route, splitMeters);
      expect(sum(result.map((split) => split.meters))).toBeCloseTo(trackDistanceMeters(route), 6);
      expect(sum(result.map((split) => split.seconds))).toBeCloseTo(elapsedSeconds(route), 6);
      expect(result.slice(0, -1).every((split) => split.meters === splitMeters)).toBe(true);
    }
  });

  it("has no splits for fewer than two points", () => {
    expect(splits([point(0, 0)], 1000)).toEqual([]);
  });

  it.each([0, -1, Number.NaN])("rejects a split length of %d", (splitMeters) => {
    expect(() => splits([point(0, 0), point(1, 1)], splitMeters)).toThrow(RangeError);
  });
});

describe("locationPlan", () => {
  const coarseness = ["best", "ten-meters"];

  it.each<ActivityKind>(["strength", "other"])("uses no GPS for %s", (kind) => {
    expect(locationPlan(kind, { lowPowerMode: false })).toBeNull();
    expect(locationPlan(kind, { lowPowerMode: true })).toBeNull();
  });

  it.each<ActivityKind>(["run", "walk", "hike", "ride"])(
    "records %s in the background, coarser and sparser in low power mode",
    (kind) => {
      const normal = locationPlan(kind, { lowPowerMode: false });
      const lowPower = locationPlan(kind, { lowPowerMode: true });
      expect(normal).toMatchObject({ accuracy: "best", background: true });
      expect(lowPower?.background).toBe(true);
      expect(coarseness.indexOf(lowPower!.accuracy)).toBeGreaterThan(
        coarseness.indexOf(normal!.accuracy),
      );
      expect(lowPower!.distanceFilterMeters).toBeGreaterThan(normal!.distanceFilterMeters);
    },
  );
});
