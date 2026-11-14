import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  type AltitudeReading,
  cardioDraft,
  type CardioSummary,
  cardioTitle,
  DEFAULT_HIDE_M,
  elevationGainM,
  elevationProfile,
  sharedTrack,
  splitsOf,
  summarize,
  trackParts,
} from "./cardio.ts";
import { distanceM, hideRouteEnds, pathLengthM, routeLengthM } from "./geo.ts";
import { seededRandom } from "./ids.ts";
import { type Fix, type RecordingEvent, replay } from "./recording.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { ActivityId } from "./schema.ts";
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
    altitudeAccuracyM: altitudeM === null ? null : 3,
    accuracyM: 2,
  },
});

/** Readings every second at `speed` metres a second, from `from` to `to` seconds. */
const moving = (from: number, to: number, speed: number): RecordingEvent[] =>
  Array.from({ length: to - from + 1 }, (_, index) => fix(from + index, (from + index) * speed));

const ACTIVITY = ActivityId.make("0190a000-0000-7000-8000-000000000001");
const start: RecordingEvent = { type: "start", at: T, kind: "run", activityId: ACTIVITY };
const at = (seconds: number) => T + seconds * 1000;

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

describe("splitsOf", () => {
  it("cuts a steady 4 m/s run of 2.5 km into two 250 s kilometres and a 125 s half", () => {
    // One reading more, to confirm the one at 2.5 km.
    const recording = replay([start, ...moving(0, 626, 4)])!;
    const splits = splitsOf(recording, at(625));
    expect(splits.map((split) => split.distanceM)).toEqual([1000, 1000, expect.closeTo(500, 1)]);
    expect(splits.map((split) => split.durationS)).toEqual([
      expect.closeTo(250, 1),
      expect.closeTo(250, 1),
      expect.closeTo(125, 1),
    ]);
    expect(splits.map((split) => split.endedAt)).toEqual([
      expect.closeTo(at(250), -2),
      expect.closeTo(at(500), -2),
      at(625),
    ]);
  });

  it("interpolates the boundary between two readings", () => {
    // Readings every 30 m and 10 s: 1000 m falls a third of the way into a step.
    const recording = replay([
      start,
      ...Array.from({ length: 40 }, (_, index) => fix(index * 10, index * 30)),
    ])!;
    expect(splitsOf(recording, at(390))[0]).toEqual({
      distanceM: 1000,
      durationS: expect.closeTo(1000 / 3, 1),
      endedAt: expect.closeTo(at(1000 / 3), -2),
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
    // 150 s to 596 m, since nothing came after the reading at 600 m to confirm it, the
    // 20 s wait, then 101 s for the last 404 m.
    expect(first!.durationS).toBeCloseTo(271, 1);
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

/** Altitudes `secondsApart` apart, each `accuracyM` sure. */
const altitudes = (
  values: ReadonlyArray<number | null>,
  secondsApart = 1,
  accuracyM = 5,
): AltitudeReading[] =>
  values.map((altitudeM, index) => ({
    at: T + index * secondsApart * 1000,
    altitudeM,
    altitudeAccuracyM: altitudeM === null ? null : accuracyM,
  }));

/** Up to `noiseM` either way, the same every run. */
const noise = (count: number, noiseM: number) => {
  const random = seededRandom(7);
  return Array.from({ length: count }, () => (random() * 2 - 1) * noiseM);
};

describe("elevationGainM", () => {
  // A minute apart, so smoothing leaves each reading as it is.
  it("adds every climb and ignores descents", () => {
    expect(elevationGainM([altitudes([10, 20, 15, 30, 25], 60)])).toBeCloseTo(25, 6);
  });

  it("counts a slow climb made of small steps", () => {
    expect(elevationGainM([altitudes([0, 1, 2, 3, 4, 5, 6], 60)])).toBeCloseTo(6, 6);
  });

  it("adds about nothing for ten minutes on the flat with GPS altitude noise", () => {
    const flat = noise(600, 5).map((wobble) => 100 + wobble);
    expect(elevationGainM([altitudes(flat)])).toBeLessThan(1);
  });

  it("keeps a real hill's climb under the same noise", () => {
    const hill = noise(900, 5).map((wobble, second) => Math.min(second, 600) / 10 + wobble);
    expect(elevationGainM([altitudes(hill)])).toBeCloseTo(60, -1);
    expect(Math.abs(elevationGainM([altitudes(hill)])! - 60)).toBeLessThan(3);
  });

  it("trusts an unsure altitude less than the sure ones around it", () => {
    const sure = altitudes(
      Array.from({ length: 31 }, () => 100),
      1,
      2,
    );
    const spike = { at: sure[15]!.at + 500, altitudeM: 120, altitudeAccuracyM: 14 };
    expect(elevationGainM([[...sure.slice(0, 16), spike, ...sure.slice(16)]])).toBe(0);
  });

  it("does not count the change in altitude between two stretches as a climb", () => {
    expect(elevationGainM([altitudes([0, 0, 0]), altitudes([100, 100, 100])])).toBe(0);
  });

  it("skips readings without an altitude and is unknown when none has one", () => {
    expect(elevationGainM([altitudes([null, 100, null, 110], 60)])).toBeCloseTo(10, 6);
    expect(elevationGainM([altitudes([null, null])])).toBeNull();
  });
});

describe("elevationProfile", () => {
  const route = Array.from({ length: 101 }, (_, index) => ({
    latitude: (index * 10) / DEGREE_M,
    longitude: 0,
    altitudeM: index < 50 ? 100 : 100 + (index - 50) * 2,
  }));

  it("averages the altitude over equal stretches of the route", () => {
    const profile = elevationProfile([route], 4);
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
    expect(elevationProfile([flat])).toEqual([]);
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
    // Up 29 m and straight back down, every minute, and one reading more to confirm
    // the one at 1200 m.
    ...Array.from({ length: 302 }, (_, index) =>
      fix(index, index * 4, 20 + (index % 60 < 30 ? index % 30 : 0)),
    ),
    { type: "pause", at: at(301) },
  ])!;
  const summary = summarize(recording, at(301));

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
    const { route, lines, splits } = trackParts(detail.samples);
    expect(detail.activity).toMatchObject({ kind: "run", title: "Morning run", durationS: 301 });
    expect(detail.track).toMatchObject({
      distanceM: expect.closeTo(1200, 1),
      hideStartM: DEFAULT_HIDE_M,
      hideEndM: DEFAULT_HIDE_M,
    });
    expect(detail.track!.elevationGainM).toBeGreaterThan(0);
    expect(route).toHaveLength(301);
    expect(lines).toHaveLength(1);
    expect(pathLengthM(route)).toBeCloseTo(1200, 1);
    expect(detail.activity.id).toBe(ACTIVITY);
    expect(splits.map((split) => split.distanceM)).toEqual([1000, expect.closeTo(200, 1)]);
    expect(sum(splits.map((split) => split.durationS))).toBeCloseTo(301, 6);
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

const save = async (summary: CardioSummary, hideM = DEFAULT_HIDE_M) => {
  const database = openTestDatabase();
  return database.runtime.runPromise(
    Effect.gen(function* () {
      const activities = yield* ActivityRepository;
      const id = yield* activities.create(cardioDraft(summary, "Morning run"));
      const saved = Option.getOrThrow(yield* activities.get(id));
      yield* activities.updateTrack(saved.track!.id, { hideStartM: hideM, hideEndM: hideM });
      const track = Option.getOrThrow(yield* activities.get(id)).track!;
      return { track, samples: yield* activities.samples(track.id) };
    }),
  );
};

describe("a recording moved while paused", () => {
  // 100 m on the flat, a pause, 900 m and 100 m up by car, then another 100 m up there.
  // Each stretch has one reading more, to confirm the one at its end.
  const recording = replay([
    start,
    ...Array.from({ length: 27 }, (_, index) => fix(index, index * 4, 0)),
    { type: "pause", at: at(26) },
    { type: "resume", at: at(600) },
    ...Array.from({ length: 27 }, (_, index) => fix(600 + index, 1000 + index * 4, 100)),
    { type: "pause", at: at(626) },
  ])!;
  const summary = summarize(recording, at(626));

  it("counts 200 m and no climb", () => {
    expect(summary.distanceM).toBeCloseTo(200, 0);
    expect(summary.elevationGainM).toBe(0);
    expect(summary.splits.map((split) => split.distanceM)).toEqual([expect.closeTo(200, 0)]);
  });

  it("saves a route of two lines that span 200 m on the map and the elevation chart", async () => {
    const { samples } = await save(summary, 0);
    const { lines } = trackParts(samples);
    expect(lines.map((line) => line.length)).toEqual([26, 26]);
    expect(routeLengthM(lines)).toBeCloseTo(200, 0);
    expect(routeLengthM(hideRouteEnds(lines, 0, 0).visible)).toBeCloseTo(200, 0);
    expect(elevationProfile(lines).at(-1)!.distanceM).toBeCloseTo(200, 0);
  });
});

describe("sharedTrack", () => {
  // One reading more than 1200 m, to confirm the one at 1200 m.
  const recording = replay([
    start,
    ...Array.from({ length: 302 }, (_, index) => fix(index, index * 4, 20 + index / 10)),
    { type: "pause", at: at(301) },
  ])!;
  const summary = summarize(recording, at(301));

  it("leaves out every position in the hidden start and end", async () => {
    const { track, samples } = await save(summary, 200);
    const shared = sharedTrack(track, samples);
    const text = JSON.stringify(shared);
    // The reading on the equator is left out: "0" is in any text with a number in it.
    const hidden = trackParts(samples).route.filter((sample) => {
      const north = sample.latitude * DEGREE_M;
      return sample.latitude !== 0 && (north < 200 - 1e-6 || north > 1000 + 1e-6);
    });
    expect(hidden.length).toBeGreaterThan(90);
    for (const sample of hidden) {
      expect(text).not.toContain(String(sample.latitude));
    }
    expect(
      routeLengthM(shared.route.map((line) => line.map((p) => ({ ...p, altitudeM: null })))),
    ).toBeCloseTo(800, 1);
    expect(shared.route.flat().every((point) => Object.keys(point).length === 2)).toBe(true);
  });

  it("charts the elevation of the visible stretch only", async () => {
    const { track, samples } = await save(summary, 200);
    const shared = sharedTrack(track, samples);
    expect(shared.profile.at(-1)!.distanceM).toBeCloseTo(800, 1);
    expect(shared.profile[0]!.altitudeM).toBeGreaterThan(25);
    expect(shared.splits.map((split) => split.distanceM)).toEqual([1000, expect.closeTo(200, 1)]);
  });

  it("shows no route when the hidden ends cover all of it", async () => {
    const { track, samples } = await save(summary, 1000);
    expect(sharedTrack(track, samples)).toMatchObject({ route: [], profile: [] });
  });
});

const fixes = (events: ReadonlyArray<RecordingEvent>): Fix[] =>
  events.flatMap((event) => (event.type === "fix" ? [event.fix] : []));

describe("summarize", () => {
  it("keeps every confirmed reading, near where it was read, one list for each stretch", () => {
    const first = moving(0, 20, 4);
    const second = moving(30, 50, 4);
    const summary = summarize(
      replay([
        start,
        ...first,
        { type: "pause", at: at(20) },
        { type: "resume", at: at(30) },
        ...second,
      ])!,
      at(50),
    );
    // The last reading of each stretch has nothing after it to confirm it.
    const expected = [fixes(first).slice(0, -1), fixes(second).slice(0, -1)];
    expect(summary.segments.map((kept) => kept.map((point) => point.at))).toEqual(
      expected.map((read) => read.map((reading) => reading.at)),
    );
    for (const [segment, kept] of summary.segments.entries()) {
      for (const [index, point] of kept.entries()) {
        expect(distanceM(point, expected[segment]![index]!)).toBeLessThan(0.1);
      }
    }
    expect(summary.activityId).toBe(ACTIVITY);
  });
});
