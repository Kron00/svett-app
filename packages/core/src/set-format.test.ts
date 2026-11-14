import { describe, expect, it } from "vite-plus/test";

import { formatSetLoad, formatWeightKg, setBadge } from "./set-format.ts";

describe("formatWeightKg", () => {
  it.each([
    [100, "100"],
    [82.5, "82.5"],
    [82.555, "82.56"],
    [0.1 + 0.2, "0.3"],
    [0, "0"],
  ])("formats %d kg as %s", (kg, expected) => {
    expect(formatWeightKg(kg)).toBe(expected);
  });
});

describe("formatSetLoad", () => {
  it("shows weight and reps together", () => {
    expect(formatSetLoad(80, 8)).toBe("80 kg × 8");
  });

  it("shows weight alone for a set without reps", () => {
    expect(formatSetLoad(22.5, null)).toBe("22.5 kg");
  });

  it("shows reps alone for a bodyweight set", () => {
    expect(formatSetLoad(null, 12)).toBe("12 reps");
    expect(formatSetLoad(null, 1)).toBe("1 rep");
  });

  it("is null for a set with neither", () => {
    expect(formatSetLoad(null, null)).toBeNull();
  });
});

describe("setBadge", () => {
  it("numbers a normal set", () => {
    expect(setBadge("normal", 3)).toEqual({ text: "3", label: "Set 3" });
  });

  it.each([
    ["warm_up", "W", "Warm-up set"],
    ["failure", "F", "Failure set"],
    ["drop", "D", "Drop set"],
  ] as const)("gives a %s set a letter", (type, text, label) => {
    expect(setBadge(type, 2)).toEqual({ text, label });
  });
});
