import { Schema } from "effect";

import type { ActivityKind } from "./activity-kind.ts";

export const TrackPoint = Schema.Struct({
  at: Schema.Number.check(Schema.isFinite()),
  lat: Schema.Number.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
  lon: Schema.Number.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  accuracyMeters: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  altitudeMeters: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
});

export type TrackPoint = typeof TrackPoint.Type;

type Position = Pick<TrackPoint, "lat" | "lon">;

const EARTH_RADIUS_METERS = 6_371_008.8;
const MAX_ACCURACY_METERS = 30;

const MAX_SPEED_MPS: Record<ActivityKind, number> = {
  strength: 4,
  walk: 4,
  hike: 4,
  run: 12,
  ride: 30,
  other: 30,
};

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export const distanceMeters = (a: Position, b: Position): number => {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
};

const secondsBetween = (a: TrackPoint, b: TrackPoint): number => (b.at - a.at) / 1000;

export const cleanTrack = (
  points: ReadonlyArray<TrackPoint>,
  kind: ActivityKind,
): ReadonlyArray<TrackPoint> => {
  const plausible = (from: TrackPoint, to: TrackPoint, slackMeters = 0): boolean => {
    const seconds = secondsBetween(from, to);
    const meters = Math.max(0, distanceMeters(from, to) - slackMeters);
    return seconds > 0 && meters / seconds <= MAX_SPEED_MPS[kind];
  };
  const kept: Array<TrackPoint> = [];
  let rejected: Array<TrackPoint> = [];
  let held: TrackPoint | undefined;
  // Accepted fixes by whole metres of accuracy, so a run of bad fixes is weighed only against
  // fixes at least as accurate as it is.
  let accepted: Array<number> = Array.from({ length: MAX_ACCURACY_METERS + 1 }, () => 0);
  const accept = (point: TrackPoint): void => {
    accepted[Math.ceil(point.accuracyMeters ?? 0)]! += 1;
  };
  const acceptedAsAccurateAs = (run: ReadonlyArray<TrackPoint>): number => {
    const worst = Math.ceil(Math.max(...run.map((fix) => fix.accuracyMeters ?? 0)));
    return accepted.slice(0, worst + 1).reduce((sum, count) => sum + count, 0);
  };
  for (const point of points) {
    if ((point.accuracyMeters ?? 0) > MAX_ACCURACY_METERS) continue;
    const last = kept.at(-1);
    const latest = held ?? last;
    if (latest !== undefined && latest.at >= point.at) continue;
    const jitter = (last?.accuracyMeters ?? 0) + (point.accuracyMeters ?? 0);
    if (last !== undefined && distanceMeters(last, point) <= jitter) {
      // Two fixes of one spot can sit up to both error radii apart. Only the last one's time is kept.
      held = { ...last, at: point.at };
      rejected = [];
      accept(point);
    } else if (
      last === undefined ||
      // After a stop, a jump must also be plausible from the latest still fix, not only from
      // where the stop began.
      (plausible(last, point) && (held === undefined || plausible(held, point, jitter)))
    ) {
      kept.push(point);
      rejected = [];
      held = undefined;
      accept(point);
    } else {
      const previous = rejected.at(-1);
      rejected =
        previous !== undefined && plausible(previous, point) ? [...rejected, point] : [point];
      // A run of at least three agreeing fixes outvotes the fixes accepted before it that are
      // at least as accurate, such as stale or coarse cached fixes at the start of a recording.
      if (rejected.length >= 3 && rejected.length > acceptedAsAccurateAs(rejected)) {
        kept.splice(0, kept.length, ...rejected);
        accepted = accepted.map(() => 0);
        for (const fix of rejected) accept(fix);
        rejected = [];
        held = undefined;
      }
    }
  }
  return held === undefined ? kept : [...kept, held];
};

export const cumulativeMeters = (points: ReadonlyArray<Position>): ReadonlyArray<number> => {
  let walked = 0;
  return points.map((point, i) => {
    const previous = points[i - 1];
    walked += previous === undefined ? 0 : distanceMeters(previous, point);
    return walked;
  });
};

export const trackDistanceMeters = (points: ReadonlyArray<TrackPoint>): number =>
  cumulativeMeters(points).at(-1) ?? 0;

export const elapsedSeconds = (points: ReadonlyArray<TrackPoint>): number => {
  const first = points[0];
  const last = points.at(-1);
  return first === undefined || last === undefined ? 0 : secondsBetween(first, last);
};

export const movingSeconds = (
  points: ReadonlyArray<TrackPoint>,
  { minSpeedMps = 0.5 }: { readonly minSpeedMps?: number } = {},
): number => {
  let moving = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seconds = secondsBetween(a, b);
    if (seconds > 0 && distanceMeters(a, b) / seconds >= minSpeedMps) moving += seconds;
  }
  return moving;
};

export const paceSecondsPerKm = (seconds: number, meters: number): number | undefined =>
  meters > 0 ? seconds / (meters / 1000) : undefined;

export interface Split {
  readonly index: number;
  readonly meters: number;
  readonly seconds: number;
}

// A boundary within this of the finish ends the last split instead of opening a near-empty one.
const SPLIT_EPSILON_METERS = 1e-6;

export const splits = (
  points: ReadonlyArray<TrackPoint>,
  splitMeters: number,
): ReadonlyArray<Split> => {
  if (!(splitMeters > 0)) throw new RangeError(`splitMeters must be positive, got ${splitMeters}`);
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || points.length < 2) return [];
  const along = cumulativeMeters(points);
  const total = along.at(-1)!;
  const result: Array<Split> = [];
  let startAt = first.at;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const from = along[i - 1]!;
    const to = along[i]!;
    let boundary = (result.length + 1) * splitMeters;
    while (boundary <= to && boundary < total - SPLIT_EPSILON_METERS) {
      const at = a.at + ((boundary - from) / (to - from)) * (b.at - a.at);
      result.push({ index: result.length, meters: splitMeters, seconds: (at - startAt) / 1000 });
      startAt = at;
      boundary = (result.length + 1) * splitMeters;
    }
  }
  result.push({
    index: result.length,
    meters: total - result.length * splitMeters,
    seconds: (last.at - startAt) / 1000,
  });
  return result;
};

export type LocationAccuracy = "best" | "ten-meters";

export interface LocationPlan {
  readonly accuracy: LocationAccuracy;
  readonly distanceFilterMeters: number;
  readonly background: true;
}

const plan = (accuracy: LocationAccuracy, distanceFilterMeters: number): LocationPlan => ({
  accuracy,
  distanceFilterMeters,
  background: true,
});

const LOCATION_PLANS: Record<
  ActivityKind,
  { readonly normal: LocationPlan; readonly lowPower: LocationPlan } | null
> = {
  strength: null,
  other: null,
  walk: { normal: plan("best", 5), lowPower: plan("ten-meters", 15) },
  hike: { normal: plan("best", 10), lowPower: plan("ten-meters", 25) },
  run: { normal: plan("best", 5), lowPower: plan("ten-meters", 15) },
  ride: { normal: plan("best", 10), lowPower: plan("ten-meters", 30) },
};

export const locationPlan = (
  kind: ActivityKind,
  { lowPowerMode }: { readonly lowPowerMode: boolean },
): LocationPlan | null => LOCATION_PLANS[kind]?.[lowPowerMode ? "lowPower" : "normal"] ?? null;
