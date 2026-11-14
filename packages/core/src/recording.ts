import { Option, Schema } from "effect";

import { distanceM } from "./geo.ts";

export const CardioKind = Schema.Literals(["run", "walk", "hike", "ride"]);
export type CardioKind = typeof CardioKind.Type;

const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One GPS reading as the phone delivered it. */
export const Fix = Schema.Struct({
  at: Millis,
  latitude: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
  longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  altitudeM: Schema.NullOr(Schema.Finite),
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

/** iOS reports an altitude it could not measure with a negative accuracy. */
export const fixOf = ({ timestamp, coords }: LocationReading): Fix => ({
  at: Math.round(timestamp),
  latitude: coords.latitude,
  longitude: coords.longitude,
  altitudeM:
    coords.altitude !== null && coords.altitudeAccuracy !== null && coords.altitudeAccuracy >= 0
      ? coords.altitude
      : null,
  accuracyM: coords.accuracy,
});

/**
 * What a recording is made of, in the order it happened. The phone keeps these in
 * a journal while recording, so a recording survives svett being closed or reloaded.
 */
export const RecordingEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start"), at: Millis, kind: CardioKind }),
  Schema.Struct({ type: Schema.Literal("fix"), fix: Fix }),
  Schema.Struct({ type: Schema.Literal("pause"), at: Millis }),
  Schema.Struct({ type: Schema.Literal("resume"), at: Millis }),
]);
export type RecordingEvent = typeof RecordingEvent.Type;

/** A stretch between start or resume and the next pause. `to` is null while it lasts. */
export interface Segment {
  readonly from: number;
  readonly to: number | null;
  readonly fixes: ReadonlyArray<Fix>;
  readonly distanceM: number;
}

export interface Recording {
  readonly kind: CardioKind;
  readonly startedAt: number;
  readonly segments: ReadonlyArray<Segment>;
}

/** Readings less sure than this are left out. */
export const MAX_ACCURACY_M = 50;
/** A reading this close to the last one kept is GPS drift, not movement. */
export const MIN_STEP_M = 3;
/** Faster than any run, walk, hike or ride, so a reading this far off is a GPS jump. */
export const MAX_SPEED_MPS = 40;

const accepts = (last: Fix | undefined, fix: Fix): boolean => {
  if (fix.accuracyM !== null && (fix.accuracyM < 0 || fix.accuracyM > MAX_ACCURACY_M)) {
    return false;
  }
  if (last === undefined) return true;
  if (fix.at <= last.at) return false;
  const step = distanceM(last, fix);
  return step >= MIN_STEP_M && step / ((fix.at - last.at) / 1000) <= MAX_SPEED_MPS;
};

const addFix = (segment: Segment, fix: Fix): Segment => {
  const last = segment.fixes.at(-1);
  if (!accepts(last, fix)) return segment;
  return {
    ...segment,
    fixes: [...segment.fixes, fix],
    distanceM: segment.distanceM + (last === undefined ? 0 : distanceM(last, fix)),
  };
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
        kind: event.kind,
        startedAt: event.at,
        segments: [{ from: event.at, to: null, fixes: [], distanceM: 0 }],
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
              { from: Math.max(event.at, last.to), to: null, fixes: [], distanceM: 0 },
            ],
          };
    case "fix": {
      const { fix } = event;
      const index = segments.findIndex(
        (segment) => fix.at >= segment.from && (segment.to === null || fix.at <= segment.to),
      );
      if (index === -1) return recording;
      const segment = segments[index]!;
      const next = addFix(segment, fix);
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
