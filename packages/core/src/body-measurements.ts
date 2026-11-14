import type { NumberEntryLimits } from "./number-entry.ts";
import { MEASUREMENT_UNIT, MeasurementKind, type Measurement } from "./schema.ts";
import type { SeriesPoint } from "./series.ts";
import { formatWeightKg } from "./set-format.ts";

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

const UNIT_TEXT = { kg: "kg", percent: "%", cm: "cm" } as const;

export const measurementUnitText = (kind: MeasurementKind): string =>
  UNIT_TEXT[MEASUREMENT_UNIT[kind]];

export const isMeasurementKind = (value: unknown): value is MeasurementKind =>
  MeasurementKind.literals.some((kind) => kind === value);

/** "82.4 kg", "18.5 %", "88 cm". */
export const formatMeasurement = (kind: MeasurementKind, value: number): string =>
  `${formatWeightKg(value)} ${measurementUnitText(kind)}`;

/** Every measurement is typed to one decimal, from a tape, a scale or a body fat reading. */
export const MEASUREMENT_ENTRY: NumberEntryLimits = { decimals: 1, maxIntegerDigits: 3, step: 0.1 };

/** The value a measurement entry holds, or null when it is empty or not above zero. */
export const parseMeasurementEntry = (entry: string): number | null => {
  const value = Number(entry);
  return entry === "" || !Number.isFinite(value) || value <= 0 ? null : value;
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
      .toSorted((a, b) => a.measuredAt - b.measuredAt);
    const latest = ofKind[ofKind.length - 1];
    if (latest === undefined) return [];
    const before = ofKind[ofKind.length - 2];
    const change =
      before === undefined ? null : Math.round((latest.value - before.value) * 10) / 10;
    return [{ kind, latest, change }];
  });

/** "+0.4 kg", "−1.2 cm", "No change". */
export const formatMeasurementChange = (kind: MeasurementKind, change: number): string =>
  change === 0
    ? "No change"
    : `${change > 0 ? "+" : "−"}${formatMeasurement(kind, Math.abs(change))}`;

/** One kind's measurements as points, oldest first, from `from` on. */
export const measurementSeries = (
  measurements: ReadonlyArray<Measurement>,
  kind: MeasurementKind,
  from: number | null = null,
): ReadonlyArray<SeriesPoint> =>
  measurements
    .filter(
      (measurement) =>
        measurement.kind === kind && (from === null || measurement.measuredAt >= from),
    )
    .toSorted((a, b) => a.measuredAt - b.measuredAt)
    .map((measurement) => ({
      key: measurement.id,
      at: measurement.measuredAt,
      value: measurement.value,
    }));
