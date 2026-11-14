import { DurationSeconds } from "./duration.ts";
import { distanceM, hideRouteEnds, type LatLng, type RouteLines } from "./geo.ts";
import {
  type CardioKind,
  type Fix,
  type Recording,
  recordedDistanceM,
  segmentFixes,
} from "./recording.ts";
import type { ActivityDraft, SampleDraft } from "./repositories/activities.ts";
import { MADE_HERE } from "./repositories/origin.ts";
import { type ActivityId, type ActivitySample, type ActivityTrack, EpochMillis } from "./schema.ts";

export const SPLIT_M = 1000;

/** One kilometre of a recording, or the shorter rest at the end. */
export interface Split {
  readonly distanceM: number;
  readonly durationS: number;
  /** When the split ended, by the phone's clock. */
  readonly endedAt: number;
}

/** A point on the timeline of a recording: its clock time, moving time and distance so far. */
interface Mark {
  readonly at: number;
  readonly movingMs: number;
  readonly distanceM: number;
}

const marksOf = (segments: Recording["segments"], end: number): ReadonlyArray<Mark> => {
  const marks: Mark[] = [];
  let moving = 0;
  let distance = 0;
  for (const segment of segments) {
    const to = segment.to ?? end;
    let clock = segment.from;
    let previous: Fix | undefined;
    marks.push({ at: clock, movingMs: moving, distanceM: distance });
    for (const fix of segmentFixes(segment, true)) {
      moving += fix.at - clock;
      clock = fix.at;
      if (previous !== undefined) distance += distanceM(previous, fix);
      previous = fix;
      marks.push({ at: clock, movingMs: moving, distanceM: distance });
    }
    moving += Math.max(0, to - clock);
    marks.push({ at: Math.max(to, clock), movingMs: moving, distanceM: distance });
  }
  return marks;
};

/**
 * Cuts the recording into splits of `everyM`. Each boundary's time is interpolated
 * between the readings either side of it. The last split holds whatever distance and
 * moving time are left, so the splits always add up to the whole recording.
 */
export const splitsOf = (recording: Recording, end: number, everyM = SPLIT_M): Split[] => {
  const marks = marksOf(recording.segments, end);
  const splits: Split[] = [];
  let splitStart: Mark = marks[0]!;
  for (let index = 1; index < marks.length; index++) {
    const from = marks[index - 1]!;
    const to = marks[index]!;
    let boundary = (splits.length + 1) * everyM;
    while (to.distanceM >= boundary && to.distanceM > from.distanceM) {
      const fraction = (boundary - from.distanceM) / (to.distanceM - from.distanceM);
      const crossing: Mark = {
        at: from.at + (to.at - from.at) * fraction,
        movingMs: from.movingMs + (to.movingMs - from.movingMs) * fraction,
        distanceM: boundary,
      };
      splits.push({
        distanceM: everyM,
        durationS: (crossing.movingMs - splitStart.movingMs) / 1000,
        endedAt: Math.round(crossing.at),
      });
      splitStart = crossing;
      boundary = (splits.length + 1) * everyM;
    }
  }
  const last = marks.at(-1)!;
  const rest = {
    distanceM: last.distanceM - splitStart.distanceM,
    durationS: (last.movingMs - splitStart.movingMs) / 1000,
  };
  if (rest.distanceM > 0 || rest.durationS > 0) splits.push({ ...rest, endedAt: last.at });
  return splits;
};

/** Below this, a rise in smoothed altitude is noise, not a climb. */
export const CLIMB_THRESHOLD_M = 3;
/** Each altitude is averaged with the readings this long either side of it. */
export const ALTITUDE_SMOOTHING_MS = 15_000;
// An altitude with no stated accuracy is trusted like a poor one.
const UNSTATED_ALTITUDE_ACCURACY_M = 10;
const MIN_ALTITUDE_ACCURACY_M = 1;

export interface AltitudeReading {
  readonly at: number;
  readonly altitudeM: number | null;
  readonly altitudeAccuracyM: number | null;
}

/**
 * Each altitude replaced by the mean of the readings within ALTITUDE_SMOOTHING_MS
 * of it, each weighted by how sure it is, so GPS altitude noise averages out.
 */
export const smoothAltitudes = (readings: ReadonlyArray<AltitudeReading>): number[] => {
  const known = readings.flatMap(({ at, altitudeM, altitudeAccuracyM }) => {
    if (altitudeM === null) return [];
    const accuracy = Math.max(
      MIN_ALTITUDE_ACCURACY_M,
      altitudeAccuracyM ?? UNSTATED_ALTITUDE_ACCURACY_M,
    );
    return [{ at, altitudeM, weight: 1 / accuracy ** 2 }];
  });
  // Summed afresh for each reading: a running sum drifts, and a climb of exactly the
  // threshold must still count.
  const smoothed: number[] = [];
  let first = 0;
  let last = 0;
  for (const reading of known) {
    while (known[first]!.at < reading.at - ALTITUDE_SMOOTHING_MS) first++;
    while (last + 1 < known.length && known[last + 1]!.at <= reading.at + ALTITUDE_SMOOTHING_MS) {
      last++;
    }
    let weights = 0;
    let sum = 0;
    for (let index = first; index <= last; index++) {
      weights += known[index]!.weight;
      sum += known[index]!.weight * known[index]!.altitudeM;
    }
    smoothed.push(sum / weights);
  }
  return smoothed;
};

/**
 * Metres climbed, from each stretch's smoothed altitude. A climb counts once the
 * altitude is CLIMB_THRESHOLD_M above the lowest point since the last climb, so what
 * noise is left adds nothing. Stretches are climbed separately, because the altitude
 * changed while paused is not a climb. Null when no reading had an altitude.
 */
export const elevationGainM = (
  stretches: ReadonlyArray<ReadonlyArray<AltitudeReading>>,
): number | null => {
  let gain: number | null = null;
  for (const stretch of stretches) {
    const altitudes = smoothAltitudes(stretch);
    if (altitudes.length === 0) continue;
    gain ??= 0;
    let base = altitudes[0]!;
    for (const altitude of altitudes) {
      if (altitude < base) base = altitude;
      else if (altitude - base >= CLIMB_THRESHOLD_M) {
        gain += altitude - base;
        base = altitude;
      }
    }
  }
  return gain;
};

export interface CardioSummary {
  readonly activityId: ActivityId;
  readonly kind: CardioKind;
  readonly startedAt: number;
  readonly durationS: number;
  readonly distanceM: number;
  readonly elevationGainM: number | null;
  /** The readings kept, one list for each stretch between start or resume and pause. */
  readonly segments: ReadonlyArray<ReadonlyArray<Fix>>;
  readonly splits: ReadonlyArray<Split>;
}

/** The finished recording, with any stretch still open ending at `end`. */
export const summarize = (recording: Recording, end: number): CardioSummary => {
  const splits = splitsOf(recording, end);
  const segments = recording.segments.map((segment) => segmentFixes(segment, true));
  return {
    activityId: recording.activityId,
    kind: recording.kind,
    startedAt: recording.startedAt,
    durationS: splits.reduce((total, split) => total + split.durationS, 0),
    distanceM: recordedDistanceM(recording, true),
    elevationGainM: elevationGainM(segments),
    segments,
    splits,
  };
};

/** How much of each end of a new route is hidden from others. */
export const DEFAULT_HIDE_M = 200;

const SPORT_NAME: Readonly<Record<CardioKind, string>> = {
  run: "run",
  walk: "walk",
  hike: "hike",
  ride: "ride",
};

/** "Morning run", "Evening ride", from the local hour the activity started. */
export const cardioTitle = (kind: CardioKind, localHour: number): string => {
  const part =
    localHour < 5
      ? "Night"
      : localHour < 12
        ? "Morning"
        : localHour < 17
          ? "Afternoon"
          : localHour < 21
            ? "Evening"
            : "Night";
  return `${part} ${SPORT_NAME[kind]}`;
};

export const cardioDraft = (summary: CardioSummary, title: string): ActivityDraft => ({
  id: summary.activityId,
  kind: summary.kind,
  startedAt: EpochMillis.make(summary.startedAt),
  durationS: DurationSeconds.make(summary.durationS),
  title,
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: [],
  origin: MADE_HERE,
  exercises: [],
  track: {
    distanceM: summary.distanceM,
    elevationGainM: summary.elevationGainM,
    hideStartM: DEFAULT_HIDE_M,
    hideEndM: DEFAULT_HIDE_M,
    samples: [
      ...summary.segments.flatMap((fixes, segment) =>
        fixes.map((fix): SampleDraft => ({
          kind: "location",
          recordedAt: EpochMillis.make(fix.at),
          segment,
          latitude: fix.latitude,
          longitude: fix.longitude,
          altitudeM: fix.altitudeM,
        })),
      ),
      ...summary.splits.map((split): SampleDraft => ({
        kind: "split",
        recordedAt: EpochMillis.make(split.endedAt),
        distanceM: split.distanceM,
        durationS: DurationSeconds.make(split.durationS),
      })),
    ],
  },
});

type LocationSample = Extract<ActivitySample, { readonly kind: "location" }>;
type SplitSample = Extract<ActivitySample, { readonly kind: "split" }>;

/** Location samples as route lines, one for each stretch, each in the order recorded. */
export const routeLinesOf = (route: ReadonlyArray<LocationSample>): LocationSample[][] => {
  const lines = new Map<number, LocationSample[]>();
  for (const sample of route) {
    const line = lines.get(sample.segment);
    if (line === undefined) lines.set(sample.segment, [sample]);
    else line.push(sample);
  }
  return [...lines.entries()].sort(([a], [b]) => a - b).map(([, line]) => line);
};

/** A saved track's samples, sorted by kind, in the order they were recorded. */
export const trackParts = (samples: ReadonlyArray<ActivitySample>) => {
  const route = samples.filter((sample): sample is LocationSample => sample.kind === "location");
  return {
    route,
    lines: routeLinesOf(route),
    splits: samples.filter((sample): sample is SplitSample => sample.kind === "split"),
  };
};

export interface ProfilePoint {
  /** Distance along the route at the end of this stretch. */
  readonly distanceM: number;
  readonly altitudeM: number;
}

/**
 * The route's altitude in `stretches` equal lengths, each the mean of its readings,
 * for an elevation chart. Distance runs on along each line and stops across the gap
 * between two. Empty when the route has no altitude.
 */
export const elevationProfile = (lines: RouteLines, stretches = 12): ProfilePoint[] => {
  const along: Array<{ distanceM: number; altitudeM: number }> = [];
  let travelled = 0;
  for (const line of lines) {
    for (const [index, point] of line.entries()) {
      if (index > 0) travelled += distanceM(line[index - 1]!, point);
      if (point.altitudeM !== null)
        along.push({ distanceM: travelled, altitudeM: point.altitudeM });
    }
  }
  if (along.length === 0 || travelled === 0) return [];
  const length = travelled / stretches;
  const profile: ProfilePoint[] = [];
  for (let index = 0; index < stretches; index++) {
    const end = length * (index + 1);
    const inside = along.filter(
      (point) =>
        point.distanceM >= length * index &&
        (index === stretches - 1 ? point.distanceM <= end : point.distanceM < end),
    );
    if (inside.length === 0) continue;
    const mean = inside.reduce((total, point) => total + point.altitudeM, 0) / inside.length;
    profile.push({ distanceM: end, altitudeM: mean });
  }
  return profile;
};

/** What anyone but the owner may see of a track. */
export interface SharedTrack {
  readonly distanceM: number | null;
  readonly elevationGainM: number | null;
  /** Only the visible stretch, as lines of positions with no time and no altitude. */
  readonly route: ReadonlyArray<ReadonlyArray<LatLng>>;
  /** The elevation chart of the visible stretch, measured from where it begins. */
  readonly profile: ReadonlyArray<ProfilePoint>;
  readonly splits: ReadonlyArray<{ readonly distanceM: number; readonly durationS: number }>;
}

/**
 * The one view of a track for anyone but its owner: the feed, a share, an export
 * for someone else. It leaves out every position in the hidden start and end and
 * every reading's time. Owner screens read the samples themselves.
 */
export const sharedTrack = (
  track: Pick<ActivityTrack, "distanceM" | "elevationGainM" | "hideStartM" | "hideEndM">,
  samples: ReadonlyArray<ActivitySample>,
): SharedTrack => {
  const parts = trackParts(samples);
  const visible = hideRouteEnds(parts.lines, track.hideStartM, track.hideEndM).visible;
  return {
    distanceM: track.distanceM,
    elevationGainM: track.elevationGainM,
    route: visible.map((line) => line.map(({ latitude, longitude }) => ({ latitude, longitude }))),
    profile: elevationProfile(visible),
    splits: parts.splits.map((split) => ({
      distanceM: split.distanceM,
      durationS: split.durationS,
    })),
  };
};
