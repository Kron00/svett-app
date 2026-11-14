import { describe, expect, it } from "vite-plus/test";

import { formatClimbM, formatKm, formatPace, paceMeasure } from "./cardio-format.ts";

describe("formatKm", () => {
  it("shows kilometres to two decimals, never rounding up to the next", () => {
    expect(formatKm(5020)).toBe("5.02");
    expect(formatKm(4996)).toBe("4.99");
    expect(formatKm(0)).toBe("0.00");
    expect(formatKm(42_195)).toBe("42.19");
  });
});

describe("formatPace", () => {
  it("shows a run's minutes and seconds per kilometre", () => {
    expect(formatPace("run", 5000, 1500)).toBe("5:00");
    expect(formatPace("walk", 1000, 754.4)).toBe("12:34");
    expect(formatPace("hike", 2000, 7_500)).toBe("1:02:30");
  });

  it("shows a ride's speed in km/h", () => {
    expect(formatPace("ride", 10_000, 1200)).toBe("30.0");
  });

  it("shows a dash before there is enough to say", () => {
    expect(formatPace("run", 5, 10)).toBe("–");
    expect(formatPace("ride", 1000, 0)).toBe("–");
  });
});

describe("paceMeasure", () => {
  it("measures rides by speed and the rest by pace", () => {
    expect(paceMeasure("ride")).toEqual({ label: "Speed", unit: "km/h" });
    expect(paceMeasure("run")).toEqual({ label: "Pace", unit: "/km" });
  });
});

describe("formatClimbM", () => {
  it("rounds to the metre and shows a dash when the altitude is unknown", () => {
    expect(formatClimbM(41.6)).toBe("42");
    expect(formatClimbM(null)).toBe("–");
  });
});
