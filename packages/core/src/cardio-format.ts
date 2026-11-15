import { DurationSeconds, formatDuration } from "./duration.ts";
import type { CardioKind } from "./recording.ts";

/** Kilometres to two decimals, cut rather than rounded, so 4,996 m does not read as 5.00. */
export const formatKm = (metres: number): string => (Math.floor(metres / 10) / 100).toFixed(2);

/** Below this a pace swings wildly with every reading, so none is shown. */
const MIN_PACE_DISTANCE_M = 10;

/** What a sport measures its speed in. Rides use speed, the rest pace. */
export type PaceMeasure = { readonly label: string; readonly unit: string };

export const paceMeasure = (kind: CardioKind): PaceMeasure =>
  kind === "ride" ? { label: "Speed", unit: "km/h" } : { label: "Pace", unit: "/km" };

/**
 * Pace as minutes and seconds per kilometre, or speed in km/h for a ride. A dash
 * until there is enough distance to say.
 */
export const formatPace = (kind: CardioKind, distanceM: number, durationS: number): string => {
  if (distanceM < MIN_PACE_DISTANCE_M || durationS <= 0) return "–";
  if (kind === "ride") return ((distanceM / durationS) * 3.6).toFixed(1);
  return formatDuration(DurationSeconds.make(Math.round((durationS / distanceM) * 1000)));
};

/** Metres climbed to the nearest metre, or a dash when the altitude is unknown. */
export const formatClimbM = (metres: number | null): string =>
  metres === null ? "–" : String(Math.round(metres));
