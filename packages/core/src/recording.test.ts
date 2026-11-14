import { describe, expect, it } from "vite-plus/test";

import {
  encodeRecordingEvent,
  type Fix,
  isPaused,
  MAX_ACCURACY_M,
  MIN_STEP_M,
  movingMs,
  parseJournal,
  recordedDistanceM,
  type RecordingEvent,
  replay,
} from "./recording.ts";

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
    accuracyM: 5,
    ...extra,
  },
});

const start: RecordingEvent = { type: "start", at: T, kind: "run" };
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
    expect(recordedDistanceM(recording)).toBeCloseTo(400, 6);
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
    expect(recordedDistanceM(recording)).toBeCloseTo(480, 6);
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

  it("counts slow movement once it adds up past GPS drift", () => {
    const recording = replay([start, ...moving(0, 100, 1)])!;
    expect(recordedDistanceM(recording)).toBeGreaterThan(100 - MIN_STEP_M - 1);
  });

  it("leaves out readings that are too unsure, too close, or a jump no one could make", () => {
    const recording = replay([
      start,
      fix(0, 0),
      fix(1, 500, { accuracyM: MAX_ACCURACY_M + 1 }),
      fix(2, 1),
      fix(3, 4),
      fix(4, 2_000),
      fix(5, 8),
      fix(5, 50),
    ])!;
    expect(recording.segments[0]!.fixes.map((f) => f.at)).toEqual([T, T + 3000, T + 5000]);
    expect(recordedDistanceM(recording)).toBeCloseTo(8, 6);
  });

  it("ignores a second start, a pause while paused and a resume while recording", () => {
    const events = [start, ...moving(0, 10, 3), pause(10), resume(20), ...moving(20, 30, 3)];
    expect(
      replay([
        start,
        { type: "start", at: T + 5000, kind: "ride" },
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
