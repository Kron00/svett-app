import { describe, expect, it } from "vite-plus/test";

import {
  formatMeasurement,
  formatMeasurementChange,
  formatShownMeasurement,
  latestMeasurements,
  measurementRangeText,
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
    expect(measurementSeries(rows, "body_weight", "kg").map((point) => point.value)).toEqual([
      82.4, 81.9,
    ]);
    expect(
      measurementSeries(rows, "body_weight", "kg", Date.UTC(2026, 0, 5)).map((point) => point.key),
    ).toEqual([weightLater.id]);
  });

  it("charts body weight in pounds when weights show in pounds, and tape measurements as they are", () => {
    const pounds = measurementSeries(rows, "body_weight", "lb").map((point) => point.value);
    expect(pounds[0]).toBeCloseTo(181.66, 2);
    expect(pounds[1]).toBeCloseTo(180.56, 2);
    expect(measurementSeries(rows, "waist", "lb").map((point) => point.value)).toEqual([88]);
  });
});

describe("measurement text", () => {
  it("shows each value in its unit", () => {
    expect(formatMeasurement("body_weight", 82.4, "kg")).toBe("82.4 kg");
    expect(formatMeasurement("body_fat", 18.5, "kg")).toBe("18.5 %");
    expect(formatMeasurement("waist", 88, "kg")).toBe("88 cm");
    expect(formatMeasurementChange("body_weight", -0.5, "kg")).toBe("−0.5 kg");
    expect(formatMeasurementChange("waist", 1, "kg")).toBe("+1 cm");
    expect(formatMeasurementChange("waist", 0, "kg")).toBe("No change");
  });

  it("shows body weight in pounds when weights show in pounds", () => {
    expect(formatMeasurement("body_weight", 82.4, "lb")).toBe("181.66 lb");
    expect(formatMeasurement("waist", 88, "lb")).toBe("88 cm");
    expect(formatMeasurementChange("body_weight", -0.5, "lb")).toBe("−1.1 lb");
    expect(formatShownMeasurement("body_weight", 180, "lb")).toBe("180 lb");
  });

  it("takes only a value in the kind's range from the keypad", () => {
    expect(parseMeasurementEntry("body_weight", "82.5", "kg")).toBe(82.5);
    expect(parseMeasurementEntry("body_fat", "18.5", "kg")).toBe(18.5);
    expect(parseMeasurementEntry("waist", "88", "kg")).toBe(88);
    expect(parseMeasurementEntry("body_weight", "", "kg")).toBeNull();
    expect(parseMeasurementEntry("body_weight", "0", "kg")).toBeNull();
    expect(parseMeasurementEntry("body_weight", ".", "kg")).toBeNull();
    expect(parseMeasurementEntry("body_fat", "999.9", "kg")).toBeNull();
    expect(parseMeasurementEntry("body_fat", "100", "kg")).toBeNull();
    expect(parseMeasurementEntry("body_weight", "999.9", "kg")).toBeNull();
    expect(parseMeasurementEntry("body_weight", "8", "kg")).toBeNull();
    expect(parseMeasurementEntry("waist", "880", "kg")).toBeNull();
    expect(parseMeasurementEntry("left_calf", "3", "kg")).toBeNull();
  });

  it("takes body weight typed in pounds and stores it in kilograms", () => {
    expect(parseMeasurementEntry("body_weight", "180", "lb")).toBeCloseTo(81.6466266, 6);
    expect(parseMeasurementEntry("body_weight", "45", "lb")).toBeCloseTo(20.41, 2);
    expect(parseMeasurementEntry("body_weight", "881", "lb")).toBeCloseTo(399.61, 2);
    expect(parseMeasurementEntry("body_weight", "44", "lb")).toBeNull();
    expect(parseMeasurementEntry("body_weight", "882", "lb")).toBeNull();
    expect(parseMeasurementEntry("waist", "88", "lb")).toBe(88);
  });

  it("states each kind's range", () => {
    expect(measurementRangeText("body_weight", "kg")).toBe("From 20 to 400 kg.");
    expect(measurementRangeText("body_weight", "lb")).toBe("From 45 to 881 lb.");
    expect(measurementRangeText("body_fat", "lb")).toBe("From 1 to 75 %.");
    expect(measurementRangeText("waist", "kg")).toBe("From 10 to 250 cm.");
  });
});
