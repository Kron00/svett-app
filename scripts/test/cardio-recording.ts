// Saves a run recorded along a proof route into a database file, as svett would
// after the simulator played it, for tests of scripts/cardio-proof.ts and sim/cardio.sh.
// Usage: node scripts/test/cardio-recording.ts <route.json> <svett.db> [--short]
// --short stops 100 m before the end of the route.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  ActivityId,
  ActivityRepository,
  cardioDraft,
  databaseLayer,
  distanceM,
  Ids,
  type RecordingEvent,
  replay,
  summarizeRecording,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect } from "effect";

import { readRoute, type Route } from "../cardio-proof.ts";

/** Readings every second along the route at its speed, as the simulator plays it. */
export const recordAlong = (route: Route, startedAt: number, shortM = 0): RecordingEvent[] => {
  const events: RecordingEvent[] = [
    {
      type: "start",
      at: startedAt,
      kind: "run",
      activityId: ActivityId.make("0190a000-0000-7000-8000-00000000c0de"),
    },
  ];
  const reading = (second: number, latitude: number, longitude: number): RecordingEvent => ({
    type: "fix",
    fix: {
      at: startedAt + second * 1000,
      latitude,
      longitude,
      altitudeM: null,
      altitudeAccuracyM: null,
      accuracyM: 5,
    },
  });
  const legs = route.waypoints.slice(1).map((to, index) => ({ from: route.waypoints[index]!, to }));
  const total = legs.reduce((sum, { from, to }) => sum + distanceM(from, to), 0);
  let second = 0;
  let travelled = 0;
  for (const { from, to } of legs) {
    const length = distanceM(from, to);
    for (let along = 0; along < length; along += route.speedMps) {
      if (travelled + along > total - shortM) return events;
      const fraction = along / length;
      events.push(
        reading(
          second++,
          from.latitude + (to.latitude - from.latitude) * fraction,
          from.longitude + (to.longitude - from.longitude) * fraction,
        ),
      );
    }
    travelled += length;
  }
  const last = route.waypoints.at(-1)!;
  return [...events, reading(second, last.latitude, last.longitude)];
};

export const saveRecording = async (path: string, events: ReadonlyArray<RecordingEvent>) => {
  const recording = replay(events)!;
  const lastFix = events.findLast((event) => event.type === "fix");
  const end = lastFix?.type === "fix" ? lastFix.fix.at : recording.startedAt;
  mkdirSync(dirname(path), { recursive: true });
  const { database, driver } = openNodeDatabase(path);
  try {
    await Effect.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create(cardioDraft(summarizeRecording(recording, end), "Morning run")),
      ).pipe(Effect.provide(databaseLayer(driver, Ids.layerSeeded(1)))),
    );
  } finally {
    database.close();
  }
};

if (import.meta.main) {
  const [routePath = "", databasePath = "", flag] = process.argv.slice(2);
  await saveRecording(
    databasePath,
    recordAlong(readRoute(routePath), Date.now(), flag === "--short" ? 100 : 0),
  );
}
