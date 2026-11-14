import { describe, expect, it } from "vite-plus/test";

import {
  formatMeasurement,
  formatMeasurementChange,
  latestMeasurements,
  measurementSeries,
  parseMeasurementEntry,
} from "./body-measurements.ts";
import { EpochMillis, type Measurement, MeasurementId, type MeasurementKind } from "./schema.ts";

let next = 0;
const measured = (kind: MeasurementKind, day: number, value: number): Measurement => ({
  id: MeasurementId.make(`22222222-0000-4000-8000-${String(++next).padStart(12, "0")}`),
  updatedAt: EpochMillis.make(0),
  deletedAt: null,
  kind,
  measuredAt: EpochMillis.make(Date.UTC(2026, 0, day, 7)),
  value,
  source: "svett",
  sourceId: null,
  fingerprint: null,
  importBatchId: null,
});

const weightLater = measured("body_weight", 8, 81.9);
const waist = measured("waist", 2, 88);
const weightFirst = measured("body_weight", 1, 82.4);
const rows = [weightLater, waist, weightFirst];

describe("latestMeasurements", () => {
  it("gives each measured kind its latest value and the change from the one before", () => {
    expect(latestMeasurements(rows)).toEqual([
      { kind: "body_weight", latest: weightLater, change: -0.5 },
      { kind: "waist", latest: waist, change: null },
    ]);
  });
});

describe("measurementSeries", () => {
  it("lists one kind oldest first from the range's start", () => {
    expect(measurementSeries(rows, "body_weight").map((point) => point.value)).toEqual([
      82.4, 81.9,
    ]);
    expect(
      measurementSeries(rows, "body_weight", Date.UTC(2026, 0, 5)).map((point) => point.key),
    ).toEqual([weightLater.id]);
  });
});

describe("measurement text", () => {
  it("shows each value in its unit", () => {
    expect(formatMeasurement("body_weight", 82.4)).toBe("82.4 kg");
    expect(formatMeasurement("body_fat", 18.5)).toBe("18.5 %");
    expect(formatMeasurement("waist", 88)).toBe("88 cm");
    expect(formatMeasurementChange("body_weight", -0.5)).toBe("−0.5 kg");
    expect(formatMeasurementChange("waist", 1)).toBe("+1 cm");
    expect(formatMeasurementChange("waist", 0)).toBe("No change");
  });

  it("takes only a value above zero from the keypad", () => {
    expect(parseMeasurementEntry("82.5")).toBe(82.5);
    expect(parseMeasurementEntry("")).toBeNull();
    expect(parseMeasurementEntry("0")).toBeNull();
    expect(parseMeasurementEntry(".")).toBeNull();
  });
});
