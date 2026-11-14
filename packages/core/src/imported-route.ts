import {
  type CardioKind,
  type Fix,
  MOTION,
  type Segment,
  segmentTrack,
  type TrackPoint,
} from "./recording.ts";
import { addReading, emptyTrack } from "./track-filter.ts";

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

/** One stretch through a filter of its own, as a recording's segment from its first point to its last. */
const segmentOf = (stretch: ReadonlyArray<ImportedRoutePoint>, kind: CardioKind): Segment => {
  const fixes = stretch.map((point): Fix => ({
    at: point.recordedAt,
    latitude: point.latitude,
    longitude: point.longitude,
    altitudeM: point.altitudeM,
    altitudeAccuracyM: null,
    accuracyM: null,
  }));
  return {
    ...fixes.reduce(addReading, emptyTrack<Fix>(MOTION[kind])),
    from: stretch[0]!.recordedAt,
    to: stretch.at(-1)!.recordedAt,
  };
};

/**
 * Each stretch of an imported route through K1's filter, one filter per stretch, as a
 * recording's stretches are, so a gap between two stretches is a pause.
 */
export const filterRoute = (
  stretches: ReadonlyArray<ReadonlyArray<ImportedRoutePoint>>,
  kind: CardioKind,
): FilteredRoute => {
  const segments = stretches
    .filter((stretch) => stretch.length > 0)
    .map((stretch) => segmentOf(stretch, kind));
  const tracks = segments.map(segmentTrack);
  return {
    segments,
    tracks,
    distanceM: tracks.reduce((total, track) => total + (track.at(-1)?.alongM ?? 0), 0),
  };
};
