import { Exit, Schema } from "effect";

import { DurationSeconds, formatDuration } from "./duration.ts";
import { ActivityExerciseId, ActivityId } from "./schema.ts";
import { supersetPlaces } from "./superset.ts";

/** The rest an exercise gets when neither its routine nor its last workout set one. */
export const DEFAULT_REST_S = DurationSeconds.make(90);

/** How far the timer's minus and plus buttons move it. */
export const REST_ADJUST_S = 15;

/** The rest times the logger offers. 0 turns the timer off for the exercise. */
export const REST_OPTIONS_S: ReadonlyArray<DurationSeconds> = [
  0, 15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 240, 300,
].map((seconds) => DurationSeconds.make(seconds));

/** A rest time as the logger shows it, such as "1:30", or "Off". */
export const restText = (seconds: number | null): string =>
  seconds === null || seconds <= 0 ? "Off" : formatDuration(DurationSeconds.make(seconds));

/** What VoiceOver reads for a rest time, such as "1 minute 30 seconds". */
export const restLabel = (seconds: number | null): string => {
  if (seconds === null || seconds <= 0) return "Off";
  const whole = Math.ceil(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const parts = [
    minutes === 0 ? null : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`,
    rest === 0 ? null : `${rest} ${rest === 1 ? "second" : "seconds"}`,
  ];
  return parts.filter((part) => part !== null).join(" ");
};

export const REST_OPTIONS = REST_OPTIONS_S.map((seconds) => ({
  value: String(seconds),
  label: restText(seconds),
}));

/**
 * The rest after a set of the exercise at `index` is marked done, or null for no timer, with
 * the exercise the next set belongs to. In a superset you go straight on to the next
 * exercise and rest only after the last one of the round, for that exercise's rest time.
 * The round then starts again at its first exercise.
 */
export const restAfterSet = (
  exercises: ReadonlyArray<{
    readonly supersetGroup: number | null;
    readonly restS: number | null;
  }>,
  index: number,
): { readonly seconds: number; readonly next: number } | null => {
  const places = supersetPlaces(exercises);
  const place = places[index];
  if (place === undefined || (place !== null && !place.last)) return null;
  const rest = exercises[index]!.restS;
  if (rest === null || rest <= 0) return null;
  let next = index;
  if (place !== null) while (!places[next]!.first) next -= 1;
  return { seconds: rest, next };
};

/** The set a rest waits for: the exercise it belongs to in the workout in progress. */
export type RestFor = {
  /** The exercise's name, for the notification. */
  readonly exercise: string;
  readonly activityId: ActivityId;
  readonly activityExerciseId: ActivityExerciseId;
};

/**
 * A rest that is running: when it ends, how long it was set for, and the set it waits for.
 * The phone keeps it, so it outlives svett being killed, and it is never exported or synced.
 */
export const RestTimer = Schema.Struct({
  endsAt: Schema.Finite,
  totalS: Schema.Finite,
  exercise: Schema.String,
  activityId: ActivityId,
  activityExerciseId: ActivityExerciseId,
});
export type RestTimer = typeof RestTimer.Type;

export const startRest = (seconds: number, next: RestFor, now: number): RestTimer => ({
  endsAt: now + seconds * 1000,
  totalS: seconds,
  ...next,
});

/** A rest the phone kept, or null when there is none or it does not read as one. */
export const decodeRestTimer = (text: unknown): RestTimer | null => {
  if (typeof text !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const decoded = Schema.decodeUnknownExit(RestTimer)(raw);
  return Exit.isSuccess(decoded) ? decoded.value : null;
};

/**
 * Whether a rest kept from before svett closed still runs at `now`. It ended once its time is
 * up, or when its workout is no longer the one in progress or no longer has its exercise.
 */
export const restStillRuns = (
  rest: RestTimer,
  workout: {
    readonly activityId: ActivityId;
    readonly exerciseIds: ReadonlyArray<ActivityExerciseId>;
  } | null,
  now: number,
): boolean =>
  rest.endsAt > now &&
  workout !== null &&
  workout.activityId === rest.activityId &&
  workout.exerciseIds.includes(rest.activityExerciseId);

/**
 * Whole seconds from `now` until the rest's notification, or null when the rest is already
 * over and needs none. iOS takes at least one second, so a rest with less left gets one.
 */
export const restNoticeSeconds = (rest: RestTimer, now: number): number | null =>
  rest.endsAt <= now ? null : Math.max(1, Math.round((rest.endsAt - now) / 1000));

/** Whole seconds left, counting a part second as one, so it reads 0 only when it ends. */
export const restLeft = (timer: RestTimer, now: number): number =>
  Math.max(0, Math.ceil((timer.endsAt - now) / 1000));

/**
 * The timer moved by `seconds`, more or less. It never goes below zero, and the bar's
 * length grows with it when it runs past what it was set for.
 */
export const adjustRest = (timer: RestTimer, seconds: number, now: number): RestTimer => {
  const endsAt = Math.max(now, timer.endsAt + seconds * 1000);
  return {
    ...timer,
    endsAt,
    totalS: Math.max(timer.totalS + seconds, restLeft({ ...timer, endsAt }, now)),
  };
};

/** The notification that ends a rest. */
export const restNotice = (timer: RestTimer) => ({
  title: "Rest is over",
  body: `Time for your next set of ${timer.exercise}.`,
});
