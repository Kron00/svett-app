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

const between = (a: LatLng, b: LatLng, fraction: number): LatLng => ({
  latitude: a.latitude + (b.latitude - a.latitude) * fraction,
  longitude: a.longitude + (b.longitude - a.longitude) * fraction,
});

/**
 * The route cut into the stretch others may see and the stretches hidden at each
 * end, measured along the route. Neighbouring parts share their cut point, so the
 * three lines meet. When the hidden stretches cover the whole route, all of it is
 * in `start` and nothing is visible.
 */
export interface RouteParts {
  readonly start: ReadonlyArray<LatLng>;
  readonly visible: ReadonlyArray<LatLng>;
  readonly end: ReadonlyArray<LatLng>;
}

// A cut this close to a reading falls on the reading, so rounding in the sums does
// not add a second point a hair away from it.
const ON_POINT_M = 1e-6;

export const hideRouteEnds = (
  points: ReadonlyArray<LatLng>,
  hideStartM: number,
  hideEndM: number,
): RouteParts => {
  const total = pathLengthM(points);
  if (points.length < 2 || hideStartM + hideEndM >= total) {
    return { start: points, visible: [], end: [] };
  }
  const startCut = Math.max(0, hideStartM);
  const endCut = total - Math.max(0, hideEndM);
  const start: LatLng[] = [];
  const visible: LatLng[] = [];
  const end: LatLng[] = [];
  let travelled = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    if (index > 0) {
      const previous = points[index - 1]!;
      const step = distanceM(previous, point);
      for (const cut of [startCut, endCut]) {
        if (cut > travelled + ON_POINT_M && cut < travelled + step - ON_POINT_M) {
          const at = between(previous, point, (cut - travelled) / step);
          (cut === startCut ? start : visible).push(at);
          (cut === startCut ? visible : end).push(at);
        }
      }
      travelled += step;
    }
    if (travelled <= startCut + ON_POINT_M) start.push(point);
    if (travelled >= startCut - ON_POINT_M && travelled <= endCut + ON_POINT_M) {
      visible.push(point);
    }
    if (travelled >= endCut - ON_POINT_M) end.push(point);
  }
  return { start: start.length > 1 ? start : [], visible, end: end.length > 1 ? end : [] };
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
