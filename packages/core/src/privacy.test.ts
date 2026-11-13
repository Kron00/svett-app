import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { Audience, DEFAULT_AUDIENCE, HiddenField, trimRoute } from "./privacy.ts";
import { distanceMeters, type TrackPoint } from "./track.ts";

const METERS_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;

const point = (seconds: number, north: number, east = 0): TrackPoint => ({
  at: seconds * 1000,
  lat: north / METERS_PER_DEGREE,
  lon: east / METERS_PER_DEGREE,
});

const north = (p: TrackPoint | undefined): number => (p?.lat ?? Number.NaN) * METERS_PER_DEGREE;

const home = point(0, 0);

describe("audience", () => {
  it("starts new activities visible only to you", () => {
    expect(Schema.decodeUnknownSync(Audience)(DEFAULT_AUDIENCE)).toBe("only-you");
  });

  it.each(["public", "friends", ""])("rejects %j as an audience", (input) => {
    expect(() => Schema.decodeUnknownSync(Audience)(input)).toThrow();
  });

  it.each(["weight", "heart-rate", "start-time", "calories", "pace"])("can hide %s", (field) => {
    expect(Schema.decodeUnknownSync(HiddenField)(field)).toBe(field);
  });
});

describe("trimRoute", () => {
  it("trims both ends of an out-and-back from home", () => {
    const out = Array.from({ length: 34 }, (_, i) => point(i * 10, i * 30));
    const back = Array.from({ length: 33 }, (_, i) => point(340 + i * 10, 960 - i * 30));
    const trimmed = trimRoute([...out, ...back]);
    expect(north(trimmed[0])).toBeCloseTo(210, 6);
    expect(north(trimmed.at(-1))).toBeCloseTo(210, 6);
    expect(trimmed).toHaveLength(27 + 26);
    expect(trimmed.every((p) => distanceMeters(home, p) >= 200)).toBe(true);
  });

  it("starts at least hideMeters from home when the route winds around it first", () => {
    const loop = [point(0, 0), point(30, 0, 75), point(60, 75, 75), point(90, 75), point(120, 0)];
    const out = Array.from({ length: 20 }, (_, i) => point(150 + i * 15, 55 + i * 50));
    const trimmed = trimRoute([...loop, ...out, point(450, 1030)]);
    expect(north(trimmed[0])).toBeCloseTo(205, 6);
    expect(trimmed.every((p) => distanceMeters(home, p) >= 200)).toBe(true);
    expect(north(trimmed.at(-1))).toBeCloseTo(805, 6);
  });

  it.each([100, 500])("honours a hide distance of %d m", (hideMeters) => {
    const line = Array.from({ length: 67 }, (_, i) => point(i, i * 30));
    const trimmed = trimRoute(line, hideMeters);
    expect(north(trimmed[0])).toBeGreaterThanOrEqual(hideMeters);
    expect(north(trimmed[0])).toBeLessThan(hideMeters + 30);
    expect(north(trimmed.at(-1))).toBeLessThanOrEqual(1980 - hideMeters);
    expect(north(trimmed.at(-1))).toBeGreaterThan(1980 - hideMeters - 30);
  });

  it.each([
    ["no points", []],
    ["one point", [point(0, 0)]],
    ["a 390 m route", [point(0, 0), point(100, 390)]],
    [
      "a 450 m route with no point far enough from both ends",
      [point(0, 0), point(50, 150), point(150, 450)],
    ],
  ])("hides all of %s", (_, points) => {
    expect(trimRoute(points)).toEqual([]);
  });
});
