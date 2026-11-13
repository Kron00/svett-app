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

/**
 * Hides every point within `hideMeters` of where the route starts or ends, including a pass
 * near home in the middle of the route. Returns the visible stretches separately, so a map
 * never draws a line through a hidden area.
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
    if (!hidden) stretches.at(-1)!.push(point);
    else if (stretches.at(-1)!.length > 0) stretches.push([]);
  }
  return stretches.filter((stretch) => stretch.length >= 2);
};
