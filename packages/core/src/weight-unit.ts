import { Schema } from "effect";

import type { NumberEntryLimits } from "./number-entry.ts";

/**
 * The unit weights are shown and typed in. svett always stores kilograms, so a weight typed
 * in pounds is converted here and nowhere else.
 */
export const WeightUnit = Schema.Literals(["kg", "lb"]);
export type WeightUnit = typeof WeightUnit.Type;

/** The international pound, exactly. */
export const KG_PER_LB = 0.45359237;

export const WEIGHT_UNIT_OPTIONS: ReadonlyArray<{
  readonly value: WeightUnit;
  readonly label: string;
}> = [
  { value: "kg", label: "Kilograms" },
  { value: "lb", label: "Pounds" },
];

/** A stored weight in kilograms, in `unit`, unrounded. */
export const weightIn = (kg: number, unit: WeightUnit): number =>
  unit === "kg" ? kg : kg / KG_PER_LB;

/** Kilograms to store for a weight typed in `unit`. */
export const kgFrom = (value: number, unit: WeightUnit): number =>
  unit === "kg" ? value : value * KG_PER_LB;

/** Rounds to at most two decimals and drops trailing zeros, so 82.50 reads "82.5". */
export const formatWeightNumber = (value: number): string => String(Math.round(value * 100) / 100);

/** A stored weight as the user reads it, without the unit, such as "225" for 102.06 kg in lb. */
export const formatWeight = (kg: number, unit: WeightUnit): string =>
  formatWeightNumber(weightIn(kg, unit));

/** A stored weight with its unit, such as "225 lb". */
export const formatWeightWithUnit = (kg: number, unit: WeightUnit): string =>
  `${formatWeight(kg, unit)} ${unit}`;

/** What VoiceOver reads for a unit after a number. */
export const WEIGHT_UNIT_NAME: Readonly<Record<WeightUnit, string>> = {
  kg: "kilograms",
  lb: "pounds",
};

/**
 * The kilograms a typed weight stands for, or null when the field is empty. Text that still
 * reads as the stored weight keeps it exactly, because the field shows it rounded: 225 lb is
 * 102.0582... kg, and saving "225" again must not move it.
 */
export const kgFromText = (
  text: string,
  stored: number | null,
  unit: WeightUnit,
): number | null => {
  if (text === "") return null;
  if (stored !== null && text === formatWeight(stored, unit)) return stored;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? kgFrom(value, unit) : null;
};

/** How a weight is typed: two decimals in either unit, and a stepper press of 2.5 kg or 5 lb. */
export const WEIGHT_ENTRY: Readonly<Record<WeightUnit, NumberEntryLimits>> = {
  kg: { decimals: 2, maxIntegerDigits: 4, step: 2.5 },
  lb: { decimals: 2, maxIntegerDigits: 4, step: 5 },
};
