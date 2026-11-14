import { Option, Schema } from "effect";

import { ActivityId } from "./schema.ts";
import { addReading, emptyTrack, type Motion, smoothTrack, type Track } from "./track-filter.ts";

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
 * Its readings run through a filter of their own, so nothing joins two stretches.
 */
export interface Segment extends Track<Fix> {
  readonly from: number;
  readonly to: number | null;
}

export interface Recording {
  readonly activityId: ActivityId;
  readonly kind: CardioKind;
  readonly startedAt: number;
  readonly segments: ReadonlyArray<Segment>;
}

/** Readings less sure than this are left out. */
export const MAX_ACCURACY_M = 50;
/** Faster than anyone moves in each kind. */
export const MAX_SPEED_MPS: Readonly<Record<CardioKind, number>> = {
  run: 12,
  walk: 12,
  hike: 12,
  ride: 30,
};
/**
 * How each kind moves, for the GPS filter. Walkers and hikers change pace and direction
 * gently, runners more, and riders most.
 */
export const MOTION: Readonly<Record<CardioKind, Motion>> = {
  run: { accelerationNoise: 0.3, topSpeedMps: MAX_SPEED_MPS.run },
  walk: { accelerationNoise: 0.1, topSpeedMps: MAX_SPEED_MPS.walk },
  hike: { accelerationNoise: 0.1, topSpeedMps: MAX_SPEED_MPS.hike },
  ride: { accelerationNoise: 1, topSpeedMps: MAX_SPEED_MPS.ride },
};

const unsure = (fix: Fix) =>
  fix.accuracyM !== null && (fix.accuracyM < 0 || fix.accuracyM > MAX_ACCURACY_M);

const segmentFrom = (from: number, kind: CardioKind): Segment => ({
  ...emptyTrack<Fix>(MOTION[kind]),
  from,
  to: null,
});

/** A reading that counts, at its smoothed position, and how far along its stretch it is. */
export interface TrackPoint {
  readonly fix: Fix;
  readonly alongM: number;
}

/**
 * The confirmed readings of a stretch at the positions the filter and its smoothing
 * pass give them. A reading still waiting for a later one to confirm it is left out.
 */
export const segmentTrack = (segment: Segment): ReadonlyArray<TrackPoint> =>
  smoothTrack(segment).map(({ fix, position, alongM }) => ({
    fix: { ...fix, latitude: position.latitude, longitude: position.longitude },
    alongM,
  }));

export const segmentFixes = (segment: Segment): ReadonlyArray<Fix> =>
  segmentTrack(segment).map(({ fix }) => fix);

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
        segments: [segmentFrom(event.at, event.kind)],
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
            segments: [...segments, segmentFrom(Math.max(event.at, last.to), recording.kind)],
          };
    case "fix": {
      const { fix } = event;
      if (unsure(fix)) return recording;
      const index = segments.findIndex(
        (segment) => fix.at >= segment.from && (segment.to === null || fix.at <= segment.to),
      );
      if (index === -1) return recording;
      const segment = segments[index]!;
      const added = addReading(segment, fix);
      return added === segment
        ? recording
        : { ...recording, segments: segments.with(index, { ...segment, ...added }) };
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

/**
 * Distance covered while recording, as the filter has confirmed it so far. Movement
 * during a pause does not count.
 */
export const recordedDistanceM = (recording: Recording): number =>
  recording.segments.reduce((total, segment) => total + segment.distanceM, 0);

/** One line of the journal file. */
export const encodeRecordingEvent = Schema.encodeSync(Schema.fromJsonString(RecordingEvent));

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(RecordingEvent));

/** Reads a journal, one event per line. A line cut short by a crash is skipped. */
export const parseJournal = (text: string): ReadonlyArray<RecordingEvent> =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    return Option.toArray(decodeLine(line));
  });
