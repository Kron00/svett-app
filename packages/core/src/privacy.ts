import { Schema } from "effect";

import { distanceMeters, type TrackPoint } from "./track.ts";

export const Audience = Schema.Literals(["only-you", "followers", "everyone"]);

export type Audience = typeof Audience.Type;

export const DEFAULT_AUDIENCE: Audience = "only-you";

export const HiddenField = Schema.Literals([
  "weight",
  "heart-rate",
  "start-time",
  "calories",
  "pace",
]);

export type HiddenField = typeof HiddenField.Type;

const METERS_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;

// Over a few hundred metres a flat projection around the centre is accurate enough.
const lineComesWithin = (
  a: TrackPoint,
  b: TrackPoint,
  center: TrackPoint,
  meters: number,
): boolean => {
  const scale = Math.cos((center.lat * Math.PI) / 180);
  const ax = (a.lon - center.lon) * scale * METERS_PER_DEGREE;
  const ay = (a.lat - center.lat) * METERS_PER_DEGREE;
  const dx = (b.lon - center.lon) * scale * METERS_PER_DEGREE - ax;
  const dy = (b.lat - center.lat) * METERS_PER_DEGREE - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy) < meters;
};

/**
 * Hides every point within `hideMeters` of where the route starts or ends, including a pass
 * near home in the middle of the route. Returns the visible stretches separately, and breaks a
 * stretch wherever the line between two points would cross a hidden area.
 */
export const trimRoute = (
  points: ReadonlyArray<TrackPoint>,
  hideMeters = 200,
): ReadonlyArray<ReadonlyArray<TrackPoint>> => {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return [];
  const stretches: Array<Array<TrackPoint>> = [[]];
  for (const point of points) {
    const hidden =
      distanceMeters(first, point) < hideMeters || distanceMeters(last, point) < hideMeters;
    const current = stretches.at(-1)!;
    const previous = current.at(-1);
    if (hidden) {
      if (current.length > 0) stretches.push([]);
    } else if (
      previous !== undefined &&
      (lineComesWithin(previous, point, first, hideMeters) ||
        lineComesWithin(previous, point, last, hideMeters))
    ) {
      stretches.push([point]);
    } else {
      current.push(point);
    }
  }
  return stretches.filter((stretch) => stretch.length >= 2);
};
