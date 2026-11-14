import { describe, expect, it } from "vite-plus/test";

import {
  editNumberEntry,
  type KeypadKey,
  maxEntryValue,
  type NumberEntryLimits,
  REPS_ENTRY as reps,
  stepValue,
  WEIGHT_KG_ENTRY as weight,
} from "./number-entry.ts";

const press = (keys: ReadonlyArray<KeypadKey>, limits: NumberEntryLimits, start = ""): string =>
  keys.reduce((value, key) => editNumberEntry(value, key, limits), start);

describe("editNumberEntry", () => {
  it("types a weight with a decimal", () => {
    expect(press(["8", "2", ".", "5"], weight)).toBe("82.5");
  });

  it("starts a bare decimal point with a zero", () => {
    expect(press([".", "5"], weight)).toBe("0.5");
  });

  it("replaces a lone zero instead of keeping a leading zero", () => {
    expect(press(["0", "7"], weight)).toBe("7");
  });

  it("ignores a second decimal point", () => {
    expect(press(["2", ".", "5", "."], weight)).toBe("2.5");
  });

  it("stops at the allowed decimals", () => {
    expect(press(["1", ".", "2", "5", "5"], weight)).toBe("1.25");
  });

  it("stops at the allowed integer digits", () => {
    expect(press(["1", "2", "3", "4", "5"], weight)).toBe("1234");
    expect(press(["1", "2", "3", "4"], reps)).toBe("123");
  });

  it("has no decimal point for reps", () => {
    expect(press(["8", ".", "5"], reps)).toBe("85");
  });

  it("deletes the last character, and does nothing on an empty field", () => {
    expect(press(["delete"], weight, "82.5")).toBe("82.");
    expect(press(["delete"], weight, "")).toBe("");
  });
});

describe("stepValue", () => {
  it("steps a weight by 2.5 kg and reps by one", () => {
    expect(stepValue(80, 1, weight)).toBe(82.5);
    expect(stepValue(8, -1, reps)).toBe(7);
  });

  it("steps without float drift", () => {
    expect(stepValue(0.1, 1, { decimals: 1, maxIntegerDigits: 2, step: 0.2 })).toBe(0.3);
  });

  it("stops at zero and at the largest value the keypad can type", () => {
    expect(stepValue(1, -1, weight)).toBe(0);
    expect(stepValue(9999, 1, weight)).toBe(9999.99);
    expect(stepValue(999, 1, reps)).toBe(999);
  });
});

describe("maxEntryValue", () => {
  it("is the largest number the limits allow", () => {
    expect(maxEntryValue(weight)).toBe(9999.99);
    expect(maxEntryValue(reps)).toBe(999);
  });
});
