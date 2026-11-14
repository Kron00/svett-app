// Plays the cardio proof route and judges the activity svett saved from it.
// Usage:
//   node scripts/cardio-proof.ts leg <route.json> <1|2>      waypoints for simctl location start
//   node scripts/cardio-proof.ts seconds <route.json> <1|2>  how long that leg takes
//   node scripts/cardio-proof.ts speed <route.json>          metres a second to play it at
//   node scripts/cardio-proof.ts check <route.json> <svett.db> <started-after-ms>
// `check` reads the newest run, walk, hike or ride that started after the given
// time, prints what it found, and exits 1 unless the distance is within 1% of the
// route's length and the splits add up to the distance and the moving time.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { type LatLng, pathLengthM } from "@svett/core";
import { Schema } from "effect";

const Point = Schema.Struct({
  latitude: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
  longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
});

export const Route = Schema.Struct({
  description: Schema.String,
  speedMps: Schema.Finite.check(Schema.isGreaterThan(0)),
  /** The waypoint where the recording pauses, between the two legs. */
  pauseAt: Schema.Int.check(Schema.isGreaterThan(0)),
  waypoints: Schema.Array(Point).check(Schema.isMinLength(3)),
}).check(
  Schema.makeFilter((route) =>
    route.pauseAt < route.waypoints.length - 1
      ? undefined
      : "the pause is before the last waypoint",
  ),
);
export type Route = typeof Route.Type;

export const readRoute = (path: string): Route =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Route))(readFileSync(path, "utf8"));

/** The waypoints of leg 1, up to the pause, or leg 2, from the pause on. */
export const legOf = (route: Route, leg: 1 | 2): ReadonlyArray<LatLng> =>
  leg === 1 ? route.waypoints.slice(0, route.pauseAt + 1) : route.waypoints.slice(route.pauseAt);

export const legSeconds = (route: Route, leg: 1 | 2): number =>
  Math.ceil(pathLengthM(legOf(route, leg)) / route.speedMps);

export interface SavedRecording {
  readonly title: string;
  readonly distanceM: number;
  readonly durationS: number;
  readonly splits: ReadonlyArray<{ readonly distanceM: number; readonly durationS: number }>;
}

/** How far the saved distance may be from the route's length. */
export const DISTANCE_TOLERANCE = 0.01;
// Floating point sums of a few hundred readings, far below anything a person could see.
const SUM_TOLERANCE = 0.01;

export const judge = (routeLengthM: number, saved: SavedRecording) => {
  const sum = (key: "distanceM" | "durationS") =>
    saved.splits.reduce((total, split) => total + split[key], 0);
  const error = Math.abs(saved.distanceM - routeLengthM) / routeLengthM;
  const checks = [
    {
      ok: error <= DISTANCE_TOLERANCE,
      line: `Distance ${saved.distanceM.toFixed(1)} m against the route's ${routeLengthM.toFixed(1)} m, off by ${(error * 100).toFixed(2)}%, within ${DISTANCE_TOLERANCE * 100}%`,
    },
    {
      ok: Math.abs(sum("distanceM") - saved.distanceM) <= SUM_TOLERANCE,
      line: `${saved.splits.length} splits add up to ${sum("distanceM").toFixed(1)} m of ${saved.distanceM.toFixed(1)} m`,
    },
    {
      ok: Math.abs(sum("durationS") - saved.durationS) <= SUM_TOLERANCE,
      line: `Split times add up to ${sum("durationS").toFixed(1)} s of ${saved.durationS.toFixed(1)} s moving`,
    },
  ];
  return {
    ok: checks.every((check) => check.ok),
    lines: [
      `Activity "${saved.title}"`,
      ...checks.map((check) => `${check.ok ? "PASSED" : "FAILED"}: ${check.line}`),
      ...saved.splits.map(
        (split, index) =>
          `Split ${index + 1}: ${split.distanceM.toFixed(1)} m in ${split.durationS.toFixed(1)} s`,
      ),
    ],
  };
};

const CARDIO = "('run', 'walk', 'hike', 'ride')";

/** Reads with plain SQL, so the app's own file is never migrated or written. */
export const readSavedRecording = (path: string, startedAfter: number): SavedRecording | null => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const activity = database
      .prepare(
        `SELECT a.title, a.duration_s, t.id AS track_id, t.distance_m FROM activity a
         JOIN activity_track t ON t.activity_id = a.id AND t.deleted_at IS NULL
         WHERE a.deleted_at IS NULL AND a.kind IN ${CARDIO} AND a.started_at >= ?
         ORDER BY a.started_at DESC LIMIT 1`,
      )
      .get(startedAfter);
    if (activity === undefined) return null;
    const splits = database
      .prepare(
        `SELECT distance_m, duration_s FROM activity_sample
         WHERE activity_track_id = ? AND kind = 'split' AND deleted_at IS NULL
         ORDER BY recorded_at, id`,
      )
      .all(activity["track_id"] as string);
    return {
      title: String(activity["title"]),
      distanceM: Number(activity["distance_m"]),
      durationS: Number(activity["duration_s"]),
      splits: splits.map((split) => ({
        distanceM: Number(split["distance_m"]),
        durationS: Number(split["duration_s"]),
      })),
    };
  } finally {
    database.close();
  }
};

const leg = (value: string | undefined): 1 | 2 => {
  if (value === "1" || value === "2") return Number(value) as 1 | 2;
  throw new Error(`The leg is 1 or 2, not ${value}`);
};

if (import.meta.main) {
  const [command, routePath = "", ...rest] = process.argv.slice(2);
  const route = readRoute(routePath);
  switch (command) {
    case "leg":
      console.log(
        legOf(route, leg(rest[0]))
          .map((point) => `${point.latitude},${point.longitude}`)
          .join(" "),
      );
      break;
    case "seconds":
      console.log(legSeconds(route, leg(rest[0])));
      break;
    case "speed":
      console.log(route.speedMps);
      break;
    case "check": {
      const [databasePath = "", after = "0"] = rest;
      const saved = readSavedRecording(databasePath, Number(after));
      if (saved === null) {
        console.log(`FAILED: no run, walk, hike or ride started after ${after} in ${databasePath}`);
        process.exit(1);
      }
      const verdict = judge(pathLengthM(route.waypoints), saved);
      console.log(verdict.lines.join("\n"));
      process.exit(verdict.ok ? 0 : 1);
    }
    default:
      console.error(
        "Usage: cardio-proof.ts leg|seconds <route.json> <1|2>, speed <route.json>, or check <route.json> <db> <after-ms>",
      );
      process.exit(64);
  }
}
