export interface LatLng {
  readonly latitude: number;
  readonly longitude: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** The great-circle distance between two points, by the haversine formula. */
export const distanceM = (a: LatLng, b: LatLng): number => {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const pathLengthM = (points: ReadonlyArray<LatLng>): number => {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += distanceM(points[index - 1]!, points[index]!);
  }
  return total;
};

/** A reading on a route. `altitudeM` is null when it was not measured. */
export interface RoutePoint extends LatLng {
  readonly altitudeM: number | null;
}

/**
 * A route as recorded: one line of readings for each stretch between start or
 * resume and the next pause. Nothing joins two stretches, since where you went
 * while paused was not recorded.
 */
export type RouteLines = ReadonlyArray<ReadonlyArray<RoutePoint>>;

export const routeLengthM = (lines: RouteLines): number =>
  lines.reduce((total, line) => total + pathLengthM(line), 0);

const between = (a: RoutePoint, b: RoutePoint, fraction: number): RoutePoint => ({
  latitude: a.latitude + (b.latitude - a.latitude) * fraction,
  longitude: a.longitude + (b.longitude - a.longitude) * fraction,
  altitudeM:
    a.altitudeM === null || b.altitudeM === null
      ? null
      : a.altitudeM + (b.altitudeM - a.altitudeM) * fraction,
});

// A cut this close to a reading falls on the reading, so rounding in the sums does
// not add a second point a hair away from it.
const ON_POINT_M = 1e-6;

/**
 * The part of the route from `fromM` to `toM` along it, cut between readings where
 * needed. Distance along the route adds up inside each line only.
 */
export const sliceRoute = (lines: RouteLines, fromM: number, toM: number): RouteLines => {
  const slices: RoutePoint[][] = [];
  let travelled = 0;
  for (const line of lines) {
    const slice: RoutePoint[] = [];
    for (const [index, point] of line.entries()) {
      if (index > 0) {
        const previous = line[index - 1]!;
        const step = distanceM(previous, point);
        for (const cut of [fromM, toM]) {
          if (cut > travelled + ON_POINT_M && cut < travelled + step - ON_POINT_M) {
            slice.push(between(previous, point, (cut - travelled) / step));
          }
        }
        travelled += step;
      }
      if (travelled >= fromM - ON_POINT_M && travelled <= toM + ON_POINT_M) slice.push(point);
    }
    if (slice.length > 1) slices.push(slice);
  }
  return slices;
};

/**
 * The route cut into the stretch others may see and the stretches hidden at each
 * end, measured along the route. Neighbouring parts share their cut point, so the
 * lines meet. When the hidden stretches cover the whole route, all of it is in
 * `start` and nothing is visible.
 */
export interface RouteParts {
  readonly start: RouteLines;
  readonly visible: RouteLines;
  readonly end: RouteLines;
}

export const hideRouteEnds = (
  lines: RouteLines,
  hideStartM: number,
  hideEndM: number,
): RouteParts => {
  const total = routeLengthM(lines);
  const startCut = Math.max(0, hideStartM);
  const endCut = total - Math.max(0, hideEndM);
  if (total === 0 || startCut >= endCut) {
    return { start: lines.filter((line) => line.length > 1), visible: [], end: [] };
  }
  return {
    start: startCut > 0 ? sliceRoute(lines, 0, startCut) : [],
    visible: sliceRoute(lines, startCut, endCut),
    end: endCut < total ? sliceRoute(lines, endCut, total) : [],
  };
};

/** A map camera that fits every point, with a margin, as expo-maps reads a zoom level. */
export interface MapRegion {
  readonly center: LatLng;
  readonly zoom: number;
}

// About 500 m, so a short route or a single point is not shown at street-corner zoom.
const MIN_SPAN_DEGREES = 0.005;
const MARGIN = 1.4;

export const regionFitting = (points: ReadonlyArray<LatLng>): MapRegion | null => {
  if (points.length === 0) return null;
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const [south, north] = [Math.min(...latitudes), Math.max(...latitudes)];
  const [west, east] = [Math.min(...longitudes), Math.max(...longitudes)];
  // expo-maps turns zoom z into a region spanning 360 / 2^z degrees each way.
  const span = Math.max(north - south, east - west, MIN_SPAN_DEGREES / MARGIN) * MARGIN;
  return {
    center: { latitude: (south + north) / 2, longitude: (west + east) / 2 },
    zoom: Math.log2(360 / span),
  };
};
