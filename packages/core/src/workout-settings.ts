import { Exit, Schema } from "effect";

import { BarsAndPlates, type BarsAndPlatesByUnit, DEFAULT_BARS_AND_PLATES } from "./plates.ts";
import { Rpe } from "./schema.ts";
import { WeightUnit } from "./weight-unit.ts";

/**
 * How you log on this phone: the weight unit, whether sets ask for an RPE, and the plates
 * and bars the plate and warm-up calculators load. Weights are stored in kilograms whatever
 * the unit, so these never change what is saved.
 */
export interface WorkoutSettings {
  readonly unit: WeightUnit;
  readonly logRpe: boolean;
  readonly barsAndPlates: BarsAndPlatesByUnit;
}

export const DEFAULT_WORKOUT_SETTINGS: WorkoutSettings = {
  unit: "kg",
  logRpe: false,
  barsAndPlates: DEFAULT_BARS_AND_PLATES,
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
  const saved =
    typeof record["barsAndPlates"] === "object" && record["barsAndPlates"] !== null
      ? (record["barsAndPlates"] as Record<string, unknown>)
      : {};
  return {
    unit: field(WeightUnit, record["unit"], DEFAULT_WORKOUT_SETTINGS.unit),
    logRpe: field(Schema.Boolean, record["logRpe"], DEFAULT_WORKOUT_SETTINGS.logRpe),
    barsAndPlates: {
      kg: field(BarsAndPlates, saved["kg"], DEFAULT_BARS_AND_PLATES.kg),
      lb: field(BarsAndPlates, saved["lb"], DEFAULT_BARS_AND_PLATES.lb),
    },
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
