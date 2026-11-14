import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_WORKOUT_SETTINGS,
  parseWorkoutSettings,
  RPE_OPTIONS,
  rpeFromChoice,
  rpeMeaning,
} from "./workout-settings.ts";

describe("workout settings", () => {
  it("starts in kilograms, without RPE", () => {
    expect(parseWorkoutSettings(undefined)).toEqual(DEFAULT_WORKOUT_SETTINGS);
    expect(DEFAULT_WORKOUT_SETTINGS).toMatchObject({ unit: "kg", logRpe: false });
  });

  it("reads saved settings back", () => {
    const saved = { unit: "lb", logRpe: true };
    expect(parseWorkoutSettings(JSON.stringify(saved))).toEqual(saved);
  });

  it("keeps every good field when one is broken", () => {
    const parsed = parseWorkoutSettings(JSON.stringify({ unit: "stone", logRpe: true }));
    expect(parsed).toEqual({ ...DEFAULT_WORKOUT_SETTINGS, logRpe: true });
    expect(parseWorkoutSettings("{not json")).toEqual(DEFAULT_WORKOUT_SETTINGS);
  });

  it("offers RPE 10 down to 6 in halves, each with what it means", () => {
    expect(RPE_OPTIONS.map((option) => option.label)).toEqual([
      "RPE 10, nothing left",
      "RPE 9.5, maybe 1 rep left",
      "RPE 9, 1 rep left",
      "RPE 8.5, 1 to 2 reps left",
      "RPE 8, 2 reps left",
      "RPE 7.5, 2 to 3 reps left",
      "RPE 7, 3 reps left",
      "RPE 6.5, 3 to 4 reps left",
      "RPE 6, 4 reps left",
    ]);
    expect(rpeMeaning(8)).toBe("2 reps left");
    expect(rpeFromChoice("8.5")).toBe(8.5);
    expect(rpeFromChoice("11")).toBeNull();
    expect(rpeFromChoice(null)).toBeNull();
  });
});
