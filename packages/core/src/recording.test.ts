import { describe, expect, it } from "vite-plus/test";

import {
  encodeRecordingEvent,
  type Fix,
  fixOf,
  isPaused,
  MAX_ACCURACY_M,
  MAX_ALTITUDE_ACCURACY_M,
  movingMs,
  parseJournal,
  recordedDistanceM,
  type RecordingEvent,
  replay,
  segmentFixes,
} from "./recording.ts";
import { ActivityId } from "./schema.ts";

const DEGREE_M = (Math.PI * 6_371_008.8) / 180;
const T = 1_800_000_000_000;

/** A reading `metres` north of the equator, `seconds` after T. */
const fix = (seconds: number, metres: number, extra: Partial<Fix> = {}): RecordingEvent => ({
  type: "fix",
  fix: {
    at: T + seconds * 1000,
    latitude: metres / DEGREE_M,
    longitude: 0,
    altitudeM: null,
    altitudeAccuracyM: null,
    accuracyM: 5,
    ...extra,
  },
});

const ACTIVITY = ActivityId.make("0190a000-0000-7000-8000-000000000001");
const start: RecordingEvent = { type: "start", at: T, kind: "run", activityId: ACTIVITY };
const pause = (seconds: number): RecordingEvent => ({ type: "pause", at: T + seconds * 1000 });
const resume = (seconds: number): RecordingEvent => ({ type: "resume", at: T + seconds * 1000 });

/** Readings every second at `speed` metres a second, from `from` to `to` seconds. */
const moving = (from: number, to: number, speed: number, offsetM = 0): RecordingEvent[] =>
  Array.from({ length: to - from + 1 }, (_, index) =>
    fix(from + index, offsetM + (from + index) * speed),
  );

describe("a recording", () => {
  it("counts the distance and time of every reading after start", () => {
    const recording = replay([start, ...moving(0, 100, 4)])!;
    expect(recordedDistanceM(recording, true)).toBeCloseTo(400, 6);
    expect(recording.activityId).toBe(ACTIVITY);
    expect(movingMs(recording, T + 100_000)).toBe(100_000);
    expect(isPaused(recording)).toBe(false);
  });

  it("is nothing until it starts", () => {
    expect(replay(moving(0, 10, 3))).toBeUndefined();
  });

  it("stops the clock and the distance while paused, and goes on after resume", () => {
    const recording = replay([
      start,
      ...moving(0, 60, 4),
      pause(60),
      // Walking back to the door while paused, then resuming from there.
      ...moving(61, 120, 4),
      resume(120),
      ...moving(120, 180, 4),
    ])!;
    expect(isPaused(recording)).toBe(false);
    expect(movingMs(recording, T + 180_000)).toBe(120_000);
    expect(recordedDistanceM(recording, true)).toBeCloseTo(480, 6);
  });

  it("keeps the clock still while it is paused", () => {
    const recording = replay([start, ...moving(0, 30, 3), pause(30)])!;
    expect(isPaused(recording)).toBe(true);
    expect(movingMs(recording, T + 30_000)).toBe(30_000);
    expect(movingMs(recording, T + 90_000)).toBe(30_000);
  });

  it("places readings delivered late, after a pause, in the stretch they were measured in", () => {
    const onTime = replay([start, ...moving(0, 60, 4), pause(60)])!;
    const late = replay([start, ...moving(0, 30, 4), pause(60), ...moving(31, 60, 4)])!;
    expect(recordedDistanceM(late)).toBeCloseTo(recordedDistanceM(onTime), 6);
  });

  it("adds nothing for drift between two points 10 m apart while standing still", () => {
    const drift = Array.from({ length: 60 }, (_, second) => fix(second, second % 2 === 0 ? 0 : 10));
    const recording = replay([start, ...drift, pause(60)])!;
    expect(recordedDistanceM(recording)).toBeLessThanOrEqual(10);
    expect(recordedDistanceM(replay([start, ...drift, fix(60, 0), pause(61)])!)).toBe(0);
  });

  it("counts a slow walk whose every step is shorter than the readings' accuracy", () => {
    const recording = replay([start, ...moving(0, 100, 1.2), pause(100)])!;
    // Only the last few metres, too short to tell from drift, are left out.
    expect(recordedDistanceM(recording)).toBeGreaterThan(120 - Math.hypot(5, 5));
    expect(recordedDistanceM(recording)).toBeLessThanOrEqual(120 + 1e-6);
  });

  it("counts movement once a second reading shows it went on, or once the stretch ends", () => {
    const recording = replay([start, fix(0, 0), fix(1, 10)])!;
    expect(recordedDistanceM(recording)).toBe(0);
    expect(recordedDistanceM(recording, true)).toBeCloseTo(10, 6);
    expect(recordedDistanceM(replay([start, fix(0, 0), fix(1, 10), fix(2, 20)])!)).toBeCloseTo(
      10,
      6,
    );
  });

  it("leaves out readings that are too unsure, too close, or a jump no one could make", () => {
    const sure = { accuracyM: null };
    const recording = replay([
      start,
      fix(0, 0, sure),
      fix(1, 500, { accuracyM: MAX_ACCURACY_M + 1 }),
      fix(2, 1, sure),
      fix(3, 4, sure),
      fix(4, 2_000, sure),
      fix(5, 8, sure),
      fix(5, 50, sure),
    ])!;
    expect(segmentFixes(recording.segments[0]!, true).map((f) => f.at)).toEqual([
      T,
      T + 3000,
      T + 5000,
    ]);
    expect(recordedDistanceM(recording, true)).toBeCloseTo(8, 6);
  });

  it("ignores a second start, a pause while paused and a resume while recording", () => {
    const events = [start, ...moving(0, 10, 3), pause(10), resume(20), ...moving(20, 30, 3)];
    expect(
      replay([
        start,
        { type: "start", at: T + 5000, kind: "ride", activityId: ACTIVITY },
        ...moving(0, 10, 3),
        pause(10),
        pause(15),
        resume(20),
        resume(25),
        ...moving(20, 30, 3),
      ]),
    ).toEqual(replay(events));
  });
});

describe("fixOf", () => {
  const reading = {
    timestamp: T + 0.6,
    coords: { latitude: 59.3, longitude: 18.1, altitude: 21, accuracy: 4, altitudeAccuracy: 3 },
  };

  it("keeps the position, the altitude and how sure each is, to the whole millisecond", () => {
    expect(fixOf(reading)).toEqual({
      at: T + 1,
      latitude: 59.3,
      longitude: 18.1,
      altitudeM: 21,
      altitudeAccuracyM: 3,
      accuracyM: 4,
    });
  });

  it("drops an altitude iOS could not measure", () => {
    const unmeasured = { ...reading, coords: { ...reading.coords, altitudeAccuracy: -1 } };
    expect(fixOf(unmeasured)).toMatchObject({ altitudeM: null, altitudeAccuracyM: null });
  });

  it("drops an altitude too unsure to tell a climb from noise", () => {
    const vague = {
      ...reading,
      coords: { ...reading.coords, altitudeAccuracy: MAX_ALTITUDE_ACCURACY_M + 1 },
    };
    expect(fixOf(vague)).toMatchObject({ altitudeM: null, altitudeAccuracyM: null });
    const sure = {
      ...reading,
      coords: { ...reading.coords, altitudeAccuracy: MAX_ALTITUDE_ACCURACY_M },
    };
    expect(fixOf(sure).altitudeM).toBe(21);
  });
});

describe("the journal", () => {
  it("reads back what it wrote, one event a line", () => {
    const events = [start, fix(1, 3, { altitudeM: 12.5 }), pause(2), resume(3)];
    const text = events.map((event) => `${encodeRecordingEvent(event)}\n`).join("");
    expect(parseJournal(text)).toEqual(events);
  });

  it("skips a last line cut short by a crash and lines that are not events", () => {
    const text = `${encodeRecordingEvent(start)}\n{"type":"pause","at":1}\n{"type":"fix","fix":{"at":`;
    expect(parseJournal(`${text}\n{"type":"jump"}\n`)).toEqual([start, { type: "pause", at: 1 }]);
  });
});
