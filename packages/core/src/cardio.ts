import { DurationSeconds } from "./duration.ts";
import { distanceM } from "./geo.ts";
import { type CardioKind, type Fix, type Recording, recordedDistanceM } from "./recording.ts";
import type { ActivityDraft, SampleDraft } from "./repositories/activities.ts";
import { MADE_HERE } from "./repositories/origin.ts";
import { type ActivitySample, EpochMillis } from "./schema.ts";

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
    for (const fix of segment.fixes) {
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

/** Below this, a rise in GPS altitude is noise, not a climb. */
export const CLIMB_THRESHOLD_M = 3;

/**
 * Metres climbed. A climb counts once the altitude is CLIMB_THRESHOLD_M above the
 * lowest point since the last climb, so GPS altitude wobble on the flat adds nothing.
 * Null when no reading had an altitude.
 */
export const elevationGainM = (altitudes: ReadonlyArray<number | null>): number | null => {
  const known = altitudes.filter((altitude): altitude is number => altitude !== null);
  if (known.length === 0) return null;
  let gain = 0;
  let base = known[0]!;
  for (const altitude of known) {
    if (altitude < base) base = altitude;
    else if (altitude - base >= CLIMB_THRESHOLD_M) {
      gain += altitude - base;
      base = altitude;
    }
  }
  return gain;
};

export interface CardioSummary {
  readonly kind: CardioKind;
  readonly startedAt: number;
  readonly durationS: number;
  readonly distanceM: number;
  readonly elevationGainM: number | null;
  readonly fixes: ReadonlyArray<Fix>;
  readonly splits: ReadonlyArray<Split>;
}

/** The finished recording, with any stretch still open ending at `end`. */
export const summarize = (recording: Recording, end: number): CardioSummary => {
  const splits = splitsOf(recording, end);
  const fixes = recording.segments.flatMap((segment) => segment.fixes);
  return {
    kind: recording.kind,
    startedAt: recording.startedAt,
    durationS: splits.reduce((total, split) => total + split.durationS, 0),
    distanceM: recordedDistanceM(recording),
    elevationGainM: elevationGainM(fixes.map((fix) => fix.altitudeM)),
    fixes,
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
      ...summary.fixes.map((fix): SampleDraft => ({
        kind: "location",
        recordedAt: EpochMillis.make(fix.at),
        latitude: fix.latitude,
        longitude: fix.longitude,
        altitudeM: fix.altitudeM,
      })),
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

/** A saved track's samples, sorted by kind, in the order they were recorded. */
export const trackParts = (samples: ReadonlyArray<ActivitySample>) => ({
  route: samples.filter((sample): sample is LocationSample => sample.kind === "location"),
  splits: samples.filter((sample): sample is SplitSample => sample.kind === "split"),
});

export interface ProfilePoint {
  /** Distance along the route at the end of this stretch. */
  readonly distanceM: number;
  readonly altitudeM: number;
}

/**
 * The route's altitude in `stretches` equal lengths, each the mean of its readings,
 * for an elevation chart. Empty when the route has no altitude.
 */
export const elevationProfile = (
  route: ReadonlyArray<{
    readonly latitude: number;
    readonly longitude: number;
    readonly altitudeM: number | null;
  }>,
  stretches = 12,
): ProfilePoint[] => {
  const along: Array<{ distanceM: number; altitudeM: number }> = [];
  let travelled = 0;
  for (const [index, point] of route.entries()) {
    if (index > 0) travelled += distanceM(route[index - 1]!, point);
    if (point.altitudeM !== null) along.push({ distanceM: travelled, altitudeM: point.altitudeM });
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
