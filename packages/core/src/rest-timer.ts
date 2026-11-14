import { DurationSeconds, formatDuration } from "./duration.ts";
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

/** A rest that is running: when it ends, and how long it was set for. */
export type RestTimer = {
  readonly endsAt: number;
  readonly totalS: number;
  /** The exercise the next set belongs to, for the notification. */
  readonly exercise: string;
};

export const startRest = (seconds: number, exercise: string, now: number): RestTimer => ({
  endsAt: now + seconds * 1000,
  totalS: seconds,
  exercise,
});

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
