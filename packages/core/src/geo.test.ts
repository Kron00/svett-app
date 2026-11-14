import { describe, expect, it } from "vite-plus/test";

import { distanceM, hideRouteEnds, type LatLng, pathLengthM, regionFitting } from "./geo.ts";

/** Metres in one degree of latitude on svett's Earth. */
const DEGREE_M = (Math.PI * 6_371_008.8) / 180;

/** A straight line north from the equator, one point every `stepM` metres. */
const north = (lengthM: number, stepM: number): LatLng[] =>
  Array.from({ length: Math.round(lengthM / stepM) + 1 }, (_, index) => ({
    latitude: (index * stepM) / DEGREE_M,
    longitude: 0,
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

  it("hides the first and last stretch, cutting between readings, and the parts meet", () => {
    const parts = hideRouteEnds(route, 150, 250);
    expect(pathLengthM(parts.start)).toBeCloseTo(150, 6);
    expect(pathLengthM(parts.visible)).toBeCloseTo(600, 6);
    expect(pathLengthM(parts.end)).toBeCloseTo(250, 6);
    expect(parts.start.at(-1)).toEqual(parts.visible[0]);
    expect(parts.visible.at(-1)).toEqual(parts.end[0]);
  });

  it("cuts exactly on a reading when the distance lands on one", () => {
    const parts = hideRouteEnds(route, 200, 300);
    expect(parts.start).toEqual(route.slice(0, 3));
    expect(parts.visible).toEqual(route.slice(2, 8));
    expect(parts.end).toEqual(route.slice(7));
  });

  it("shows the whole route when nothing is hidden", () => {
    expect(hideRouteEnds(route, 0, 0)).toEqual({ start: [], visible: route, end: [] });
  });

  it("shows nothing when the hidden ends cover the route", () => {
    expect(hideRouteEnds(route, 600, 500)).toEqual({ start: route, visible: [], end: [] });
    expect(hideRouteEnds(route, 2000, 0).visible).toEqual([]);
  });

  it("cuts both ends inside one long step", () => {
    const parts = hideRouteEnds(north(1000, 1000), 100, 100);
    expect(parts.visible).toHaveLength(2);
    expect(pathLengthM(parts.visible)).toBeCloseTo(800, 6);
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
