import type { NumberEntryLimits } from "./number-entry.ts";
import {
  isMeasurementValue,
  MEASUREMENT_RANGE,
  MEASUREMENT_UNIT,
  MeasurementKind,
  type Measurement,
} from "./schema.ts";
import type { SeriesPoint } from "./series.ts";
import { formatWeightNumber, kgFrom, type WeightUnit, weightIn } from "./weight-unit.ts";

export const MEASUREMENT_LABEL: Readonly<Record<MeasurementKind, string>> = {
  body_weight: "Body weight",
  body_fat: "Body fat",
  neck: "Neck",
  shoulders: "Shoulders",
  chest: "Chest",
  left_biceps: "Left biceps",
  right_biceps: "Right biceps",
  left_forearm: "Left forearm",
  right_forearm: "Right forearm",
  abdomen: "Abdomen",
  waist: "Waist",
  hips: "Hips",
  left_thigh: "Left thigh",
  right_thigh: "Right thigh",
  left_calf: "Left calf",
  right_calf: "Right calf",
};

const UNIT_TEXT = { percent: "%", cm: "cm" } as const;

/** Body weight reads in the unit weights show in. svett stores it in kilograms. */
export const measurementUnitText = (kind: MeasurementKind, weightUnit: WeightUnit): string => {
  const unit = MEASUREMENT_UNIT[kind];
  return unit === "kg" ? weightUnit : UNIT_TEXT[unit];
};

/** A stored measurement in the unit it shows in, unrounded. */
export const measurementValueIn = (
  kind: MeasurementKind,
  value: number,
  weightUnit: WeightUnit,
): number => (MEASUREMENT_UNIT[kind] === "kg" ? weightIn(value, weightUnit) : value);

/** A value already in the unit it shows in, such as a chart point or tick. */
export const formatShownMeasurement = (
  kind: MeasurementKind,
  shown: number,
  weightUnit: WeightUnit,
): string => `${formatWeightNumber(shown)} ${measurementUnitText(kind, weightUnit)}`;

export const isMeasurementKind = (value: unknown): value is MeasurementKind =>
  MeasurementKind.literals.some((kind) => kind === value);

/** "82.4 kg" or "181.66 lb", "18.5 %", "88 cm". */
export const formatMeasurement = (
  kind: MeasurementKind,
  value: number,
  weightUnit: WeightUnit,
): string => formatShownMeasurement(kind, measurementValueIn(kind, value, weightUnit), weightUnit);

/** Every measurement is typed to one decimal, from a tape, a scale or a body fat reading. */
export const MEASUREMENT_ENTRY: NumberEntryLimits = { decimals: 1, maxIntegerDigits: 3, step: 0.1 };

/**
 * The range a measurement is typed in. Body weight in pounds keeps to whole pounds inside the
 * stored range of 20 to 400 kg, so the sheet never shows 44.09.
 */
export const measurementEntryRange = (
  kind: MeasurementKind,
  weightUnit: WeightUnit,
): { readonly min: number; readonly max: number } => {
  const { min, max } = MEASUREMENT_RANGE[MEASUREMENT_UNIT[kind]];
  return MEASUREMENT_UNIT[kind] === "kg" && weightUnit === "lb"
    ? { min: Math.ceil(weightIn(min, "lb")), max: Math.floor(weightIn(max, "lb")) }
    : { min, max };
};

/**
 * The value to store for a measurement entry, body weight in kilograms, or null when the entry
 * is empty or outside the kind's range.
 */
export const parseMeasurementEntry = (
  kind: MeasurementKind,
  entry: string,
  weightUnit: WeightUnit,
): number | null => {
  const value = Number(entry);
  const { min, max } = measurementEntryRange(kind, weightUnit);
  if (entry === "" || !Number.isFinite(value) || value < min || value > max) return null;
  const stored = MEASUREMENT_UNIT[kind] === "kg" ? kgFrom(value, weightUnit) : value;
  return isMeasurementValue(kind, stored) ? stored : null;
};

/** "From 20 to 400 kg." or "From 45 to 881 lb." */
export const measurementRangeText = (kind: MeasurementKind, weightUnit: WeightUnit): string => {
  const { min, max } = measurementEntryRange(kind, weightUnit);
  return `From ${min} to ${formatShownMeasurement(kind, max, weightUnit)}.`;
};

export interface LatestMeasurement {
  readonly kind: MeasurementKind;
  readonly latest: Measurement;
  /** latest minus the one before it, or null when there is only one. */
  readonly change: number | null;
}

/** Each kind's latest measurement, in MeasurementKind order. Kinds never measured are left out. */
export const latestMeasurements = (
  measurements: ReadonlyArray<Measurement>,
): ReadonlyArray<LatestMeasurement> =>
  MeasurementKind.literals.flatMap((kind) => {
    const ofKind = measurements
      .filter((measurement) => measurement.kind === kind)
      .sort((a, b) => a.measuredAt - b.measuredAt);
    const latest = ofKind[ofKind.length - 1];
    if (latest === undefined) return [];
    const before = ofKind[ofKind.length - 2];
    const change =
      before === undefined ? null : Math.round((latest.value - before.value) * 10) / 10;
    return [{ kind, latest, change }];
  });

/** "+0.4 kg", "−1.2 cm", "No change". */
export const formatMeasurementChange = (
  kind: MeasurementKind,
  change: number,
  weightUnit: WeightUnit,
): string =>
  change === 0
    ? "No change"
    : `${change > 0 ? "+" : "−"}${formatMeasurement(kind, Math.abs(change), weightUnit)}`;

/** One kind's measurements as points in the unit they show in, oldest first, from `from` on. */
export const measurementSeries = (
  measurements: ReadonlyArray<Measurement>,
  kind: MeasurementKind,
  weightUnit: WeightUnit,
  from: number | null = null,
): ReadonlyArray<SeriesPoint> =>
  measurements
    .filter(
      (measurement) =>
        measurement.kind === kind && (from === null || measurement.measuredAt >= from),
    )
    .sort((a, b) => a.measuredAt - b.measuredAt)
    .map((measurement) => ({
      key: measurement.id,
      at: measurement.measuredAt,
      value: measurementValueIn(kind, measurement.value, weightUnit),
    }));
