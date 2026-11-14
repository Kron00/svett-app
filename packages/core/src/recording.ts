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
 * `fixes` and `distanceM` hold the movement confirmed so far. `pending` is a reading
 * that moved away from the last one kept and waits for a later one further on, so
 * GPS drift back and forth while standing still adds nothing.
 */
export interface Segment {
  readonly from: number;
  readonly to: number | null;
  readonly fixes: ReadonlyArray<Fix>;
  readonly distanceM: number;
  readonly pending: Fix | null;
}

export interface Recording {
  readonly activityId: ActivityId;
  readonly kind: CardioKind;
  readonly startedAt: number;
  readonly segments: ReadonlyArray<Segment>;
}

/** Readings less sure than this are left out. */
export const MAX_ACCURACY_M = 50;
/** Movement shorter than this never counts, however sure the readings are. */
export const MIN_STEP_M = 3;
/** Faster than any run, walk, hike or ride, so a reading this far off is a GPS jump. */
export const MAX_SPEED_MPS = 40;

/**
 * How far a reading must be from the last one kept to count as movement: the two
 * readings' uncertainties combined, since either may be off by its own accuracy.
 */
export const movementThresholdM = (kept: Fix, fix: Fix): number =>
  Math.max(MIN_STEP_M, Math.hypot(kept.accuracyM ?? 0, fix.accuracyM ?? 0));

const unsure = (fix: Fix) =>
  fix.accuracyM !== null && (fix.accuracyM < 0 || fix.accuracyM > MAX_ACCURACY_M);

const confirm = (segment: Segment, pending: Fix): Segment => ({
  ...segment,
  fixes: [...segment.fixes, pending],
  distanceM: segment.distanceM + distanceM(segment.fixes.at(-1)!, pending),
  pending: null,
});

const addFix = (segment: Segment, fix: Fix): Segment => {
  if (unsure(fix)) return segment;
  const kept = segment.fixes.at(-1);
  if (kept === undefined) return { ...segment, fixes: [fix] };
  if (fix.at <= (segment.pending ?? kept).at) return segment;
  const step = distanceM(kept, fix);
  if (step / ((fix.at - kept.at) / 1000) > MAX_SPEED_MPS) return segment;
  const moved = step >= movementThresholdM(kept, fix);
  const { pending } = segment;
  if (pending === null) return moved ? { ...segment, pending: fix } : segment;
  // Back near the last reading kept, so the pending one was drift.
  if (!moved) return { ...segment, pending: null };
  // Drift can sit at one spot for several readings, so only a reading further on
  // than the pending one, by more than both could be off, shows the movement went on.
  const further = step - distanceM(kept, pending) >= movementThresholdM(pending, fix);
  return further ? addFix(confirm(segment, pending), fix) : segment;
};

/**
 * The readings of a stretch that count. Once the stretch has ended nothing can
 * contradict its pending reading, so that one counts too.
 */
export const segmentFixes = (segment: Segment, ended = segment.to !== null): ReadonlyArray<Fix> =>
  ended && segment.pending !== null ? confirm(segment, segment.pending).fixes : segment.fixes;

const segmentDistanceM = (segment: Segment, ended = segment.to !== null): number =>
  ended && segment.pending !== null
    ? confirm(segment, segment.pending).distanceM
    : segment.distanceM;

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
        segments: [{ from: event.at, to: null, fixes: [], distanceM: 0, pending: null }],
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
                distanceM: 0,
                pending: null,
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

/**
 * Distance covered while recording. Movement during a pause does not count. With
 * `ended`, the stretch still open counts as finished.
 */
export const recordedDistanceM = (recording: Recording, ended = false): number =>
  recording.segments.reduce(
    (total, segment) => total + segmentDistanceM(segment, ended || segment.to !== null),
    0,
  );

/** One line of the journal file. */
export const encodeRecordingEvent = Schema.encodeSync(Schema.fromJsonString(RecordingEvent));

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(RecordingEvent));

/** Reads a journal, one event per line. A line cut short by a crash is skipped. */
export const parseJournal = (text: string): ReadonlyArray<RecordingEvent> =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    return Option.toArray(decodeLine(line));
  });
