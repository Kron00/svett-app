import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import { setEditFrom, setEditPatch } from "./set-edit.ts";

const lifted = {
  setType: "normal",
  weightKg: 82.5,
  reps: 8,
  durationS: null,
  distanceM: null,
} as const;
const plank = {
  setType: "normal",
  weightKg: null,
  reps: null,
  durationS: DurationSeconds.make(60),
  distanceM: null,
} as const;

describe("setEditFrom", () => {
  it("fills the fields with the set's values", () => {
    expect(setEditFrom(lifted)).toEqual({ setType: "normal", weight: "82.5", reps: "8" });
    expect(setEditFrom(plank)).toEqual({ setType: "normal", weight: "", reps: "" });
  });
});

describe("setEditPatch", () => {
  it("saves the typed weight, reps and type", () => {
    expect(setEditPatch({ setType: "failure", weight: "100.25", reps: "3" }, lifted)).toEqual({
      ok: true,
      patch: { setType: "failure", weightKg: 100.25, reps: 3 },
    });
  });

  it("keeps a weight the field shows rounded when only the reps change", () => {
    const pounds = { ...lifted, weightKg: 102.0582 };
    expect(setEditPatch({ ...setEditFrom(pounds), reps: "6" }, pounds)).toEqual({
      ok: true,
      patch: { setType: "normal", weightKg: 102.0582, reps: 6 },
    });
  });

  it("saves a typed weight that differs from the one the field showed", () => {
    const pounds = { ...lifted, weightKg: 102.0582 };
    expect(setEditPatch({ setType: "normal", weight: "102.05", reps: "8" }, pounds)).toEqual({
      ok: true,
      patch: { setType: "normal", weightKg: 102.05, reps: 8 },
    });
  });

  it("reads a trailing decimal point as the whole number", () => {
    expect(setEditPatch({ setType: "normal", weight: "90.", reps: "5" }, lifted)).toEqual({
      ok: true,
      patch: { setType: "normal", weightKg: 90, reps: 5 },
    });
  });

  it("clears the weight for a bodyweight set", () => {
    expect(setEditPatch({ setType: "normal", weight: "", reps: "12" }, lifted)).toEqual({
      ok: true,
      patch: { setType: "normal", weightKg: null, reps: 12 },
    });
  });

  it("refuses a set left with no reps, time or distance", () => {
    expect(setEditPatch({ setType: "normal", weight: "80", reps: "" }, lifted)).toEqual({
      ok: false,
      message: "A set needs reps. Enter how many you did.",
    });
  });

  it("lets a timed set go without reps", () => {
    expect(setEditPatch({ setType: "normal", weight: "10", reps: "" }, plank)).toEqual({
      ok: true,
      patch: { setType: "normal", weightKg: 10, reps: null },
    });
  });

  it("opens a set in pounds and stores a weight typed in pounds as kilograms", () => {
    expect(setEditFrom(lifted, "lb").weight).toBe("181.88");
    expect(setEditPatch({ setType: "normal", weight: "185", reps: "8" }, lifted, "lb")).toEqual({
      ok: true,
      patch: { setType: "normal", weightKg: 185 * 0.45359237, reps: 8 },
    });
  });

  it("keeps the stored kilograms when a weight shown in pounds is saved unchanged", () => {
    const edit = { ...setEditFrom(lifted, "lb"), reps: "9" };
    expect(setEditPatch(edit, lifted, "lb")).toEqual({
      ok: true,
      patch: { setType: "normal", weightKg: 82.5, reps: 9 },
    });
  });
});
