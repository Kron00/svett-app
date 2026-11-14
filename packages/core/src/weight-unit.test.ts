import { describe, expect, it } from "vite-plus/test";

import { entryText, entryValue, placeholderFor, setValuesText, typeIntoField } from "./logger.ts";
import { setTargetText } from "./routine-plan.ts";
import { formatSetLoad } from "./set-format.ts";
import {
  formatWeight,
  formatWeightWithUnit,
  kgFrom,
  kgFromText,
  KG_PER_LB,
  weightIn,
} from "./weight-unit.ts";

describe("kilograms and pounds", () => {
  it("converts with the exact international pound", () => {
    expect(KG_PER_LB).toBe(0.45359237);
    expect(kgFrom(100, "lb")).toBeCloseTo(45.359237, 9);
    expect(weightIn(45.359237, "lb")).toBeCloseTo(100, 9);
    expect(kgFrom(100, "kg")).toBe(100);
    expect(weightIn(100, "kg")).toBe(100);
  });

  it("shows a stored weight rounded to two decimals in the unit", () => {
    expect(formatWeight(100, "kg")).toBe("100");
    expect(formatWeight(82.5, "kg")).toBe("82.5");
    expect(formatWeight(100, "lb")).toBe("220.46");
    expect(formatWeight(20, "lb")).toBe("44.09");
    expect(formatWeightWithUnit(kgFrom(225, "lb"), "lb")).toBe("225 lb");
  });

  it("reads back every weight typed in pounds as typed, to two decimals", () => {
    for (let hundredths = 0; hundredths <= 100_000; hundredths += 7) {
      const typed = hundredths / 100;
      expect(formatWeight(kgFrom(typed, "lb"), "lb")).toBe(String(typed));
    }
  });

  it("keeps the stored weight when the text still reads as it", () => {
    const stored = 100;
    expect(kgFromText("220.46", stored, "lb")).toBe(100);
    expect(kgFromText("220.5", stored, "lb")).toBeCloseTo(100.0171, 4);
    expect(kgFromText("225", null, "lb")).toBe(225 * KG_PER_LB);
    expect(kgFromText("", stored, "lb")).toBeNull();
    expect(kgFromText("60", 60, "kg")).toBe(60);
  });

  it("types a weight in pounds into the logger and stores kilograms", () => {
    let text = "";
    for (const key of ["2", "2", "5"] as const)
      text = typeIntoField("weight", text, key, false, "lb");
    expect(text).toBe("225");
    expect(entryValue("weight", text, "lb")).toBe(225 * KG_PER_LB);
    expect(entryText("weight", 225 * KG_PER_LB, "lb")).toBe("225");
  });

  it("keeps a weight typed in kilograms when the logger reopens it in pounds and it is saved again", () => {
    const stored = 102.5;
    const shown = entryText("weight", stored, "lb");
    expect(shown).toBe("225.97");
    expect(entryValue("weight", shown, "lb", stored)).toBe(stored);
  });

  it("shows sets, last time's values and targets in the unit", () => {
    const set = { weightKg: 225 * KG_PER_LB, reps: 5, durationS: null, distanceM: null };
    expect(setValuesText(set, "weight_reps", "lb")).toEqual({
      text: "225 lb × 5",
      label: "225 lb, 5 reps",
    });
    expect(setValuesText(set, "weight_reps")).toEqual({
      text: "102.06 kg × 5",
      label: "102.06 kg, 5 reps",
    });
    expect(
      placeholderFor({ targetRepsMin: null, targetRepsMax: null }, "weight", set, "lb")?.text,
    ).toBe("225");
    expect(formatSetLoad(set.weightKg, 5, "lb")).toBe("225 lb × 5");
    expect(
      setTargetText(
        { weightKg: 60, repsMin: 8, repsMax: 12, durationS: null, distanceM: null },
        "lb",
      ).text,
    ).toBe("132.28 lb × 8-12 reps");
  });
});
