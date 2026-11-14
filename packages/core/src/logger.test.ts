import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import {
  chooseSetFields,
  columnText,
  defaultSetFields,
  emptyWorkoutTitle,
  fieldPatch,
  entryText,
  entryValue,
  finishPlan,
  formatTimeDigits,
  markDone,
  matchPrevious,
  nextSet,
  placeholderFor,
  secondsFromTimeDigits,
  setFieldsFromSets,
  setsForFields,
  setValuesText,
  typeIntoField,
  unfinishedSets,
} from "./logger.ts";
import type { SetType } from "./schema.ts";

type Values = {
  readonly weightKg: number | null;
  readonly reps: number | null;
  readonly durationS: DurationSeconds | null;
  readonly distanceM: number | null;
};

const values = (change: Partial<Values> = {}): Values => ({
  weightKg: null,
  reps: null,
  durationS: null,
  distanceM: null,
  ...change,
});

const seconds = (value: number) => DurationSeconds.make(value);

const todo = (change: Partial<Values> = {}) => ({
  ...values(change),
  targetRepsMin: null,
  targetRepsMax: null,
});

describe("set fields", () => {
  it("reads what sets record from their values", () => {
    expect(setFieldsFromSets([values({ weightKg: 60, reps: 8 })])).toBe("weight_reps");
    expect(setFieldsFromSets([values({ reps: 12 })])).toBe("reps");
    expect(setFieldsFromSets([values({ durationS: seconds(60) })])).toBe("time");
    expect(setFieldsFromSets([values({ weightKg: 20, durationS: seconds(45) })])).toBe(
      "weight_time",
    );
    expect(setFieldsFromSets([values({ distanceM: 500, durationS: seconds(120) })])).toBe(
      "distance_time",
    );
    expect(setFieldsFromSets([values({ weightKg: 40, distanceM: 30 })])).toBe("weight_distance");
    expect(setFieldsFromSets([values(), values({ weightKg: 60 })])).toBe("weight_reps");
    expect(setFieldsFromSets([values()])).toBeNull();
    expect(setFieldsFromSets([])).toBeNull();
  });

  it("logs cardio by distance and time, stretches by time, and bodyweight moves by reps", () => {
    expect(defaultSetFields({ category: "cardio", equipment: "machine" })).toBe("distance_time");
    expect(defaultSetFields({ category: "stretching", equipment: "none" })).toBe("time");
    expect(defaultSetFields({ category: "strength", equipment: "none" })).toBe("reps");
    expect(defaultSetFields({ category: "strength", equipment: "barbell" })).toBe("weight_reps");
  });

  it("prefers last time, then the exercise's kind, when either shows what the routine plans", () => {
    const squat = { category: "strength", equipment: "barbell" } as const;
    expect(
      chooseSetFields({
        planned: [values({ durationS: seconds(60) })],
        previous: "weight_reps",
        exercise: squat,
      }),
    ).toBe("time");
    expect(chooseSetFields({ planned: [values()], previous: "weight_time", exercise: squat })).toBe(
      "weight_time",
    );
    expect(chooseSetFields({ planned: [], previous: null, exercise: squat })).toBe("weight_reps");
    expect(chooseSetFields({ planned: [], previous: null, exercise: null })).toBe("weight_reps");
  });

  it("keeps the weight a lift logs when a routine plans only its reps", () => {
    const squat = { category: "strength", equipment: "barbell" } as const;
    const pushUp = { category: "strength", equipment: "none" } as const;
    const reps = [values({ reps: 5 })];
    expect(chooseSetFields({ planned: reps, previous: "weight_reps", exercise: squat })).toBe(
      "weight_reps",
    );
    expect(chooseSetFields({ planned: reps, previous: null, exercise: squat })).toBe("weight_reps");
    expect(chooseSetFields({ planned: reps, previous: "time", exercise: squat })).toBe(
      "weight_reps",
    );
    expect(chooseSetFields({ planned: reps, previous: null, exercise: pushUp })).toBe("reps");
    expect(chooseSetFields({ planned: reps, previous: "time", exercise: pushUp })).toBe("reps");
    expect(
      chooseSetFields({
        planned: [values({ weightKg: 20, reps: 10 })],
        previous: "reps",
        exercise: pushUp,
      }),
    ).toBe("weight_reps");
  });
});

const last = (setType: SetType, weightKg: number, reps: number) => ({
  setType,
  ...values({ weightKg, reps }),
});

const withId = (id: string, done: boolean, change: Partial<Values>) => ({
  id,
  done,
  ...values(change),
});

describe("previous values", () => {
  it("lines up the nth set of each type with the nth set of that type last time", () => {
    const previous = [
      last("warm_up", 40, 10),
      last("normal", 80, 8),
      last("normal", 80, 7),
      last("drop", 60, 10),
    ];
    expect(matchPrevious(["warm_up", "normal", "normal", "normal", "drop"], previous)).toEqual([
      previous[0],
      previous[1],
      previous[2],
      null,
      previous[3],
    ]);
  });

  it("matches nothing when the type was not done last time", () => {
    expect(matchPrevious(["failure", "warm_up"], [last("normal", 80, 8)])).toEqual([null, null]);
    expect(matchPrevious(["normal"], [])).toEqual([null]);
  });

  it("shows a set's values in the fields it records", () => {
    expect(setValuesText(values({ weightKg: 82.5, reps: 8 }), "weight_reps")).toEqual({
      text: "82.5 kg × 8",
      label: "82.5 kg, 8 reps",
    });
    expect(setValuesText(values({ reps: 1 }), "reps")).toEqual({ text: "1 rep", label: "1 rep" });
    expect(setValuesText(values({ durationS: seconds(90) }), "time")).toEqual({
      text: "1:30",
      label: "90 seconds",
    });
    expect(
      setValuesText(values({ distanceM: 500, durationS: seconds(125) }), "distance_time"),
    ).toEqual({ text: "500 m in 2:05", label: "500 metres, 125 seconds" });
    expect(setValuesText(values({ weightKg: 40, distanceM: 30 }), "weight_distance")).toEqual({
      text: "40 kg × 30 m",
      label: "40 kg, 30 metres",
    });
  });

  it("leaves out values the fields do not show, and has nothing for an empty set", () => {
    expect(setValuesText(values({ weightKg: 60, reps: 8 }), "time")).toBeNull();
    expect(setValuesText(values({ weightKg: 60, reps: 8 }), "reps")?.text).toBe("8 reps");
    expect(setValuesText(values(), "weight_reps")).toBeNull();
  });

  it("puts last time's value in an empty field, and else the routine's rep range", () => {
    const previous = values({ weightKg: 80, reps: 8 });
    expect(placeholderFor(todo(), "weight", previous)).toEqual({ text: "80", value: 80 });
    expect(placeholderFor(todo(), "reps", previous)).toEqual({ text: "8", value: 8 });
    const range = { ...todo(), targetRepsMin: 8, targetRepsMax: 12 };
    expect(placeholderFor(range, "reps", null)).toEqual({ text: "8-12", value: null });
    expect(
      placeholderFor({ ...todo(), targetRepsMin: 5, targetRepsMax: null }, "reps", null),
    ).toEqual({
      text: "5",
      value: null,
    });
    expect(placeholderFor(range, "weight", null)).toBeNull();
    expect(placeholderFor(todo(), "time", values({ durationS: seconds(75) }))).toEqual({
      text: "1:15",
      value: 75,
    });
  });
});

describe("marking a set done", () => {
  it("keeps what was typed", () => {
    expect(markDone(todo({ weightKg: 100, reps: 5 }), "weight_reps", null)).toEqual({
      ok: true,
      patch: { done: true },
    });
  });

  it("fills empty fields with last time's values", () => {
    expect(
      markDone(todo({ weightKg: 100 }), "weight_reps", values({ weightKg: 90, reps: 6 })),
    ).toEqual({ ok: true, patch: { done: true, reps: 6 } });
    expect(markDone(todo(), "time", values({ durationS: seconds(60) }))).toEqual({
      ok: true,
      patch: { done: true, durationS: 60 },
    });
  });

  it("allows a set with no weight, as bodyweight work has none", () => {
    expect(markDone(todo({ reps: 10 }), "weight_reps", null)).toEqual({
      ok: true,
      patch: { done: true },
    });
  });

  it("refuses a set that records nothing besides its weight", () => {
    expect(markDone(todo({ weightKg: 100 }), "weight_reps", null)).toEqual({
      ok: false,
      problem: "Enter the reps first.",
    });
    expect(
      markDone({ ...todo(), targetRepsMin: 8, targetRepsMax: 12 }, "weight_reps", null),
    ).toMatchObject({ ok: false });
    expect(markDone(todo(), "distance_time", null)).toEqual({
      ok: false,
      problem: "Enter the distance or time first.",
    });
  });
});

describe("changing set fields", () => {
  it("clears the values the new fields do not show", () => {
    expect(
      setsForFields(
        [withId("a", true, { weightKg: 20, reps: 10 }), withId("b", false, { weightKg: 20 })],
        "weight_time",
      ),
    ).toEqual([{ id: "a", patch: { reps: null, done: false } }]);
  });

  it("keeps a done set done while it still records something", () => {
    expect(setsForFields([withId("a", true, { reps: 10 })], "reps")).toEqual([]);
    expect(setsForFields([withId("a", true, { weightKg: 60, reps: 10 })], "reps")).toEqual([
      { id: "a", patch: { weightKg: null } },
    ]);
  });
});

describe("typing a value", () => {
  it("stores the value in its column", () => {
    expect(fieldPatch(withId("a", false, {}), "weight_reps", "weight", 80)).toEqual({
      weightKg: 80,
    });
    expect(fieldPatch(withId("a", true, { reps: 5 }), "weight_time", "time", 30)).toEqual({
      durationS: 30,
    });
  });

  it("puts a done set back to do when its last recorded value is cleared", () => {
    expect(
      fieldPatch(withId("a", true, { weightKg: 80, reps: 5 }), "weight_reps", "reps", null),
    ).toEqual({ reps: null, done: false });
    expect(
      fieldPatch(withId("a", true, { weightKg: 80, reps: 5 }), "weight_reps", "weight", null),
    ).toEqual({ weightKg: null });
    expect(
      fieldPatch(
        withId("a", true, { distanceM: 400, durationS: seconds(90) }),
        "distance_time",
        "time",
        null,
      ),
    ).toEqual({ durationS: null });
  });
});

describe("adding a set", () => {
  it("repeats the last set's values, still to do", () => {
    expect(
      nextSet([
        { setType: "warm_up", ...values({ weightKg: 40, reps: 10 }) },
        { setType: "normal", ...values({ weightKg: 80, reps: 8 }) },
      ]),
    ).toEqual({
      setType: "normal",
      weightKg: 80,
      reps: 8,
      durationS: null,
      distanceM: null,
      targetRepsMin: null,
      targetRepsMax: null,
    });
  });

  it("follows warm-ups with a working set, and starts empty", () => {
    expect(nextSet([{ setType: "warm_up", ...values({ weightKg: 40 }) }]).setType).toBe("normal");
    expect(nextSet([{ setType: "drop", ...values() }]).setType).toBe("drop");
    expect(nextSet([])).toMatchObject({ setType: "normal", weightKg: null, reps: null });
  });
});

describe("typing on the keypad", () => {
  it("fills time from the right, as a timer does", () => {
    expect(formatTimeDigits("")).toBe("");
    expect(formatTimeDigits("5")).toBe("0:05");
    expect(formatTimeDigits("130")).toBe("1:30");
    expect(formatTimeDigits("1234")).toBe("12:34");
    expect(formatTimeDigits("10000")).toBe("1:00:00");
    expect(secondsFromTimeDigits("130")).toBe(90);
    expect(secondsFromTimeDigits("10000")).toBe(3600);
    expect(secondsFromTimeDigits("75")).toBe(75);
    expect(secondsFromTimeDigits("")).toBeNull();
  });

  it("opens a field on its stored value and reads the value back", () => {
    expect(entryText("time", 90)).toBe("130");
    expect(entryText("time", 3600)).toBe("10000");
    expect(entryText("weight", 82.5)).toBe("82.5");
    expect(entryText("reps", null)).toBe("");
    expect(entryValue("time", "130")).toBe(90);
    expect(entryValue("weight", "82.")).toBe(82);
    expect(entryValue("reps", "")).toBeNull();
    expect(columnText("time", 90)).toBe("1:30");
    expect(columnText("distance", 400)).toBe("400");
  });

  it("replaces a field's value with the first key typed, and edits it after", () => {
    expect(typeIntoField("weight", "60", "6", true)).toBe("6");
    expect(typeIntoField("weight", "6", "2", false)).toBe("62");
    expect(typeIntoField("weight", "60", "delete", true)).toBe("6");
    expect(typeIntoField("reps", "8", ".", true)).toBe("");
    expect(typeIntoField("time", "13", "0", false)).toBe("130");
  });
});

describe("finishing a workout", () => {
  it("keeps the done sets and the exercises that have one", () => {
    expect(
      finishPlan([
        {
          id: "squat",
          sets: [
            { id: "s1", done: true },
            { id: "s2", done: false },
          ],
        },
        { id: "curl", sets: [{ id: "c1", done: false }] },
        { id: "plank", sets: [] },
      ]),
    ).toEqual({
      ok: true,
      dropSets: ["s2", "c1"],
      dropExercises: ["curl", "plank"],
      doneSets: 1,
    });
  });

  it("refuses a workout with no set done", () => {
    expect(finishPlan([{ id: "squat", sets: [{ id: "s1", done: false }] }])).toEqual({
      ok: false,
      problem: "Mark at least one set done, or discard the workout.",
    });
    expect(finishPlan([])).toMatchObject({ ok: false });
  });

  it("counts the sets finishing leaves out", () => {
    expect(
      unfinishedSets([{ sets: [{ done: true }, { done: false }] }, { sets: [{ done: false }] }]),
    ).toBe(2);
  });
});

describe("an empty workout's title", () => {
  it("names the part of the day it starts in", () => {
    expect(emptyWorkoutTitle(5)).toBe("Morning workout");
    expect(emptyWorkoutTitle(11)).toBe("Morning workout");
    expect(emptyWorkoutTitle(12)).toBe("Afternoon workout");
    expect(emptyWorkoutTitle(17)).toBe("Evening workout");
    expect(emptyWorkoutTitle(22)).toBe("Night workout");
    expect(emptyWorkoutTitle(2)).toBe("Night workout");
  });
});
