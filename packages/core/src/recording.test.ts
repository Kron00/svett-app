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
  MOTION,
  segmentFixes,
  segmentTrack,
} from "./recording.ts";
import { ActivityId } from "./schema.ts";
import { addReading, emptyTrack, STOP_MS, type Track } from "./track-filter.ts";

/** Every case with random readings runs once for each of these seeds. */
const SEEDS = [...Array.from({ length: 60 }, (_, index) => index + 1), 1234];

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
  speedMps?: number,
): RecordingEvent => ({
  type: "fix",
  fix: {
    at: T + seconds * 1000,
    latitude,
    longitude,
    altitudeM: null,
    altitudeAccuracyM: null,
    accuracyM,
    ...(speedMps === undefined ? {} : { speedMps }),
  },
});

/** A normal random number with mean 0 and standard deviation 1, by the Box-Muller method. */
const normal = (next: () => number) =>
  Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

/**
 * The speed a phone reports when it moves at `trueMps`: the truth with an error of
 * 0.2 m/s standard deviation, never below 0. Standing still, one reading in 20 is a
 * spike of 0.2 m/s to 0.5 m/s, as a still iPhone reports now and then.
 */
const reported = (seed: number) => {
  const next = seededRandom(seed + 10_000);
  return (trueMps: number) => {
    if (trueMps === 0 && next() < 0.05) return 0.2 + 0.3 * next();
    return Math.max(0, trueMps + 0.2 * normal(next));
  };
};
type Reported = ReturnType<typeof reported>;

/** Readings every `every` seconds along `route` at `speed`, from `from` seconds, ending at its end. */
const along = (
  route: ReadonlyArray<LatLng>,
  speed: number,
  {
    from = 0,
    every = 1,
    accuracyM = () => 5,
    speedMps,
  }: { from?: number; every?: number; accuracyM?: () => number; speedMps?: Reported } = {},
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
    fixAt(
      from + step * every,
      at(Math.min(length, step * every * speed)),
      accuracyM(),
      speedMps?.(speed),
    ),
  );
};

/**
 * Drift while standing at `spot` for `seconds`: a fixed sequence of places within 10 m
 * of it, each held for one to six seconds. The readings report speeds when `speedMps` is
 * given.
 */
const lingering = (
  spot: LatLng,
  seconds: number,
  from: number,
  seed: number,
  speedMps?: Reported,
) => {
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
      drift.push(fixAt(from + drift.length, place, 5, speedMps?.(0)));
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
  const recordings: Recording[] = [];
  for (const event of [startAs(kind), ...events]) {
    recording = applyEvent(recording, event);
    shown.push(recordedDistanceM(recording!));
    recordings.push(recording!);
  }
  return { recording: recording!, shown, recordings };
};

/** The distance saved when finishing a second after the last event. */
const savedM = (recording: Recording, lastEvent: RecordingEvent) => {
  const end = T + (secondsOf(lastEvent) + 1) * 1000;
  return summarize(applyEvent(recording, { type: "pause", at: end })!, end).distanceM;
};

const run300 = along([point(0, 0), point(0, 300)], 3);
const afterRun300 = secondsOf(run300.at(-1)!);

/**
 * The 600 m run with a stop of `seconds` at 300 m, drifting as `seed` has it, every
 * reading reporting its speed.
 */
const stopping = (seconds: number, seed: number) => {
  const speedMps = reported(seed);
  const before = along([point(0, 0), point(0, 300)], 3, { speedMps });
  const stop = lingering(point(0, 300), seconds, afterRun300 + 1, seed, speedMps);
  return {
    before,
    stop,
    events: [
      ...before,
      ...stop,
      ...along([point(0, 300), point(0, 600)], 3, {
        from: afterRun300 + seconds + 1,
        speedMps,
      }).slice(1),
    ],
  };
};
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

/** A 200 m out-and-back at `speed` whose reading at the far end is 20 m further out. */
const noisyApex = (speed: number) => {
  const events = along([point(0, 0), point(0, 100), point(0, 0)], speed);
  const apex = Math.floor((events.length - 1) / 2);
  return events.with(apex, fixAt(secondsOf(events[apex]!), point(0, 120)));
};

/** Standing still for a minute, one reading 100 m off, then a 60 m walk read every 10 s. */
const sparse: ReadonlyArray<{ readonly event: RecordingEvent; readonly trueM: number }> = [
  ...Array.from({ length: 60 }, (_, second) => ({ event: fixAt(second, point(0, 0)), trueM: 0 })),
  { event: fixAt(69, point(0, 100)), trueM: 0 },
  ...Array.from({ length: 6 }, (_, step) => ({
    event: fixAt(79 + step * 10, point(0, 10 * (step + 1))),
    trueM: 10 * (step + 1),
  })),
];

const LOOP_M = 5000;
const LOOP_RADIUS_M = LOOP_M / (2 * Math.PI);

/** A 5 km loop at 3 m/s read every second, each reading off by `error`, which says 5 m. */
const loop = (error: () => { readonly east: number; readonly north: number }) =>
  Array.from({ length: Math.ceil(LOOP_M / 3) + 1 }, (_, second) => {
    const angle = Math.min(LOOP_M, second * 3) / LOOP_RADIUS_M;
    const { east, north } = error();
    return fixAt(
      second,
      point(LOOP_RADIUS_M * Math.cos(angle) + east, LOOP_RADIUS_M * Math.sin(angle) + north),
    );
  });

/** Error that wanders 2 m a second each way and stays 3 m to 8 m from the truth. */
const wandering = (seed: number) => {
  const next = seededRandom(seed);
  let east = 5;
  let north = 0;
  return () => {
    east += (next() * 2 - 1) * 2;
    north += (next() * 2 - 1) * 2;
    const size = Math.hypot(east, north);
    const kept = Math.max(3, Math.min(8, size));
    east *= kept / size;
    north *= kept / size;
    return { east, north };
  };
};

/** Error of 3 m to 8 m in a new direction every reading. */
const jitter = (seed: number) => {
  const next = seededRandom(seed);
  return () => {
    const angle = next() * 2 * Math.PI;
    const size = 3 + next() * 5;
    return { east: size * Math.cos(angle), north: size * Math.sin(angle) };
  };
};

const ride = along([point(0, 0), point(0, 6000)], 12);
const zigzag = Array.from({ length: 31 }, (_, index) => point(index % 2 === 0 ? 0 : 20, index * 3));

/** `seconds` round a circle of `radius` at `speed`, reading every second. */
const circling = (radius: number, speed: number, seconds: number, speedMps: Reported) =>
  Array.from({ length: seconds + 1 }, (_, second) => {
    const angle = (second * speed) / radius;
    return fixAt(
      second,
      point(radius * Math.sin(angle), radius * (1 - Math.cos(angle))),
      5,
      speedMps(speed),
    );
  });
const TRACK_RADIUS_M = 36.5;
const TRACK_SECONDS = Math.round((4 * 2 * Math.PI * TRACK_RADIUS_M) / 3);

const tunnelRun = along([point(0, 0), point(0, 900)], 3).filter((event) => {
  const second = secondsOf(event);
  return second <= 150 || second >= 180;
});

interface MovementCase {
  readonly name: string;
  readonly kind: CardioKind;
  readonly events: ReadonlyArray<RecordingEvent>;
  /**
   * The distance saved must land within a share of `near`, and the distance shown too,
   * within 1% of the saved one. Where `live` is set, the distance shown need only land
   * within that share of `near`. Or neither may ever go over `atMost`.
   */
  readonly expect:
    | { readonly near: number; readonly within: number; readonly live?: number }
    | { readonly atMost: number };
  readonly also?: (played: ReturnType<typeof play>) => void;
}

const MOVEMENT: ReadonlyArray<MovementCase> = [
  {
    name: "ten minutes of drift between two points 10 m apart adds at most 25 m",
    kind: "run",
    events: Array.from({ length: 600 }, (_, second) =>
      fixAt(second, point(0, second % 2 === 0 ? 0 : 10)),
    ),
    expect: { atMost: 25 },
  },
  ...SEEDS.map((seed): MovementCase => ({
    name: `ten minutes of drift within 10 m of one place, reporting a still speed, adds at most 20 m (seed ${seed})`,
    kind: "run",
    events: lingering(point(0, 0), 600, 0, seed, reported(seed)),
    expect: { atMost: 20 },
  })),
  ...SEEDS.map((seed): MovementCase => ({
    // Without speeds nothing calls it a stop. The still model holds it, and drift that
    // leaves the model counts as movement, by the filter's path.
    name: `ten minutes of drift within 10 m of one place, reporting no speed, adds at most 25 m (seed ${seed})`,
    kind: "run",
    events: lingering(point(0, 0), 600, 0, seed),
    expect: { atMost: 25 },
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
  ...SEEDS.map((seed): MovementCase => {
    const { before, stop, events } = stopping(120, seed);
    return {
      name: `a two minute stop mid-run adds at most 8 m, and the run comes within 3% of 600 m (seed ${seed})`,
      kind: "run",
      events,
      expect: { near: 600, within: 0.03 },
      also: ({ shown }) => {
        // The first reading of the stop confirms the last one of the run.
        const arrived = shown[before.length + 1]!;
        const stopped = shown[before.length + STOP_MS / 1000]!;
        const leaving = shown[before.length + stop.length]!;
        expect(leaving - arrived).toBeLessThanOrEqual(8);
        expect(leaving).toBe(stopped);
      },
    };
  }),
  ...SEEDS.map((seed): MovementCase => ({
    name: `a 30 s stop on a 600 m run comes within 2% saved and 3% shown (seed ${seed})`,
    kind: "run",
    events: stopping(30, seed).events,
    expect: { near: 600, within: 0.02, live: 0.03 },
  })),
  {
    name: "one reading 100 m off after standing still, then a 60 m walk read every 10 s, saves within 5 m of 60 m",
    kind: "walk",
    events: sparse.map(({ event }) => event),
    // The last 10 m show only once the walk ends, with no later reading to confirm them.
    expect: { near: 60, within: 5 / 60, live: 0.2 },
    also: ({ shown, recordings }) => {
      expect(Math.max(...shown)).toBeLessThanOrEqual(66);
      for (const [index, { event, trueM }] of sparse.entries()) {
        expect(savedM(recordings[index + 1]!, event)).toBeLessThanOrEqual(trueM + 5);
      }
    },
  },
  {
    name: "a single 2 km jump that comes back adds nothing",
    kind: "run",
    events: jumpedRun,
    expect: { near: 600, within: 0.01 },
    also: ({ shown }) => {
      expect(shown.at(-1)).toBeCloseTo(play("run", unjumpedRun).shown.at(-1)!, 6);
    },
  },
  ...SEEDS.map((seed): MovementCase => {
    const varying = seededRandom(seed);
    return {
      name: `a 1 km run with accuracy varying from 3 m to 25 m comes within 3% of 1 km (seed ${seed})`,
      kind: "run",
      events: along([point(0, 0), point(0, 1000)], 3, { accuracyM: () => 3 + 22 * varying() }),
      expect: { near: 1000, within: 0.03 },
    };
  }),
  ...SEEDS.map((seed): MovementCase => ({
    name: `a 5 km loop at 3 m/s with error wandering 3 m to 8 m comes within 1.5% (seed ${seed})`,
    kind: "run",
    events: loop(wandering(seed)),
    expect: { near: LOOP_M, within: 0.015 },
  })),
  ...SEEDS.map((seed): MovementCase => ({
    name: `a 5 km loop at 3 m/s with every reading 3 m to 8 m off comes within 4% (seed ${seed})`,
    kind: "run",
    events: loop(jitter(seed)),
    expect: { near: LOOP_M, within: 0.04 },
  })),
  {
    name: "a 200 m hairpin walked at 1 m/s comes within 2% of 200 m",
    kind: "walk",
    events: along([point(0, 0), point(0, 100), point(0, 0)], 1),
    expect: { near: 200, within: 0.02 },
  },
  {
    name: "a 600 m hairpin run at 3 m/s comes within 2% of 600 m",
    kind: "run",
    events: along([point(0, 0), point(0, 300), point(0, 0)], 3),
    expect: { near: 600, within: 0.02 },
  },
  ...[
    { kind: "walk" as const, speed: 1 },
    { kind: "run" as const, speed: 3 },
  ].map(({ kind, speed }): MovementCase => ({
    name: `a 200 m out-and-back at ${speed} m/s with the reading at the far end 20 m out comes within 2% saved and 3% shown`,
    kind,
    events: noisyApex(speed),
    expect: { near: 200, within: 0.02, live: 0.03 },
  })),
  {
    name: "a run with no readings for 30 s in a tunnel comes within 2% of 900 m",
    kind: "run",
    events: tunnelRun,
    expect: { near: 900, within: 0.02 },
  },
  ...SEEDS.map((seed): MovementCase => ({
    name: `a 0.5 m/s zigzag of 20 m traverses 3 m apart, read to 10 m, comes within 3% saved and 5% shown (seed ${seed})`,
    kind: "hike",
    events: along(zigzag, 0.5, { accuracyM: () => 10, speedMps: reported(seed) }),
    expect: { near: pathLengthM(zigzag), within: 0.03, live: 0.05 },
  })),
  ...SEEDS.map((seed): MovementCase => ({
    name: `ten minutes round a 20 m radius circle at 1 m/s comes within 2% saved and 3% shown (seed ${seed})`,
    kind: "walk",
    events: circling(20, 1, 600, reported(seed)),
    expect: { near: 600, within: 0.02, live: 0.03 },
  })),
  ...SEEDS.map((seed): MovementCase => ({
    name: `four laps of a running track at 3 m/s come within 2% saved and 3% shown (seed ${seed})`,
    kind: "run",
    events: circling(TRACK_RADIUS_M, 3, TRACK_SECONDS, reported(seed)),
    expect: { near: 3 * TRACK_SECONDS, within: 0.02, live: 0.03 },
  })),
  ...SEEDS.map((seed): MovementCase => ({
    name: `20 m out and 20 m back at 1 m/s comes within 2 m saved and shown (seed ${seed})`,
    kind: "walk",
    events: along([point(0, 0), point(0, 20), point(0, 0)], 1, { speedMps: reported(seed) }),
    expect: { near: 40, within: 2 / 40, live: 2 / 40 },
  })),
  {
    name: "a ride at 12 m/s comes within 1% of 6 km and keeps every reading",
    kind: "ride",
    events: ride,
    expect: { near: 6000, within: 0.01 },
    also: ({ recording }) => {
      // Every reading but the last, which nothing came after to confirm until the end.
      expect(recording.segments[0]!.fixes).toHaveLength(ride.length - 1);
      expect(segmentFixes(recording.segments[0]!)).toHaveLength(ride.length);
    },
  },
];

describe("movement", () => {
  it.each(MOVEMENT)("$name", ({ kind, events, expect: expected, also }) => {
    const played = play(kind, events);
    const live = played.shown.at(-1)!;
    const saved = savedM(played.recording, events.at(-1)!);
    if ("atMost" in expected) {
      expect(Math.max(...played.shown)).toBeLessThanOrEqual(expected.atMost);
      expect(saved).toBeLessThanOrEqual(expected.atMost);
    } else {
      expect(Math.abs(saved - expected.near) / expected.near).toBeLessThanOrEqual(expected.within);
      if (expected.live === undefined) {
        expect(Math.abs(live - expected.near) / expected.near).toBeLessThanOrEqual(expected.within);
        expect(Math.abs(live - saved) / saved).toBeLessThanOrEqual(0.01);
      } else {
        expect(Math.abs(live - expected.near) / expected.near).toBeLessThanOrEqual(expected.live);
      }
    }
    also?.(played);
  });
});

/**
 * Two hours of laps of a 1 km loop at 3 m/s, every reading up to 5 m off, with a 10 minute
 * stop, every reading reporting its speed.
 */
const twoHours = (() => {
  const next = seededRandom(5);
  const speedMps = reported(5);
  const radius = 1000 / (2 * Math.PI);
  let travelled = 0;
  const events = Array.from({ length: 7200 }, (_, second) => {
    const onTheMove = second < 3000 || second >= 3600;
    if (onTheMove) travelled += 3;
    const angle = travelled / radius;
    return fixAt(
      second,
      point(
        radius * Math.cos(angle) + (next() * 2 - 1) * 5,
        radius * Math.sin(angle) + (next() * 2 - 1) * 5,
      ),
      5,
      speedMps(onTheMove ? 3 : 0),
    );
  });
  return { events, travelled };
})();

describe("a long recording", () => {
  it("replays 7,200 readings within 100 ms, adding each without copying the ones before", () => {
    const times = Array.from({ length: 3 }, () => {
      const started = performance.now();
      replay([start, ...twoHours.events]);
      return performance.now() - started;
    });
    expect(Math.min(...times)).toBeLessThan(100);
  });

  it("comes within 1% of two hours of laps with a stop", () => {
    const recording = replay([start, ...twoHours.events])!;
    const near = (distance: number) => Math.abs(distance / twoHours.travelled - 1);
    expect(near(recordedDistanceM(recording))).toBeLessThanOrEqual(0.01);
    expect(near(savedM(recording, twoHours.events.at(-1)!))).toBeLessThanOrEqual(0.01);
  });

  it("leaves each earlier state as it was when later readings arrive", () => {
    const events = [start, ...along([point(0, 0), point(0, 100), point(0, 0)], 1)];
    const states: Recording[] = [];
    const seen: string[] = [];
    for (const event of events) {
      const state = applyEvent(states.at(-1), event)!;
      states.push(state);
      seen.push(JSON.stringify(segmentTrack(state.segments[0]!)));
    }
    // Another reading added to an earlier state, past the turn, changes no state, and
    // that state goes on as if it were the latest.
    const other = fixAt(120.5, point(2, 80));
    const branch = applyEvent(states[120], other)!;
    expect(states.map((state) => JSON.stringify(segmentTrack(state.segments[0]!)))).toEqual(seen);
    expect(segmentTrack(branch.segments[0]!)).toEqual(
      segmentTrack(replay([...events.slice(0, 121), other])!.segments[0]!),
    );
  });
});

describe("a track's readings", () => {
  it("are, in an earlier version, only its own after a later version adds one", () => {
    let older = emptyTrack<Fix>(MOTION.run);
    for (const event of moving(0, 10, 3)) {
      if (event.type === "fix") older = addReading(older, event.fix);
    }
    const before = [...older.fixes];
    const newer: Track<Fix> = addReading(older, (moving(11, 11, 3)[0] as { fix: Fix }).fix);
    expect(newer.fixes.length).toBe(older.fixes.length + 1);
    expect(older.fixes).toHaveLength(before.length);
    expect([...older.fixes]).toEqual(before);
    expect(older.fixes.toArray()).toEqual(before);
    expect(older.fixes.slice(0, 100)).toEqual(before);
    expect(older.fixes.at(before.length)).toBeUndefined();
    expect(older.fixes.at(-1)).toBe(before.at(-1));
    expect(Object.keys(older.fixes)).toEqual(["length"]);
  });
});

describe("a recording", () => {
  it("counts the time of every reading and the distance up to the one before the latest", () => {
    // The latest reading counts once a later one confirms it.
    const recording = replay([start, ...moving(0, 100, 4)])!;
    expect(recordedDistanceM(recording)).toBeCloseTo(396, 0);
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
    // Each stretch counts up to the reading before its last.
    expect(recordedDistanceM(recording)).toBeCloseTo(2 * 236, 0);
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
      fix(6, 12, sure),
    ])!;
    expect(segmentFixes(recording.segments[0]!).map((f) => f.at)).toEqual([
      T,
      T + 2000,
      T + 3000,
      T + 5000,
      // No later reading confirms the last one, so it counts once the stretch ends.
      T + 6000,
    ]);
    expect(recordedDistanceM(recording)).toBeCloseTo(9, 0);
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
      speedMps: null,
    });
  });

  it("keeps the speed iOS measured, and drops one it could not", () => {
    expect(fixOf({ ...reading, coords: { ...reading.coords, speed: 1.5 } }).speedMps).toBe(1.5);
    expect(fixOf({ ...reading, coords: { ...reading.coords, speed: -1 } }).speedMps).toBeNull();
    expect(fixOf({ ...reading, coords: { ...reading.coords, speed: null } }).speedMps).toBeNull();
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
    const events = [start, fix(1, 3, { altitudeM: 12.5, speedMps: 2.5 }), pause(2), resume(3)];
    const text = events.map((event) => `${encodeRecordingEvent(event)}\n`).join("");
    expect(parseJournal(text)).toEqual(events);
  });

  it("skips a last line cut short by a crash and lines that are not events", () => {
    const text = `${encodeRecordingEvent(start)}\n{"type":"pause","at":1}\n{"type":"fix","fix":{"at":`;
    expect(parseJournal(`${text}\n{"type":"jump"}\n`)).toEqual([start, { type: "pause", at: 1 }]);
  });
});
