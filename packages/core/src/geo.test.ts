import { describe, expect, it } from "vite-plus/test";

import {
  distanceM,
  hideRouteEnds,
  pathLengthM,
  regionFitting,
  routeLengthM,
  type RoutePoint,
} from "./geo.ts";

/** Metres in one degree of latitude on svett's Earth. */
const DEGREE_M = (Math.PI * 6_371_008.8) / 180;

/** A straight line north, one point every `stepM` metres, from `fromM` north of the equator. */
const north = (lengthM: number, stepM: number, fromM = 0): RoutePoint[] =>
  Array.from({ length: Math.round(lengthM / stepM) + 1 }, (_, index) => ({
    latitude: (fromM + index * stepM) / DEGREE_M,
    longitude: 0,
    altitudeM: index,
  }));

describe("distanceM", () => {
  it("measures a degree of latitude as about 111.2 km", () => {
    expect(distanceM({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(
      111_195,
      0,
    );
  });

  it("measures a degree of longitude at 60° north as half of one at the equator", () => {
    const atEquator = distanceM({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    const at60 = distanceM({ latitude: 60, longitude: 0 }, { latitude: 60, longitude: 1 });
    expect(at60 / atEquator).toBeCloseTo(0.5, 3);
  });

  it("is zero between a point and itself", () => {
    expect(
      distanceM({ latitude: 59.3, longitude: 18.1 }, { latitude: 59.3, longitude: 18.1 }),
    ).toBe(0);
  });
});

describe("pathLengthM", () => {
  it("adds up each step", () => {
    expect(pathLengthM(north(1000, 10))).toBeCloseTo(1000, 6);
  });

  it("is zero for one point or none", () => {
    expect(pathLengthM([])).toBe(0);
    expect(pathLengthM([{ latitude: 1, longitude: 1 }])).toBe(0);
  });
});

describe("hideRouteEnds", () => {
  const route = north(1000, 100);
  const lines = [route];

  it("hides the first and last stretch, cutting between readings, and the parts meet", () => {
    const parts = hideRouteEnds(lines, 150, 250);
    expect(routeLengthM(parts.start)).toBeCloseTo(150, 6);
    expect(routeLengthM(parts.visible)).toBeCloseTo(600, 6);
    expect(routeLengthM(parts.end)).toBeCloseTo(250, 6);
    expect(parts.start[0]!.at(-1)).toEqual(parts.visible[0]![0]);
    expect(parts.visible[0]!.at(-1)).toEqual(parts.end[0]![0]);
  });

  it("gives a cut between readings the altitude between them", () => {
    expect(hideRouteEnds(lines, 150, 250).visible[0]![0]!.altitudeM).toBeCloseTo(1.5, 6);
  });

  it("cuts exactly on a reading when the distance lands on one", () => {
    const parts = hideRouteEnds(lines, 200, 300);
    expect(parts.start).toEqual([route.slice(0, 3)]);
    expect(parts.visible).toEqual([route.slice(2, 8)]);
    expect(parts.end).toEqual([route.slice(7)]);
  });

  it("shows the whole route when nothing is hidden", () => {
    expect(hideRouteEnds(lines, 0, 0)).toEqual({ start: [], visible: lines, end: [] });
  });

  it("shows nothing when the hidden ends cover the route", () => {
    expect(hideRouteEnds(lines, 600, 500)).toEqual({ start: lines, visible: [], end: [] });
    expect(hideRouteEnds(lines, 2000, 0).visible).toEqual([]);
  });

  it("cuts both ends inside one long step", () => {
    const parts = hideRouteEnds([north(1000, 1000)], 100, 100);
    expect(parts.visible).toHaveLength(1);
    expect(parts.visible[0]).toHaveLength(2);
    expect(routeLengthM(parts.visible)).toBeCloseTo(800, 6);
  });

  it("measures along each stretch and never joins two across a pause", () => {
    // 100 m, then a pause and a 900 m move, then another 100 m.
    const paused = [north(100, 10), north(100, 10, 1000)];
    expect(routeLengthM(paused)).toBeCloseTo(200, 6);
    const parts = hideRouteEnds(paused, 50, 50);
    expect(routeLengthM(parts.start)).toBeCloseTo(50, 6);
    expect(routeLengthM(parts.end)).toBeCloseTo(50, 6);
    expect(parts.visible).toHaveLength(2);
    expect(routeLengthM(parts.visible)).toBeCloseTo(100, 6);
  });
});

describe("regionFitting", () => {
  it("centres on the route and zooms so its longer side fits with a margin", () => {
    const region = regionFitting([
      { latitude: 59.3, longitude: 18.0 },
      { latitude: 59.32, longitude: 18.1 },
    ]);
    expect(region?.center.latitude).toBeCloseTo(59.31, 10);
    expect(region?.center.longitude).toBeCloseTo(18.05, 10);
    expect(360 / 2 ** region!.zoom).toBeCloseTo(0.1 * 1.4, 10);
  });

  it("shows a single point at about half a kilometre across", () => {
    const region = regionFitting([{ latitude: 10, longitude: 20 }]);
    expect(360 / 2 ** region!.zoom).toBeCloseTo(0.005, 10);
  });

  it("has nothing to fit without points", () => {
    expect(regionFitting([])).toBeNull();
  });
});
