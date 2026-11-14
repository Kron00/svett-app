import {
  ExerciseRepository,
  localDay,
  MeasurementRepository,
  rankBestSets,
  TrainingReads,
} from "@svett/core";
import { Clock, Effect, Option } from "effect";

import type { ToolContext } from "./tools.ts";

const DAY = 86_400_000;
const RECENT_DAYS = 30;
const LIFT_DAYS = 90;
const TOP_LIFTS = 6;
const MAX_WORKOUTS = 20;

/**
 * The data the summary method sends in place of tools: the last 30 days of workouts, the best
 * set of the most logged lifts over 90 days, and the latest body measurements. It stays short,
 * so a request never grows with the size of the history.
 */
export const trainingSummary = (context: ToolContext) => {
  const day = (millis: number) => localDay(millis, context.offsetMinutes);
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const reads = yield* TrainingReads;

    const workouts = yield* reads.workoutsBetween(now - RECENT_DAYS * DAY, now + 1, MAX_WORKOUTS);
    const logged = [...(yield* reads.timesLogged).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_LIFTS);
    const exercises = yield* ExerciseRepository;
    const lifts: Array<string> = [];
    for (const [id] of logged) {
      const exercise = yield* exercises.get(id);
      const sets = yield* reads.setsOfExercise(id, now - LIFT_DAYS * DAY, now + 1);
      const [best] = rankBestSets(sets, 1);
      if (Option.isNone(exercise) || best === undefined) continue;
      lifts.push(
        `- ${JSON.stringify(exercise.value.name)}: best ${best.weightKg ?? 0} kg x ${best.reps ?? 0} on ${day(best.startedAt)}`,
      );
    }
    const measurements = yield* (yield* MeasurementRepository).list();
    const latest = new Map(measurements.map((measurement) => [measurement.kind, measurement]));

    const text = [
      `Training summary, made ${day(now)}.`,
      `Workouts in the last ${RECENT_DAYS} days (${workouts.length}):`,
      ...workouts.map(
        (workout) =>
          `- ${day(workout.startedAt)} ${JSON.stringify(workout.title)}: ${workout.exercises} exercises, ${workout.workingSets} working sets, ${Math.round(workout.durationS / 60)} min`,
      ),
      `Best set of the most logged lifts in the last ${LIFT_DAYS} days:`,
      ...lifts,
      "Latest body measurements:",
      ...[...latest.values()].map(
        (measurement) =>
          `- ${measurement.kind}: ${measurement.value} on ${day(measurement.measuredAt)}`,
      ),
    ].join("\n");
    return {
      text,
      source: `Training summary: ${workouts.length} workouts in ${RECENT_DAYS} days, ${lifts.length} lifts, ${latest.size} measurements`,
    };
  }).pipe(Effect.catchTag("SqlError", Effect.die));
};
