import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_AUDIENCE, trimRoute } from "./privacy.ts";
import { Audience } from "./schema.ts";
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
    expect(Schema.decodeUnknownSync(Audience)(DEFAULT_AUDIENCE)).toBe("only_you");
  });
});

describe("trimRoute", () => {
  it("trims both ends of an out-and-back from home", () => {
    const out = Array.from({ length: 34 }, (_, i) => point(i * 10, i * 30));
    const back = Array.from({ length: 33 }, (_, i) => point(340 + i * 10, 960 - i * 30));
    const stretches = trimRoute([...out, ...back]);
    expect(stretches).toHaveLength(1);
    const trimmed = stretches.flat();
    expect(north(trimmed[0])).toBeCloseTo(210, 6);
    expect(north(trimmed.at(-1))).toBeCloseTo(210, 6);
    expect(trimmed).toHaveLength(27 + 26);
    expect(trimmed.every((p) => distanceMeters(home, p) >= 200)).toBe(true);
  });

  it("starts at least hideMeters from home when the route winds around it first", () => {
    const loop = [point(0, 0), point(30, 0, 75), point(60, 75, 75), point(90, 75), point(120, 0)];
    const out = Array.from({ length: 20 }, (_, i) => point(150 + i * 15, 55 + i * 50));
    const trimmed = trimRoute([...loop, ...out, point(450, 1030)]).flat();
    expect(north(trimmed[0])).toBeCloseTo(205, 6);
    expect(trimmed.every((p) => distanceMeters(home, p) >= 200)).toBe(true);
    expect(north(trimmed.at(-1))).toBeCloseTo(805, 6);
  });

  it.each([100, 500])("honours a hide distance of %d m", (hideMeters) => {
    const line = Array.from({ length: 67 }, (_, i) => point(i, i * 30));
    const trimmed = trimRoute(line, hideMeters).flat();
    expect(north(trimmed[0])).toBeGreaterThanOrEqual(hideMeters);
    expect(north(trimmed[0])).toBeLessThan(hideMeters + 30);
    expect(north(trimmed.at(-1))).toBeLessThanOrEqual(1980 - hideMeters);
    expect(north(trimmed.at(-1))).toBeGreaterThan(1980 - hideMeters - 30);
  });

  it("hides a pass by home in the middle of the route and splits the line there", () => {
    const up = Array.from({ length: 21 }, (_, i) => point(i * 10, i * 50));
    const through = Array.from({ length: 41 }, (_, i) => point(210 + i * 10, 1000 - i * 50));
    const back = Array.from({ length: 20 }, (_, i) => point(620 + i * 10, -950 + i * 50));
    const stretches = trimRoute([...up, ...through, ...back]);
    expect(stretches.map((stretch) => Math.sign(north(stretch[0])))).toEqual([1, -1]);
    expect(stretches.flat().every((p) => distanceMeters(home, p) >= 200)).toBe(true);
  });

  it("never draws a line through home between two sparse points on either side", () => {
    const sparse = [point(0, 0), point(60, 300), point(120, 300, 300), point(180, -300, 300)];
    const crossing = [point(240, -300), point(300, 300), point(360, 0, 1000)];
    const stretches = trimRoute([...sparse, ...crossing]);
    expect(stretches.map((stretch) => stretch.map(north))).toEqual([[300, 300, -300, -300]]);
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
