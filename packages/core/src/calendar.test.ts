import { describe, expect, it } from "vite-plus/test";

import {
  calendarWeeks,
  monthKey,
  monthOf,
  parseMonthKey,
  shiftMonth,
  UTC,
  type UtcOffset,
  weekStreak,
} from "./calendar.ts";

const at = (iso: string) => Date.parse(iso);
// Friday 13 November 2026, in the week from Monday 9 to Sunday 15 November.
const NOW = at("2026-11-13T12:00:00Z");
const CET: UtcOffset = () => 60;

describe("weekStreak", () => {
  it("counts weeks in a row up to last week while this week is still open", () => {
    const workouts = [
      at("2026-10-20T18:00:00Z"),
      at("2026-10-28T18:00:00Z"),
      at("2026-11-03T18:00:00Z"),
    ];
    expect(weekStreak(workouts, NOW, UTC)).toEqual({ current: 3, longest: 3 });
  });

  it("adds this week once it has a workout", () => {
    const workouts = [at("2026-10-28T18:00:00Z"), at("2026-11-03T18:00:00Z")];
    expect(weekStreak([...workouts, at("2026-11-10T07:00:00Z")], NOW, UTC).current).toBe(3);
  });

  it("counts several workouts in one week once", () => {
    const workouts = [
      at("2026-11-02T07:00:00Z"),
      at("2026-11-04T07:00:00Z"),
      at("2026-11-08T07:00:00Z"),
    ];
    expect(weekStreak(workouts, NOW, UTC)).toEqual({ current: 1, longest: 1 });
  });

  it("breaks on a week with no workout", () => {
    const workouts = [at("2026-10-20T18:00:00Z"), at("2026-11-03T18:00:00Z")];
    expect(weekStreak(workouts, NOW, UTC)).toEqual({ current: 1, longest: 1 });
  });

  it("is zero when the last workout was two weeks ago, and keeps the longest", () => {
    const workouts = [
      at("2026-09-01T18:00:00Z"),
      at("2026-09-08T18:00:00Z"),
      at("2026-09-15T18:00:00Z"),
      at("2026-10-27T18:00:00Z"),
    ];
    expect(weekStreak(workouts, NOW, UTC)).toEqual({ current: 0, longest: 3 });
  });

  it("puts a workout in the week of its local day", () => {
    // Sunday 1 November 23:30 in UTC, two weeks back, is Monday 2 November one hour east, last week.
    const workouts = [at("2026-11-01T23:30:00Z")];
    expect(weekStreak(workouts, NOW, UTC)).toEqual({ current: 0, longest: 1 });
    expect(weekStreak(workouts, NOW, CET)).toEqual({ current: 1, longest: 1 });
  });

  it("is zero with no workouts", () => {
    expect(weekStreak([], NOW, UTC)).toEqual({ current: 0, longest: 0 });
  });
});

const days = (weeks: ReturnType<typeof calendarWeeks>) =>
  weeks.map((week) => week.map((cell) => cell?.day ?? null));

describe("calendarWeeks", () => {
  it("lays November 2026 out from Monday, with Sunday the 1st at the end of the first week", () => {
    const weeks = calendarWeeks({ year: 2026, month: 11 }, [], UTC);
    expect(days(weeks)).toEqual([
      [null, null, null, null, null, null, 1],
      [2, 3, 4, 5, 6, 7, 8],
      [9, 10, 11, 12, 13, 14, 15],
      [16, 17, 18, 19, 20, 21, 22],
      [23, 24, 25, 26, 27, 28, 29],
      [30, null, null, null, null, null, null],
    ]);
  });

  it("fits February 2027, which starts on a Monday, in four weeks", () => {
    const weeks = calendarWeeks({ year: 2027, month: 2 }, [], UTC);
    expect(weeks).toHaveLength(4);
    expect(days(weeks)[3]).toEqual([22, 23, 24, 25, 26, 27, 28]);
  });

  it("puts each workout on its local day and leaves out other months", () => {
    const push = { id: "push", startedAt: at("2026-11-03T18:00:00Z") };
    const legs = { id: "legs", startedAt: at("2026-11-03T20:00:00Z") };
    const late = { id: "late", startedAt: at("2026-11-30T23:30:00Z") };
    const october = { id: "october", startedAt: at("2026-10-31T12:00:00Z") };
    const workouts = [push, legs, late, october];
    const inUtc = calendarWeeks({ year: 2026, month: 11 }, workouts, UTC).flat();
    expect(inUtc.find((cell) => cell?.day === 3)?.workouts).toEqual([push, legs]);
    expect(inUtc.find((cell) => cell?.day === 30)?.workouts).toEqual([late]);
    expect(inUtc.flatMap((cell) => cell?.workouts ?? [])).toHaveLength(3);
    // One hour east, the late workout falls on 1 December.
    const inCet = calendarWeeks({ year: 2026, month: 11 }, workouts, CET).flat();
    expect(inCet.find((cell) => cell?.day === 30)?.workouts).toEqual([]);
  });
});

describe("months", () => {
  it("finds the local month of an instant", () => {
    expect(monthOf(at("2026-10-31T23:30:00Z"), UTC)).toEqual({ year: 2026, month: 10 });
    expect(monthOf(at("2026-10-31T23:30:00Z"), CET)).toEqual({ year: 2026, month: 11 });
  });

  it("moves across years", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 5 }, -17)).toEqual({ year: 2024, month: 12 });
  });

  it("reads and writes month keys", () => {
    expect(monthKey({ year: 2026, month: 3 })).toBe("2026-03");
    expect(parseMonthKey("2026-03")).toEqual({ year: 2026, month: 3 });
    expect(parseMonthKey("2026-13")).toBeNull();
    expect(parseMonthKey("March")).toBeNull();
  });
});
