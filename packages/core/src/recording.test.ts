import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { summarize } from "./cardio.ts";
import { type LatLng, pathLengthM } from "./geo.ts";
import { seededRandom } from "./ids.ts";
import {
  applyEvent,
  type CardioKind,
  encodeRecordingEvent,
  type Fix,
  fixOf,
  isPaused,
  MAX_ACCURACY_M,
  MAX_ALTITUDE_ACCURACY_M,
  movingMs,
  parseJournal,
  recordedDistanceM,
  type Recording,
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
const startAs = (kind: CardioKind): RecordingEvent => ({
  type: "start",
  at: T,
  kind,
  activityId: ACTIVITY,
});
const start = startAs("run");
const pause = (seconds: number): RecordingEvent => ({ type: "pause", at: T + seconds * 1000 });
const resume = (seconds: number): RecordingEvent => ({ type: "resume", at: T + seconds * 1000 });

/** Readings every second at `speed` metres a second, from `from` to `to` seconds. */
const moving = (from: number, to: number, speed: number): RecordingEvent[] =>
  Array.from({ length: to - from + 1 }, (_, index) => fix(from + index, (from + index) * speed));

/** A point `east` and `north` metres from where the equator meets the prime meridian. */
const point = (east: number, north: number): LatLng => ({
  latitude: north / DEGREE_M,
  longitude: east / DEGREE_M,
});

const fixAt = (
  seconds: number,
  { latitude, longitude }: LatLng,
  accuracyM = 5,
): RecordingEvent => ({
  type: "fix",
  fix: {
    at: T + seconds * 1000,
    latitude,
    longitude,
    altitudeM: null,
    altitudeAccuracyM: null,
    accuracyM,
  },
});

/** Readings every `every` seconds along `route` at `speed`, from `from` seconds, ending at its end. */
const along = (
  route: ReadonlyArray<LatLng>,
  speed: number,
  {
    from = 0,
    every = 1,
    accuracyM = () => 5,
  }: { from?: number; every?: number; accuracyM?: () => number } = {},
): RecordingEvent[] => {
  const length = pathLengthM(route);
  const at = (travelled: number): LatLng => {
    for (let index = 1; index < route.length; index++) {
      const a = route[index - 1]!;
      const b = route[index]!;
      const leg = pathLengthM([a, b]);
      if (travelled <= leg || index === route.length - 1) {
        const share = leg === 0 ? 0 : Math.min(1, travelled / leg);
        return {
          latitude: a.latitude + (b.latitude - a.latitude) * share,
          longitude: a.longitude + (b.longitude - a.longitude) * share,
        };
      }
      travelled -= leg;
    }
    return route[0]!;
  };
  const steps = Math.ceil(length / (speed * every));
  return Array.from({ length: steps + 1 }, (_, step) =>
    fixAt(from + step * every, at(Math.min(length, step * every * speed)), accuracyM()),
  );
};

/**
 * Drift while standing at `spot` for `seconds`: a fixed sequence of places within 10 m
 * of it, each held for one to six seconds.
 */
const lingering = (spot: LatLng, seconds: number, from: number, seed: number) => {
  const next = seededRandom(seed);
  const drift: RecordingEvent[] = [];
  while (drift.length < seconds) {
    const angle = next() * 2 * Math.PI;
    const radius = 10 * Math.sqrt(next());
    const place = {
      latitude: spot.latitude + (radius * Math.cos(angle)) / DEGREE_M,
      longitude: spot.longitude + (radius * Math.sin(angle)) / DEGREE_M,
    };
    for (let held = 1 + Math.floor(next() * 6); held > 0 && drift.length < seconds; held--) {
      drift.push(fixAt(from + drift.length, place));
    }
  }
  return drift;
};

const ROUTE = JSON.parse(
  readFileSync(new URL("../../../scripts/sim/cardio-route.json", import.meta.url), "utf8"),
) as { readonly pauseAt: number; readonly waypoints: ReadonlyArray<LatLng> };

const secondsOf = (event: RecordingEvent) =>
  ((event.type === "fix" ? event.fix.at : event.type === "start" ? event.at : event.at) - T) / 1000;

/** The distance shown after each event, and the recording at the end. */
const play = (kind: CardioKind, events: ReadonlyArray<RecordingEvent>) => {
  let recording: Recording | undefined;
  const shown: number[] = [];
  for (const event of [startAs(kind), ...events]) {
    recording = applyEvent(recording, event);
    shown.push(recordedDistanceM(recording!));
  }
  return { recording: recording!, shown };
};

const run300 = along([point(0, 0), point(0, 300)], 3);
const afterRun300 = secondsOf(run300.at(-1)!);
const stop = lingering(point(0, 300), 120, afterRun300 + 1, 7);
const jumpedRun = [
  ...run300,
  fixAt(afterRun300 + 1, point(2000, 300)),
  ...along([point(0, 300), point(0, 600)], 3, { from: afterRun300 + 2 }).slice(1),
];
const unjumpedRun = [
  ...run300,
  ...along([point(0, 300), point(0, 600)], 3, { from: afterRun300 + 2 }).slice(1),
];
const firstLeg = along(ROUTE.waypoints.slice(0, ROUTE.pauseAt + 1), 6);
const pausedAt = secondsOf(firstLeg.at(-1)!);
const quarterCircle = Array.from({ length: 91 }, (_, degree) => {
  const angle = (degree * Math.PI) / 180;
  return point(100 - 100 * Math.cos(angle), 100 * Math.sin(angle));
});
const varying = seededRandom(10);

interface MovementCase {
  readonly name: string;
  readonly kind: CardioKind;
  readonly events: ReadonlyArray<RecordingEvent>;
  /** The distance to land within a share of, or never to go over. */
  readonly expect: { readonly near: number; readonly within: number } | { readonly atMost: number };
  readonly also?: (shown: ReadonlyArray<number>) => void;
}

const MOVEMENT: ReadonlyArray<MovementCase> = [
  {
    name: "ten minutes of drift between two points 10 m apart adds at most 20 m",
    kind: "run",
    events: Array.from({ length: 600 }, (_, second) =>
      fixAt(second, point(0, second % 2 === 0 ? 0 : 10)),
    ),
    expect: { atMost: 20 },
  },
  ...[7, 11, 1234].map((seed): MovementCase => ({
    name: `ten minutes of drift lingering within 10 m of one place adds at most 20 m (seed ${seed})`,
    kind: "run",
    events: lingering(point(0, 0), 600, 0, seed),
    expect: { atMost: 20 },
  })),
  {
    name: "a ten minute walk at 1 m/s in a straight line comes within 3% of 600 m",
    kind: "walk",
    events: along([point(0, 0), point(0, 600)], 1),
    expect: { near: 600, within: 0.03 },
  },
  {
    name: "the proof route at 6 m/s, paused where the proof pauses, comes within 1% of its length",
    kind: "run",
    events: [
      ...firstLeg,
      pause(pausedAt),
      resume(pausedAt + 10),
      ...along(ROUTE.waypoints.slice(ROUTE.pauseAt), 6, { from: pausedAt + 10 }),
    ],
    expect: { near: pathLengthM(ROUTE.waypoints), within: 0.01 },
  },
  {
    name: "a 200 m out-and-back at 3 m/s comes within 3% of 200 m",
    kind: "run",
    events: along([point(0, 0), point(0, 100), point(0, 0)], 3),
    expect: { near: 200, within: 0.03 },
  },
  {
    name: "a walk around a quarter circle of 100 m radius comes within 3% of its length",
    kind: "walk",
    events: along(quarterCircle, 1.4),
    expect: { near: pathLengthM(quarterCircle), within: 0.03 },
  },
  {
    name: "a two minute stop mid-run adds no drift, and the run comes within 3% of 600 m",
    kind: "run",
    events: [
      ...run300,
      ...stop,
      ...along([point(0, 300), point(0, 600)], 3, { from: afterRun300 + 121 }).slice(1),
    ],
    expect: { near: 600, within: 0.03 },
    also: (shown) => {
      const stopping = shown[run300.length]!;
      const starting = shown[run300.length + stop.length]!;
      expect(Math.abs(starting - stopping)).toBeLessThan(1);
    },
  },
  {
    name: "one reading 100 m off after standing still, then a 60 m walk read every 10 s, comes within 5% of 60 m",
    kind: "walk",
    events: [
      ...Array.from({ length: 60 }, (_, second) => fixAt(second, point(0, 0))),
      fixAt(69, point(0, 100)),
      ...Array.from({ length: 6 }, (_, step) => fixAt(79 + step * 10, point(0, 10 * (step + 1)))),
    ],
    expect: { near: 60, within: 0.05 },
  },
  {
    name: "a single 2 km jump that comes back adds nothing",
    kind: "run",
    events: jumpedRun,
    expect: { near: 600, within: 0.01 },
    also: (shown) => {
      expect(shown.at(-1)).toBeCloseTo(play("run", unjumpedRun).shown.at(-1)!, 6);
    },
  },
  {
    name: "a 1 km run with accuracy varying from 3 m to 25 m comes within 3% of 1 km",
    kind: "run",
    events: along([point(0, 0), point(0, 1000)], 3, { accuracyM: () => 3 + 22 * varying() }),
    expect: { near: 1000, within: 0.03 },
  },
];

describe("movement", () => {
  it.each(MOVEMENT)("$name", ({ kind, events, expect: expected, also }) => {
    const { recording, shown } = play(kind, events);
    const end = T + (secondsOf(events.at(-1)!) + 1) * 1000;
    const live = shown.at(-1)!;
    const saved = summarize(applyEvent(recording, { type: "pause", at: end })!, end).distanceM;
    expect(saved).toBeCloseTo(live, 6);
    if ("atMost" in expected) {
      expect(Math.max(...shown)).toBeLessThanOrEqual(expected.atMost);
    } else {
      expect(Math.abs(live - expected.near) / expected.near).toBeLessThanOrEqual(expected.within);
    }
    also?.(shown);
  });
});

describe("a recording", () => {
  it("counts the distance and time of every reading after start", () => {
    const recording = replay([start, ...moving(0, 100, 4)])!;
    expect(recordedDistanceM(recording)).toBeCloseTo(400, 6);
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

  it("leaves out readings that are too unsure, out of order, or a jump no one could make", () => {
    const sure = { accuracyM: null };
    const recording = replay([
      start,
      fix(0, 0, sure),
      fix(1, 500, { accuracyM: MAX_ACCURACY_M + 1 }),
      fix(2, 3, sure),
      fix(3, 6, sure),
      fix(4, 2_000, sure),
      fix(5, 9, sure),
      fix(5, 50, sure),
    ])!;
    expect(segmentFixes(recording.segments[0]!).map((f) => f.at)).toEqual([
      T,
      T + 2000,
      T + 3000,
      T + 5000,
    ]);
    expect(recordedDistanceM(recording)).toBeCloseTo(9, 6);
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
