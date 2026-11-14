import { Option, Schema } from "effect";

import { distanceM } from "./geo.ts";
import { ActivityId } from "./schema.ts";

export const CardioKind = Schema.Literals(["run", "walk", "hike", "ride"]);
export type CardioKind = typeof CardioKind.Type;

const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One GPS reading as the phone delivered it. */
export const Fix = Schema.Struct({
  at: Millis,
  latitude: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
  longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  altitudeM: Schema.NullOr(Schema.Finite),
  /** How many metres the altitude may be off. Null when it did not say. */
  altitudeAccuracyM: Schema.NullOr(Schema.Finite),
  /** The radius in metres the phone is confident of. Null when it did not say. */
  accuracyM: Schema.NullOr(Schema.Finite),
});
export type Fix = typeof Fix.Type;

/** A position as expo-location reports it. */
export interface LocationReading {
  readonly timestamp: number;
  readonly coords: {
    readonly latitude: number;
    readonly longitude: number;
    readonly altitude: number | null;
    readonly accuracy: number | null;
    readonly altitudeAccuracy: number | null;
  };
}

/** An altitude less sure than this is left out, so its noise does not count as climb. */
export const MAX_ALTITUDE_ACCURACY_M = 15;

/** iOS reports an altitude it could not measure with a negative accuracy. */
export const fixOf = ({ timestamp, coords }: LocationReading): Fix => {
  const measured =
    coords.altitude !== null &&
    coords.altitudeAccuracy !== null &&
    coords.altitudeAccuracy >= 0 &&
    coords.altitudeAccuracy <= MAX_ALTITUDE_ACCURACY_M;
  return {
    at: Math.round(timestamp),
    latitude: coords.latitude,
    longitude: coords.longitude,
    altitudeM: measured ? coords.altitude : null,
    altitudeAccuracyM: measured ? coords.altitudeAccuracy : null,
    accuracyM: coords.accuracy,
  };
};

/**
 * What a recording is made of, in the order it happened. The phone keeps these in
 * a journal while recording, so a recording survives svett being closed or reloaded.
 */
export const RecordingEvent = Schema.Union([
  /** `activityId` is the ID the activity is saved under, so saving twice saves once. */
  Schema.Struct({
    type: Schema.Literal("start"),
    at: Millis,
    kind: CardioKind,
    activityId: ActivityId,
  }),
  Schema.Struct({ type: Schema.Literal("fix"), fix: Fix }),
  Schema.Struct({ type: Schema.Literal("pause"), at: Millis }),
  Schema.Struct({ type: Schema.Literal("resume"), at: Millis }),
]);
export type RecordingEvent = typeof RecordingEvent.Type;

/**
 * A stretch between start or resume and the next pause. `to` is null while it lasts.
 * `fixes` holds the readings confirmed as movement, and `alongM` how far along the
 * stretch each one is, measured along the path's shape so wobble within the readings'
 * accuracy adds nothing.
 * `distanceM` is the last of those. `pending` holds the readings since, until they show
 * movement beyond what drift could explain. `stay` is where the recording has stood
 * still for a while, so readings around it are drift.
 */
export interface Segment {
  readonly from: number;
  readonly to: number | null;
  readonly fixes: ReadonlyArray<Fix>;
  readonly alongM: ReadonlyArray<number>;
  readonly distanceM: number;
  readonly pending: ReadonlyArray<Fix>;
  readonly stay: Fix | null;
}

export interface Recording {
  readonly activityId: ActivityId;
  readonly kind: CardioKind;
  readonly startedAt: number;
  readonly segments: ReadonlyArray<Segment>;
}

/** Readings less sure than this are left out. */
export const MAX_ACCURACY_M = 50;
/** No two readings are trusted to agree more closely than this. */
const MIN_UNCERTAINTY_M = 3;
/** Faster than anyone moves in each kind, so a reading that far off is a GPS jump. */
export const MAX_SPEED_MPS: Readonly<Record<CardioKind, number>> = {
  run: 12,
  walk: 12,
  hike: 12,
  ride: 30,
};
/**
 * Drift while standing still stays within about twice the accuracy of the spot, so two
 * drifting readings can be four accuracies apart. Three times the pair's uncertainty is
 * a little more, so readings further apart than that are movement.
 */
const DRIFT_SPAN = 3;
/** Readings that stay within drift of each other this long mean the recording stopped. */
const STAY_MS = 90_000;
/** Pending readings older than this are dropped, so standing still keeps few. */
const PENDING_MS = 120_000;
/** A bend that strays less than this many accuracies from a straight line is noise. */
const BEND_ACCURACIES = 2;
/** Movement is confirmed in steps at least this many uncertainties long, so noise at each end adds little. */
const MIN_STEP_UNCERTAINTIES = 2;

const accuracyM = (fix: Fix) => Math.max(MIN_UNCERTAINTY_M, fix.accuracyM ?? 0);

/** How far apart two readings may be while marking the same spot. */
const uncertaintyM = (a: Fix, b: Fix): number =>
  Math.max(MIN_UNCERTAINTY_M, Math.hypot(a.accuracyM ?? 0, b.accuracyM ?? 0));

const withinDrift = (a: Fix, b: Fix) => distanceM(a, b) < DRIFT_SPAN * uncertaintyM(a, b);

const unsure = (fix: Fix) =>
  fix.accuracyM !== null && (fix.accuracyM < 0 || fix.accuracyM > MAX_ACCURACY_M);

const EARTH_M_PER_DEGREE = (Math.PI * 6_371_008.8) / 180;

/** Metres east and north of `origin`, flat, which is close enough over a few hundred metres. */
const offsetM = (origin: Fix, fix: Fix) => ({
  east:
    (((fix.longitude - origin.longitude + 540) % 360) - 180) *
    EARTH_M_PER_DEGREE *
    Math.cos((origin.latitude * Math.PI) / 180),
  north: (fix.latitude - origin.latitude) * EARTH_M_PER_DEGREE,
});

/** Where `fix` falls along the straight line from `a` to `b`, from 0 at `a` to 1 at `b`. */
const shareAlong = (fix: Fix, a: Fix, b: Fix): number => {
  const end = offsetM(a, b);
  const point = offsetM(a, fix);
  const squared = end.east ** 2 + end.north ** 2;
  if (squared === 0) return 0;
  return Math.max(0, Math.min(1, (point.east * end.east + point.north * end.north) / squared));
};

const offLineM = (fix: Fix, a: Fix, b: Fix): number => {
  const end = offsetM(a, b);
  const point = offsetM(a, fix);
  const share = shareAlong(fix, a, b);
  return Math.hypot(point.east - share * end.east, point.north - share * end.north);
};

/**
 * The indexes of the readings that shape a path, by Douglas and Peucker: a reading
 * shapes it only where the path bends further than its accuracy can explain.
 */
const corners = (fixes: ReadonlyArray<Fix>, first = 0, last = fixes.length - 1): number[] => {
  let bend = -1;
  let furthest = 0;
  for (let index = first + 1; index < last; index++) {
    const fix = fixes[index]!;
    const beyond = offLineM(fix, fixes[first]!, fixes[last]!) - BEND_ACCURACIES * accuracyM(fix);
    if (beyond > furthest) {
      furthest = beyond;
      bend = index;
    }
  }
  if (bend === -1) return [first, last];
  return [...corners(fixes, first, bend).slice(0, -1), ...corners(fixes, bend, last)];
};

/**
 * Adds `fixes` to the stretch. Each is placed along the path's shape from the last kept
 * reading, never behind the one before it.
 */
const keep = (segment: Segment, fixes: ReadonlyArray<Fix>): Segment => {
  const path = [segment.fixes.at(-1)!, ...fixes];
  const shape = corners(path);
  const alongM: number[] = [];
  let distance = segment.distanceM;
  for (let corner = 1; corner < shape.length; corner++) {
    const from = path[shape[corner - 1]!]!;
    const to = path[shape[corner]!]!;
    const length = distanceM(from, to);
    let reached = distance;
    for (let index = shape[corner - 1]! + 1; index < shape[corner]!; index++) {
      reached = Math.max(reached, distance + shareAlong(path[index]!, from, to) * length);
      alongM.push(reached);
    }
    distance += length;
    alongM.push(distance);
  }
  return {
    ...segment,
    fixes: [...segment.fixes, ...fixes],
    alongM: [...segment.alongM, ...alongM],
    distanceM: distance,
  };
};

/**
 * A reading far from the ones either side of it, while those two lie closer together,
 * is a spike. It is not where anyone went.
 */
const isSpike = (before: Fix, fix: Fix, after: Fix): boolean => {
  const into = distanceM(before, fix);
  const out = distanceM(fix, after);
  return (
    into >= uncertaintyM(before, fix) &&
    out >= uncertaintyM(fix, after) &&
    distanceM(before, after) < Math.min(into, out) / 2
  );
};

/** The reading at the middle of `fixes`, the one nearest their mean position. */
const middle = (fixes: ReadonlyArray<Fix>): Fix => {
  const latitude = fixes.reduce((sum, fix) => sum + fix.latitude, 0) / fixes.length;
  const longitude = fixes.reduce((sum, fix) => sum + fix.longitude, 0) / fixes.length;
  const centre = { latitude, longitude };
  return fixes.reduce((best, fix) =>
    distanceM(fix, centre) < distanceM(best, centre) ? fix : best,
  );
};

const addFix = (segment: Segment, fix: Fix, kind: CardioKind): Segment => {
  if (unsure(fix)) return segment;
  const kept = segment.fixes.at(-1);
  if (kept === undefined) return { ...segment, fixes: [fix], alongM: [0] };
  const previous = segment.pending.at(-1) ?? kept;
  if (fix.at <= previous.at) return segment;
  const seconds = (fix.at - previous.at) / 1000;
  const reach = MAX_SPEED_MPS[kind] * seconds + uncertaintyM(previous, fix);
  if (distanceM(previous, fix) > reach) return segment;
  if (segment.stay !== null && withinDrift(segment.stay, fix)) return segment;

  // The reading before this one was a spike if this one lands back near the one before it.
  const before = segment.pending.at(-2) ?? kept;
  const pending = [
    ...(segment.pending.length > 0 && isSpike(before, previous, fix)
      ? segment.pending.slice(0, -1)
      : segment.pending),
    fix,
  ].filter((pendingFix) => fix.at - pendingFix.at <= PENDING_MS);
  const next = { ...segment, pending };

  // The readings since `here` all lie within drift of this one.
  let here = pending.length - 1;
  while (here > 0 && withinDrift(pending[here - 1]!, fix)) here--;

  if (fix.at - pending[here]!.at >= STAY_MS) {
    const spot = middle(pending.slice(here));
    const approach = pending.slice(0, here);
    const arrived = approach.length > 0 || !withinDrift(kept, spot);
    return { ...(arrived ? keep(next, [...approach, spot]) : next), pending: [], stay: spot };
  }

  // Movement shows once a reading confirmed by this one lies beyond drift of the last kept.
  const confirmed = pending.at(-2);
  if (confirmed === undefined || withinDrift(kept, confirmed)) return next;
  // Keep readings up to one clear of everything around the latest, so the path never
  // runs into drift around where the recording is now.
  const clear = (candidate: Fix) =>
    pending
      .slice(here)
      .every((near) => distanceM(candidate, near) >= uncertaintyM(candidate, near));
  let last = Math.min(pending.length - 2, here - 1);
  while (last >= 0 && !clear(pending[last]!)) last--;
  if (last < 0) return next;
  const step = pending[last]!;
  if (distanceM(kept, step) < MIN_STEP_UNCERTAINTIES * uncertaintyM(kept, step)) return next;
  return {
    ...keep(next, pending.slice(0, last + 1)),
    pending: pending.slice(last + 1),
    stay: null,
  };
};

/** A reading that counts, and how far along its stretch it is. */
export interface TrackPoint {
  readonly fix: Fix;
  readonly alongM: number;
}

/**
 * How far the latest pending reading is from the last kept one. Within the readings'
 * uncertainty it marks the same spot, so it adds nothing.
 */
const tailM = (kept: Fix, latest: Fix): number => {
  const apart = distanceM(kept, latest);
  return apart < uncertaintyM(kept, latest) ? 0 : apart;
};

/**
 * The readings of a stretch that count: the confirmed ones, then the pending ones placed
 * along the straight line to the latest. The recording shows the same distance live as
 * it saves, so finishing changes nothing.
 */
export const segmentTrack = (segment: Segment): ReadonlyArray<TrackPoint> => {
  const track = segment.fixes.map((fix, index) => ({ fix, alongM: segment.alongM[index]! }));
  const kept = segment.fixes.at(-1);
  const latest = segment.pending.at(-1);
  if (kept === undefined || latest === undefined) return track;
  const length = tailM(kept, latest);
  let reached = segment.distanceM;
  return [
    ...track,
    ...segment.pending.map((fix) => {
      reached = Math.max(reached, segment.distanceM + shareAlong(fix, kept, latest) * length);
      return { fix, alongM: fix === latest ? segment.distanceM + length : reached };
    }),
  ];
};

export const segmentFixes = (segment: Segment): ReadonlyArray<Fix> =>
  segmentTrack(segment).map(({ fix }) => fix);

const segmentDistanceM = (segment: Segment): number => {
  const kept = segment.fixes.at(-1);
  const latest = segment.pending.at(-1);
  return kept === undefined || latest === undefined
    ? segment.distanceM
    : segment.distanceM + tailM(kept, latest);
};

/**
 * Applies one event. Events that do not fit, such as a pause while paused, change
 * nothing. A reading joins the stretch its time falls in, because the phone can hand
 * over readings late, in a batch.
 */
export const applyEvent = (
  recording: Recording | undefined,
  event: RecordingEvent,
): Recording | undefined => {
  if (event.type === "start") {
    return (
      recording ?? {
        activityId: event.activityId,
        kind: event.kind,
        startedAt: event.at,
        segments: [
          {
            from: event.at,
            to: null,
            fixes: [],
            alongM: [],
            distanceM: 0,
            pending: [],
            stay: null,
          },
        ],
      }
    );
  }
  if (recording === undefined) return undefined;
  const segments = recording.segments;
  const last = segments.at(-1)!;
  switch (event.type) {
    case "pause":
      return last.to !== null
        ? recording
        : {
            ...recording,
            segments: [...segments.slice(0, -1), { ...last, to: Math.max(event.at, last.from) }],
          };
    case "resume":
      return last.to === null
        ? recording
        : {
            ...recording,
            segments: [
              ...segments,
              {
                from: Math.max(event.at, last.to),
                to: null,
                fixes: [],
                alongM: [],
                distanceM: 0,
                pending: [],
                stay: null,
              },
            ],
          };
    case "fix": {
      const { fix } = event;
      const index = segments.findIndex(
        (segment) => fix.at >= segment.from && (segment.to === null || fix.at <= segment.to),
      );
      if (index === -1) return recording;
      const segment = segments[index]!;
      const next = addFix(segment, fix, recording.kind);
      return next === segment ? recording : { ...recording, segments: segments.with(index, next) };
    }
  }
};

export const replay = (events: ReadonlyArray<RecordingEvent>): Recording | undefined =>
  events.reduce<Recording | undefined>(applyEvent, undefined);

export const isPaused = (recording: Recording): boolean => recording.segments.at(-1)!.to !== null;

/** Time spent recording, leaving out pauses. */
export const movingMs = (recording: Recording, now: number): number =>
  recording.segments.reduce(
    (total, segment) => total + Math.max(0, (segment.to ?? now) - segment.from),
    0,
  );

/** Distance covered while recording. Movement during a pause does not count. */
export const recordedDistanceM = (recording: Recording): number =>
  recording.segments.reduce((total, segment) => total + segmentDistanceM(segment), 0);

/** One line of the journal file. */
export const encodeRecordingEvent = Schema.encodeSync(Schema.fromJsonString(RecordingEvent));

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(RecordingEvent));

/** Reads a journal, one event per line. A line cut short by a crash is skipped. */
export const parseJournal = (text: string): ReadonlyArray<RecordingEvent> =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    return Option.toArray(decodeLine(line));
  });
