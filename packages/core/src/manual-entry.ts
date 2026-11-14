import { Result } from "effect";

import { activityTitle } from "./cardio.ts";
import { DurationSeconds } from "./duration.ts";
import type { ActivityDraft } from "./repositories/activities.ts";
import { MADE_HERE } from "./repositories/origin.ts";
import { EpochMillis } from "./schema.ts";

/** The sports manual entry offers. Strength is logged set by set instead. */
export const MANUAL_KINDS = ["run", "ride", "walk", "hike", "other"] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];

export interface ManualEntry {
  readonly kind: ManualKind;
  readonly startedAt: number;
  /** Minutes, or minutes and seconds as 45:30, or hours as 1:05:00. */
  readonly duration: string;
  /** Kilometres, or empty when the sport has no distance. */
  readonly distance: string;
  readonly notes: string;
}

export interface ManualProblem {
  readonly field: "start" | "duration" | "distance";
  readonly message: string;
}

const MAX_DURATION_S = 48 * 3600;
const MAX_DISTANCE_M = 1_000_000;

/**
 * Reads a duration as a person types it: 45 is 45 minutes, 45:30 is 45 minutes and
 * 30 seconds, and 1:05:00 is an hour and five minutes. Null when it is not a time.
 */
export const parseDuration = (text: string): number | null => {
  const parts = text.trim().split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+(?:[.,]\d+)?$/.test(part))) return null;
  const numbers = parts.map((part) => Number(part.replace(",", ".")));
  if (numbers.length > 1 && numbers.slice(1).some((value) => value >= 60)) return null;
  const [first, second, third] = numbers;
  if (numbers.length === 1) return first! * 60;
  if (numbers.length === 2) return first! * 60 + second!;
  return first! * 3600 + second! * 60 + third!;
};

/** Kilometres as typed, with a point or a comma, in metres. Null when empty, NaN when not a number. */
export const parseDistanceKm = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d+(?:[.,]\d+)?$/.test(trimmed) ? Number(trimmed.replace(",", ".")) * 1000 : Number.NaN;
};

/**
 * Checks a manual entry and turns it into an activity to save. `localHour` is the hour
 * on the phone's clock when it started, for a title such as "Evening ride".
 */
export const manualEntryDraft = (
  entry: ManualEntry,
  now: number,
  localHour: number,
): Result.Result<ActivityDraft, ManualProblem> => {
  const durationS = parseDuration(entry.duration);
  if (durationS === null || durationS <= 0 || durationS > MAX_DURATION_S) {
    return Result.fail({
      field: "duration",
      message: "Enter how long it took, such as 45 for 45 minutes or 1:05:00.",
    });
  }
  const distanceM = parseDistanceKm(entry.distance);
  if (distanceM !== null && !(distanceM >= 0 && distanceM <= MAX_DISTANCE_M)) {
    return Result.fail({
      field: "distance",
      message: "Enter the distance in kilometres, such as 5.2, or leave it empty.",
    });
  }
  if (entry.startedAt > now) {
    return Result.fail({ field: "start", message: "The start is in the future." });
  }
  return Result.succeed({
    kind: entry.kind,
    startedAt: EpochMillis.make(Math.round(entry.startedAt)),
    durationS: DurationSeconds.make(durationS),
    title: activityTitle(entry.kind, localHour),
    notes: entry.notes.trim(),
    energyKcal: null,
    audience: "only_you",
    hiddenFields: [],
    origin: MADE_HERE,
    exercises: [],
    track:
      distanceM === null
        ? null
        : { distanceM, elevationGainM: null, hideStartM: 0, hideEndM: 0, samples: [] },
  });
};
