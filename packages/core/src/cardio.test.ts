import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  cardioDraft,
  cardioTitle,
  DEFAULT_HIDE_M,
  elevationGainM,
  elevationProfile,
  splitsOf,
  summarize,
  trackParts,
} from "./cardio.ts";
import { pathLengthM } from "./geo.ts";
import { type Fix, type RecordingEvent, replay } from "./recording.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { openTestDatabase } from "./test-database.ts";

const DEGREE_M = (Math.PI * 6_371_008.8) / 180;
const T = 1_800_000_000_000;

const fix = (seconds: number, metres: number, altitudeM: number | null = null): RecordingEvent => ({
  type: "fix",
  fix: {
    at: T + seconds * 1000,
    latitude: metres / DEGREE_M,
    longitude: 0,
    altitudeM,
    accuracyM: 5,
  },
});

/** Readings every second at `speed` metres a second, from `from` to `to` seconds. */
const moving = (from: number, to: number, speed: number): RecordingEvent[] =>
  Array.from({ length: to - from + 1 }, (_, index) => fix(from + index, (from + index) * speed));

const start: RecordingEvent = { type: "start", at: T, kind: "run" };
const at = (seconds: number) => T + seconds * 1000;

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

describe("splitsOf", () => {
  it("cuts a steady 4 m/s run of 2.5 km into two 250 s kilometres and a 125 s half", () => {
    const recording = replay([start, ...moving(0, 625, 4)])!;
    const splits = splitsOf(recording, at(625));
    expect(splits.map((split) => split.distanceM)).toEqual([1000, 1000, expect.closeTo(500, 6)]);
    expect(splits.map((split) => split.durationS)).toEqual([
      expect.closeTo(250, 6),
      expect.closeTo(250, 6),
      expect.closeTo(125, 6),
    ]);
    expect(splits.map((split) => split.endedAt)).toEqual([at(250), at(500), at(625)]);
  });

  it("interpolates the boundary between two readings", () => {
    // Readings every 30 m and 10 s: 1000 m falls a third of the way into a step.
    const recording = replay([
      start,
      ...Array.from({ length: 40 }, (_, index) => fix(index * 10, index * 30)),
    ])!;
    expect(splitsOf(recording, at(390))[0]).toEqual({
      distanceM: 1000,
      durationS: expect.closeTo(1000 / 3, 6),
      endedAt: Math.round(at(1000 / 3)),
    });
  });

  it("leaves pauses out of a split's time and puts standing still into it", () => {
    const recording = replay([
      start,
      ...moving(0, 150, 4),
      { type: "pause", at: at(150) },
      { type: "resume", at: at(450) },
      // 20 s at a crossing before moving on.
      fix(470, 600),
      ...Array.from({ length: 130 }, (_, index) => fix(471 + index, 604 + index * 4)),
    ])!;
    const [first] = splitsOf(recording, at(600));
    // 150 s to 600 m, the 20 s wait, then 100 s for the last 400 m.
    expect(first!.durationS).toBeCloseTo(270, 6);
  });

  it("adds up to the recording's whole distance and moving time", () => {
    const recording = replay([
      start,
      ...moving(0, 333, 3.7),
      { type: "pause", at: at(340) },
      { type: "resume", at: at(400) },
      ...moving(400, 777, 5.3),
    ])!;
    const summary = summarize(recording, at(800));
    expect(sum(summary.splits.map((split) => split.distanceM))).toBeCloseTo(summary.distanceM, 6);
    expect(sum(summary.splits.map((split) => split.durationS))).toBeCloseTo(340 + 400, 6);
    expect(summary.durationS).toBeCloseTo(740, 6);
  });

  it("gives a recording that went nowhere one split with its time", () => {
    const recording = replay([start, fix(0, 0), fix(30, 1)])!;
    expect(splitsOf(recording, at(60))).toEqual([{ distanceM: 0, durationS: 60, endedAt: at(60) }]);
  });
});

describe("elevationGainM", () => {
  it("adds every climb and ignores descents", () => {
    expect(elevationGainM([10, 20, 15, 30, 25])).toBe(25);
  });

  it("ignores wobble smaller than the climb threshold", () => {
    expect(elevationGainM([50, 51, 49, 51, 50, 51.5, 49.5, 50])).toBe(0);
  });

  it("counts a slow climb made of small steps", () => {
    expect(elevationGainM([0, 1, 2, 3, 4, 5, 6])).toBe(6);
  });

  it("skips readings without an altitude and is unknown when none has one", () => {
    expect(elevationGainM([null, 100, null, 110])).toBe(10);
    expect(elevationGainM([null, null])).toBeNull();
  });
});

describe("elevationProfile", () => {
  const route = Array.from({ length: 101 }, (_, index) => ({
    latitude: (index * 10) / DEGREE_M,
    longitude: 0,
    altitudeM: index < 50 ? 100 : 100 + (index - 50) * 2,
  }));

  it("averages the altitude over equal stretches of the route", () => {
    const profile = elevationProfile(route, 4);
    expect(profile.map((point) => point.distanceM)).toEqual([
      expect.closeTo(250, 6),
      expect.closeTo(500, 6),
      expect.closeTo(750, 6),
      expect.closeTo(1000, 6),
    ]);
    expect(profile[0]!.altitudeM).toBe(100);
    expect(profile[3]!.altitudeM).toBeGreaterThan(profile[2]!.altitudeM);
  });

  it("is empty when the route has no altitude", () => {
    const flat = route.map(({ latitude, longitude }) => ({ latitude, longitude, altitudeM: null }));
    expect(elevationProfile(flat)).toEqual([]);
  });
});

describe("cardioTitle", () => {
  it("names the time of day and the sport", () => {
    expect(cardioTitle("run", 7)).toBe("Morning run");
    expect(cardioTitle("ride", 13)).toBe("Afternoon ride");
    expect(cardioTitle("walk", 19)).toBe("Evening walk");
    expect(cardioTitle("hike", 23)).toBe("Night hike");
    expect(cardioTitle("run", 2)).toBe("Night run");
  });
});

describe("a finished recording saved as an activity", () => {
  const recording = replay([
    start,
    // Up 29 m and straight back down, every minute.
    ...Array.from({ length: 301 }, (_, index) =>
      fix(index, index * 4, 20 + (index % 60 < 30 ? index % 30 : 0)),
    ),
    { type: "pause", at: at(300) },
  ])!;
  const summary = summarize(recording, at(300));

  it("reads back with its route, splits, distance, climb and hidden ends", async () => {
    const database = openTestDatabase();
    const detail = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* activities.create(cardioDraft(summary, "Morning run"));
        const saved = Option.getOrThrow(yield* activities.get(id));
        return { ...saved, samples: yield* activities.samples(saved.track!.id) };
      }),
    );
    const { route, splits } = trackParts(detail.samples);
    expect(detail.activity).toMatchObject({ kind: "run", title: "Morning run", durationS: 300 });
    expect(detail.track).toMatchObject({
      distanceM: expect.closeTo(1200, 6),
      hideStartM: DEFAULT_HIDE_M,
      hideEndM: DEFAULT_HIDE_M,
    });
    expect(detail.track!.elevationGainM).toBeGreaterThan(0);
    expect(route).toHaveLength(301);
    expect(pathLengthM(route)).toBeCloseTo(1200, 6);
    expect(splits.map((split) => split.distanceM)).toEqual([1000, expect.closeTo(200, 6)]);
    expect(sum(splits.map((split) => split.durationS))).toBeCloseTo(300, 6);
  });

  it("changes how much of each end is hidden", async () => {
    const database = openTestDatabase();
    const track = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        const id = yield* activities.create(cardioDraft(summary, "Morning run"));
        const saved = Option.getOrThrow(yield* activities.get(id));
        yield* activities.updateTrack(saved.track!.id, { hideStartM: 500, hideEndM: 0 });
        return Option.getOrThrow(yield* activities.get(id)).track;
      }),
    );
    expect(track).toMatchObject({ hideStartM: 500, hideEndM: 0 });
  });
});

const fixes = (events: ReadonlyArray<RecordingEvent>): Fix[] =>
  events.flatMap((event) => (event.type === "fix" ? [event.fix] : []));

describe("summarize", () => {
  it("keeps every reading the recording kept, in order", () => {
    const events = moving(0, 20, 4);
    expect(summarize(replay([start, ...events])!, at(20)).fixes).toEqual(fixes(events));
  });
});
