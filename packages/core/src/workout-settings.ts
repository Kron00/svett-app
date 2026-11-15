import { Exit, Schema } from "effect";

import { Rpe } from "./schema.ts";
import { WeightUnit } from "./weight-unit.ts";

/**
 * How this phone shows and asks for weights: the unit, and whether sets ask for an RPE.
 * Weights are stored in kilograms whatever the unit, so these never change what is saved.
 * Your plates and bars are data you made, so they live in the database instead.
 */
export interface WorkoutSettings {
  readonly unit: WeightUnit;
  readonly logRpe: boolean;
}

export const DEFAULT_WORKOUT_SETTINGS: WorkoutSettings = {
  unit: "kg",
  logRpe: false,
};

const field = <S extends Schema.Top>(schema: S, raw: unknown, fallback: S["Type"]): S["Type"] => {
  const decoded = Schema.decodeUnknownExit(Schema.toType(schema))(raw);
  return Exit.isSuccess(decoded) ? decoded.value : fallback;
};

/**
 * Settings saved on the phone, read field by field. A field that is missing or broken takes
 * its default, so one bad value never loses the rest.
 */
export const parseWorkoutSettings = (text: unknown): WorkoutSettings => {
  let raw: unknown;
  try {
    raw = typeof text === "string" ? JSON.parse(text) : undefined;
  } catch {
    raw = undefined;
  }
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    unit: field(WeightUnit, record["unit"], DEFAULT_WORKOUT_SETTINGS.unit),
    logRpe: field(Schema.Boolean, record["logRpe"], DEFAULT_WORKOUT_SETTINGS.logRpe),
  };
};

/** What an RPE says about the set, such as "2 reps left" for 8. */
export const rpeMeaning = (rpe: number): string => {
  const left = 10 - rpe;
  if (left <= 0) return "Nothing left";
  if (left === 0.5) return "Maybe 1 rep left";
  if (Number.isInteger(left)) return `${left} ${left === 1 ? "rep" : "reps"} left`;
  return `${Math.floor(left)} to ${Math.ceil(left)} reps left`;
};

/** The RPEs a set can take in the logger: 6 to 10 in halves, as most lifters rate. */
export const RPE_OPTIONS = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6].map((rpe) => ({
  value: String(rpe),
  label: `RPE ${rpe}, ${rpeMeaning(rpe).toLowerCase()}`,
}));

/** An RPE from the logger's sheet, or null when it is not one. */
export const rpeFromChoice = (value: string | null): number | null => {
  if (value === null) return null;
  const rpe = Number(value);
  return Schema.is(Rpe)(rpe) ? rpe : null;
};
