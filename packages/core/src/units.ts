import { Schema } from "effect";

import { ActivityKind } from "./activity-kind.ts";

export const WeightUnit = Schema.Literals(["kg", "lb"]);

export type WeightUnit = typeof WeightUnit.Type;

export const DistanceUnit = Schema.Literals(["km", "mi", "m", "yd"]);

export type DistanceUnit = typeof DistanceUnit.Type;

export const UnitPreferences = Schema.Struct({
  weight: WeightUnit,
  distance: Schema.Record(ActivityKind, DistanceUnit),
});

export type UnitPreferences = typeof UnitPreferences.Type;

export const METRIC_UNITS: UnitPreferences = {
  weight: "kg",
  distance: { strength: "m", run: "km", ride: "km", walk: "km", hike: "km", other: "km" },
};

const KG_PER: Record<WeightUnit, number> = { kg: 1, lb: 0.45359237 };

const METERS_PER: Record<DistanceUnit, number> = { m: 1, km: 1000, mi: 1609.344, yd: 0.9144 };

export const kgTo = (unit: WeightUnit, kg: number): number => kg / KG_PER[unit];

export const toKg = (unit: WeightUnit, value: number): number => value * KG_PER[unit];

export const metersTo = (unit: DistanceUnit, meters: number): number => meters / METERS_PER[unit];

export const toMeters = (unit: DistanceUnit, value: number): number => value * METERS_PER[unit];

export const distanceUnitFor = (prefs: UnitPreferences, kind: ActivityKind): DistanceUnit =>
  prefs.distance[kind];
