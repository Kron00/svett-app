import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import { describeSet, formatVolumeKg, workingVolumeKg } from "./history.ts";

const values = (
  weightKg: number | null,
  reps: number | null,
  durationS: number | null = null,
  distanceM: number | null = null,
) => ({
  weightKg,
  reps,
  durationS: durationS === null ? null : DurationSeconds.make(durationS),
  distanceM,
});

describe("describeSet", () => {
  it.each([
    [values(80, 8), "80 kg × 8"],
    [values(null, 12), "12 reps"],
    [values(null, null, 65), "1:05"],
    [values(20, null, 65), "20 kg · 1:05"],
    [values(null, null, 300, 1200), "5:00 · 1.2 km"],
    [values(null, null, null, 400), "400 m"],
  ])("shows %o as %s", (set, expected) => {
    expect(describeSet(set)).toBe(expected);
  });
});

describe("workingVolumeKg", () => {
  it("adds weight times reps and leaves out warm-ups and bodyweight sets", () => {
    expect(
      workingVolumeKg([
        { setType: "warm_up", weightKg: 60, reps: 8 },
        { setType: "normal", weightKg: 100, reps: 5 },
        { setType: "drop", weightKg: 80, reps: 6 },
        { setType: "normal", weightKg: null, reps: 10 },
      ]),
    ).toBe(980);
  });
});

describe("formatVolumeKg", () => {
  it.each([
    [0, "0 kg"],
    [980, "980 kg"],
    [12_450.4, "12,450 kg"],
    [1_234_567, "1,234,567 kg"],
  ])("shows %d as %s", (kg, expected) => {
    expect(formatVolumeKg(kg)).toBe(expected);
  });
});
