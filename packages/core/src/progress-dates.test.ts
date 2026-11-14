import { describe, expect, it } from "vite-plus/test";

import {
  addWeeks,
  formatDay,
  formatWeek,
  monthLabels,
  parseWeekKey,
  rangeStart,
  startOfWeek,
  weekKey,
} from "./progress-dates.ts";

const local = (...parts: [number, number, number, number?, number?]) =>
  new Date(...(parts as [number, number, number, number, number])).getTime();

describe("weeks", () => {
  it("start at midnight on Monday", () => {
    const monday = local(2026, 0, 5, 0, 0);
    expect(startOfWeek(monday)).toBe(monday);
    expect(startOfWeek(local(2026, 0, 7, 12, 30))).toBe(monday);
    expect(startOfWeek(local(2026, 0, 11, 23, 59))).toBe(monday);
    expect(startOfWeek(local(2026, 0, 12, 0, 0))).toBe(local(2026, 0, 12, 0, 0));
  });

  it("move by calendar weeks, staying at midnight across a clock change", () => {
    const march = startOfWeek(local(2026, 2, 23, 9, 0));
    expect(new Date(addWeeks(march, 1)).getHours()).toBe(0);
    expect(new Date(addWeeks(march, 1)).getDate()).toBe(30);
    expect(addWeeks(local(2026, 0, 5, 0, 0), -1)).toBe(local(2025, 11, 29, 0, 0));
  });

  it("round-trip through their link key", () => {
    const week = local(2026, 9, 26, 0, 0);
    expect(weekKey(week)).toBe("2026-10-26");
    expect(parseWeekKey("2026-10-26")).toBe(week);
    expect(parseWeekKey("2026-10-29")).toBe(week);
  });

  it("refuse a key that is not a real date", () => {
    expect(parseWeekKey("2026-02-30")).toBeNull();
    expect(parseWeekKey("26-10-2026")).toBeNull();
    expect(parseWeekKey("")).toBeNull();
  });

  it("read as their first and last day", () => {
    expect(formatWeek(local(2026, 0, 5))).toBe("5 Jan to 11 Jan 2026");
    expect(formatWeek(local(2025, 11, 29))).toBe("29 Dec 2025 to 4 Jan 2026");
    expect(formatDay(local(2026, 9, 26, 18))).toBe("26 Oct 2026");
  });
});

describe("monthLabels", () => {
  it("names a month at its first point and the year in January", () => {
    expect(
      monthLabels([
        local(2025, 10, 3),
        local(2025, 10, 20),
        local(2025, 11, 1),
        local(2026, 0, 5),
        local(2026, 0, 9),
        local(2026, 1, 2),
      ]),
    ).toEqual(["Nov", "", "Dec", "2026", "", "Feb"]);
  });

  it("shows the year when it changes without a January point", () => {
    expect(monthLabels([local(2025, 11, 30), local(2026, 1, 1)])).toEqual(["Dec", "2026"]);
  });
});

describe("rangeStart", () => {
  it("goes back three months or a year from now, or shows everything", () => {
    const now = local(2026, 10, 13, 10);
    expect(rangeStart("three_months", now)).toBe(local(2026, 7, 13, 10));
    expect(rangeStart("year", now)).toBe(local(2025, 10, 13, 10));
    expect(rangeStart("all", now)).toBeNull();
  });
});
