import { Schema } from "effect";

import { cumulativeMeters, distanceMeters, type TrackPoint } from "./track.ts";

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

// Each end is trimmed by path distance and by straight-line distance, so a route that winds
// around home for its first stretch still starts at least hideMeters away from it.
export const trimRoute = (
  points: ReadonlyArray<TrackPoint>,
  hideMeters = 200,
): ReadonlyArray<TrackPoint> => {
  const along = cumulativeMeters(points);
  const total = along.at(-1) ?? 0;
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || total <= 2 * hideMeters) return [];
  const start = points.findIndex(
    (point, i) => along[i]! >= hideMeters && distanceMeters(first, point) >= hideMeters,
  );
  const end = points.findLastIndex(
    (point, i) => total - along[i]! >= hideMeters && distanceMeters(point, last) >= hideMeters,
  );
  return start === -1 || end < start ? [] : points.slice(start, end + 1);
};
