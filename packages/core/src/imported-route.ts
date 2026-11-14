import { distanceM } from "./geo.ts";
import {
  type CardioKind,
  type Fix,
  MOTION,
  type Segment,
  segmentTrack,
  type TrackPoint,
} from "./recording.ts";
import { addReading, emptyTrack } from "./track-filter.ts";

/** A phone at rest drifts up to about 10 m either way, so its readings stay this close to each other. */
export const STAY_RADIUS_M = 20;
/**
 * Readings that stay that close to the first of them for this long are a stop. Moving
 * at `STILL_SPEED_MPS` or faster leaves the radius sooner.
 */
export const STAY_MS = 60_000;

/**
 * The readings with a speed of 0 where they are part of a stop, for a route read from a
 * file. The phone's own speed tells K1's filter a stop from slow movement, but files
 * rarely carry it, and by position alone the filter counts drift at a stop after moving
 * as distance. A file holds every reading at once, so a stop is found by looking ahead:
 * readings that all lie within `STAY_RADIUS_M` of the first of them for `STAY_MS`. It
 * lasts while each next reading lies that close to the average of the stop so far. A
 * reading that reports its own speed keeps it.
 */
export const withStops = (fixes: ReadonlyArray<Fix>): Array<Fix> => {
  const still = new Array<boolean>(fixes.length).fill(false);
  let start = 0;
  while (start < fixes.length) {
    const first = fixes[start]!;
    let end = start + 1;
    while (end < fixes.length && distanceM(first, fixes[end]!) <= STAY_RADIUS_M) end++;
    if (fixes[end - 1]!.at - first.at < STAY_MS) {
      start++;
      continue;
    }
    let latitude = 0;
    let longitude = 0;
    for (let index = start; index < end; index++) {
      latitude += fixes[index]!.latitude;
      longitude += fixes[index]!.longitude;
    }
    for (; end < fixes.length; end++) {
      const count = end - start;
      const centre = { latitude: latitude / count, longitude: longitude / count };
      if (distanceM(centre, fixes[end]!) > STAY_RADIUS_M) break;
      latitude += fixes[end]!.latitude;
      longitude += fixes[end]!.longitude;
    }
    still.fill(true, start, end);
    start = end;
  }
  return fixes.map((fix, index) =>
    still[index] && (fix.speedMps === undefined || fix.speedMps === null)
      ? { ...fix, speedMps: 0 }
      : fix,
  );
};

/** A point of an imported route, as K1's filter reads it. */
export interface ImportedRoutePoint {
  readonly recordedAt: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeM: number | null;
}

/** An imported route after K1's filter: each stretch as a segment, and the points it saves. */
export interface FilteredRoute {
  readonly segments: ReadonlyArray<Segment>;
  readonly tracks: ReadonlyArray<ReadonlyArray<TrackPoint>>;
  /** What the stretches add up to. */
  readonly distanceM: number;
}

/**
 * Each stretch of an imported route through K1's filter, one filter per stretch, as a
 * recording's stretches are. A stretch runs from its first point to its last, so a gap
 * between two stretches is a pause.
 */
export const filterRoute = (
  stretches: ReadonlyArray<ReadonlyArray<ImportedRoutePoint>>,
  kind: CardioKind,
): FilteredRoute => {
  const segments = stretches
    .filter((stretch) => stretch.length > 0)
    .map((stretch): Segment => {
      const fixes = withStops(
        stretch.map((point) => ({
          at: point.recordedAt,
          latitude: point.latitude,
          longitude: point.longitude,
          altitudeM: point.altitudeM,
          altitudeAccuracyM: null,
          accuracyM: null,
        })),
      );
      return {
        ...fixes.reduce(addReading, emptyTrack<Fix>(MOTION[kind])),
        from: stretch[0]!.recordedAt,
        to: stretch.at(-1)!.recordedAt,
      };
    });
  const tracks = segments.map(segmentTrack);
  return {
    segments,
    tracks,
    distanceM: tracks.reduce((total, track) => total + (track.at(-1)?.alongM ?? 0), 0),
  };
};
