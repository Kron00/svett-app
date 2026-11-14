import { describe, expect, it } from "vite-plus/test";

import {
  estimatedOneRepMax,
  formatRecordValue,
  formatShownRecordValue,
  type PersonalRecord,
  personalRecords,
  recordValueIn,
  workoutRecords,
} from "./records.ts";
import type { PerformedSet } from "./performed-set.ts";
import { BENCH, DIPS, PLANK, PULLUPS, workoutSets } from "./test-sets.ts";

const first = workoutSets(1, new Date(2026, 0, 5, 18), [
  { exercise: BENCH, type: "warm_up", kg: 50, reps: 10 },
  { exercise: BENCH, kg: 80, reps: 5 },
  { exercise: BENCH, kg: 80, reps: 5 },
  { exercise: BENCH, kg: 85, reps: 3 },
  { exercise: PLANK, seconds: 60 },
]);
const second = workoutSets(2, new Date(2026, 0, 8, 18), [
  { exercise: BENCH, type: "warm_up", kg: 60, reps: 10 },
  { exercise: BENCH, kg: 82.5, reps: 5 },
  { exercise: BENCH, kg: 82.5, reps: 5 },
  { exercise: BENCH, kg: 85, reps: 2 },
  { exercise: PULLUPS, reps: 8 },
  { exercise: PULLUPS, reps: 10 },
]);
const third = workoutSets(3, new Date(2026, 0, 12, 18), [
  { exercise: BENCH, kg: 90, reps: 1 },
  { exercise: BENCH, kg: 70, reps: 15 },
  { exercise: BENCH, type: "failure", kg: 72.5, reps: 12 },
  { exercise: PULLUPS, reps: 10 },
  { exercise: PULLUPS, kg: 10, reps: 12 },
  { exercise: PLANK, seconds: 75 },
]);
const history = [...first, ...second, ...third];

const summary = (records: ReadonlyArray<PersonalRecord>) =>
  records.map(({ kind, setId, value, previous }) => ({ kind, setId, value, previous }));

describe("estimatedOneRepMax", () => {
  it("follows Epley's formula from 1 to 12 reps", () => {
    expect(estimatedOneRepMax(100, 1)).toBe(100);
    expect(estimatedOneRepMax(100, 3)).toBe(110);
    expect(estimatedOneRepMax(100, 10)).toBe(133.33);
    expect(estimatedOneRepMax(100, 12)).toBe(140);
    expect(estimatedOneRepMax(85, 3)).toBe(93.5);
  });

  it("gives no estimate past 12 reps, for no reps or for no weight", () => {
    expect(estimatedOneRepMax(100, 13)).toBeNull();
    expect(estimatedOneRepMax(100, 0)).toBeNull();
    expect(estimatedOneRepMax(0, 5)).toBeNull();
  });
});

describe("personalRecords", () => {
  it("finds the records worked out by hand", () => {
    // Workout 1 sets the starting point: 1RM 93.5 (85 × 3), heaviest 85, set volume 400 (80 × 5), plank 60 s.
    // Workout 2: 82.5 × 5 gives 1RM 96.25 and volume 412.5. 85 × 2 only ties the heaviest weight.
    //   The warm-up 60 × 10 would be 600 kg of volume but warm-ups never count.
    //   Pull-ups start at 10 reps.
    // Workout 3: 90 × 1 is the heaviest at 90. 70 × 15 gives volume 1050 but no 1RM past 12 reps.
    //   The failure set 72.5 × 12 gives 1RM 101.5. Pull-ups tie at 10 reps. The weighted
    //   pull-up has no most-reps value or 1RM and starts the heaviest and volume at 10 and 120.
    //   The plank goes from 60 to 75 seconds.
    const { records } = personalRecords(history);
    expect(summary(records)).toEqual([
      { kind: "best_one_rep_max", setId: second[1]!.setId, value: 96.25, previous: 93.5 },
      { kind: "best_set_volume", setId: second[1]!.setId, value: 412.5, previous: 400 },
      { kind: "best_one_rep_max", setId: third[2]!.setId, value: 101.5, previous: 96.25 },
      { kind: "heaviest_weight", setId: third[0]!.setId, value: 90, previous: 85 },
      { kind: "best_set_volume", setId: third[1]!.setId, value: 1050, previous: 412.5 },
      { kind: "longest_duration", setId: third[5]!.setId, value: 75, previous: 60 },
    ]);
  });

  it("keeps each exercise's best for every kind it has a value for", () => {
    const { bests } = personalRecords(history);
    const of = (exercise: string) =>
      bests
        .filter((best) => best.exerciseId === exercise)
        .map(({ kind, value, setId }) => ({ kind, value, setId }));
    expect(of(BENCH)).toEqual([
      { kind: "best_one_rep_max", value: 101.5, setId: third[2]!.setId },
      { kind: "heaviest_weight", value: 90, setId: third[0]!.setId },
      { kind: "best_set_volume", value: 1050, setId: third[1]!.setId },
    ]);
    expect(of(PULLUPS)).toEqual([
      { kind: "heaviest_weight", value: 10, setId: third[4]!.setId },
      { kind: "best_set_volume", value: 120, setId: third[4]!.setId },
      { kind: "most_reps", value: 10, setId: second[5]!.setId },
    ]);
    expect(of(PLANK)).toEqual([{ kind: "longest_duration", value: 75, setId: third[5]!.setId }]);
  });

  it("finds the same records whatever order the workouts arrive in", () => {
    expect(personalRecords([...third, ...first, ...second])).toEqual(personalRecords(history));
  });

  it("counts a first workout as the starting point, not a record", () => {
    expect(personalRecords(first).records).toEqual([]);
    expect(personalRecords(first).bests).toHaveLength(4);
  });

  it("gives bodyweight exercises no estimated 1RM, only added-weight records", () => {
    // Epley on the added weight alone would rate +10 kg × 12 at 14 kg and +12 kg × 6 at 14.4 kg,
    // a false record, since the body weight both sets also lifted is left out.
    const plus10 = workoutSets(41, new Date(2026, 1, 2, 18), [
      { exercise: PULLUPS, kg: 10, reps: 12 },
    ]);
    const plus12 = workoutSets(42, new Date(2026, 1, 5, 18), [
      { exercise: PULLUPS, kg: 12, reps: 6 },
    ]);
    const { bests, records } = personalRecords([...plus10, ...plus12]);
    expect(summary(records)).toEqual([
      { kind: "heaviest_weight", setId: plus12[0]!.setId, value: 12, previous: 10 },
    ]);
    expect(bests.map(({ kind, value }) => [kind, value])).toEqual([
      ["heaviest_weight", 12],
      ["best_set_volume", 120],
    ]);
  });

  it("gives a set with no reps no weight or 1RM record", () => {
    const five = workoutSets(51, new Date(2026, 2, 2, 18), [{ exercise: BENCH, kg: 100, reps: 5 }]);
    const none = workoutSets(52, new Date(2026, 2, 5, 18), [{ exercise: BENCH, kg: 200, reps: 0 }]);
    expect(personalRecords([...five, ...none]).records).toEqual([]);
  });

  it("gives warm-ups no record or best", () => {
    const warmUps = workoutSets(9, new Date(2026, 0, 1), [
      { exercise: BENCH, type: "warm_up", kg: 200, reps: 5 },
    ]);
    expect(personalRecords(warmUps)).toEqual({ bests: [], records: [] });
  });
});

const badges = (sets: ReadonlyArray<PerformedSet>, workout: ReadonlyArray<PerformedSet>) =>
  Object.fromEntries(workoutRecords(sets, workout[0]!.activityId));

describe("workoutRecords", () => {
  it("badges each set with the records personalRecords finds for its workout", () => {
    expect(badges(history, third)).toEqual({
      [third[0]!.setId]: ["heaviest_weight"],
      [third[1]!.setId]: ["best_set_volume"],
      [third[2]!.setId]: ["best_one_rep_max"],
      [third[5]!.setId]: ["longest_duration"],
    });
    expect(badges(history, second)).toEqual({
      [second[1]!.setId]: ["best_one_rep_max", "best_set_volume"],
    });
    expect(badges(history, first)).toEqual({});
  });

  it("gives a weighted bodyweight set no estimated 1RM badge", () => {
    const plus10 = workoutSets(61, new Date(2026, 3, 2, 18), [
      { exercise: DIPS, kg: 10, reps: 12 },
    ]);
    const plus12 = workoutSets(62, new Date(2026, 3, 5, 18), [{ exercise: DIPS, kg: 12, reps: 6 }]);
    expect(badges([...plus10, ...plus12], plus12)).toEqual({
      [plus12[0]!.setId]: ["heaviest_weight"],
    });
  });

  it("gives no 1RM badge to a set past 12 reps", () => {
    const five = workoutSets(71, new Date(2026, 4, 2, 18), [{ exercise: BENCH, kg: 100, reps: 5 }]);
    const fifteen = workoutSets(72, new Date(2026, 4, 5, 18), [
      { exercise: BENCH, kg: 100, reps: 15 },
    ]);
    expect(badges([...five, ...fifteen], fifteen)).toEqual({
      [fifteen[0]!.setId]: ["best_set_volume"],
    });
  });

  it("gives a set with no reps no badge", () => {
    const five = workoutSets(81, new Date(2026, 5, 2, 18), [{ exercise: BENCH, kg: 100, reps: 5 }]);
    const none = workoutSets(82, new Date(2026, 5, 5, 18), [{ exercise: BENCH, kg: 200, reps: 0 }]);
    expect(badges([...five, ...none], none)).toEqual({});
  });
});

describe("formatRecordValue", () => {
  it("writes each unit as the app shows it", () => {
    expect(formatRecordValue("kg", 101.5, "kg")).toBe("101.5 kg");
    expect(formatRecordValue("reps", 1, "kg")).toBe("1 rep");
    expect(formatRecordValue("reps", 12, "kg")).toBe("12 reps");
    expect(formatRecordValue("duration", 75, "kg")).toBe("1:15");
    expect(formatRecordValue("metres", 400, "kg")).toBe("400 m");
    expect(formatRecordValue("metres", 1500, "kg")).toBe("1.5 km");
  });

  it("writes a weight in pounds when weights show in pounds, and leaves the other units alone", () => {
    expect(formatRecordValue("kg", 101.5, "lb")).toBe("223.77 lb");
    expect(formatRecordValue("kg", 100, "lb")).toBe("220.46 lb");
    expect(formatRecordValue("reps", 12, "lb")).toBe("12 reps");
    expect(formatRecordValue("duration", 75, "lb")).toBe("1:15");
    expect(formatRecordValue("metres", 1500, "lb")).toBe("1.5 km");
  });
});

describe("formatShownRecordValue", () => {
  it("writes a value already in pounds without converting it again", () => {
    expect(formatShownRecordValue("kg", recordValueIn("kg", 100, "lb"), "lb")).toBe("220.46 lb");
    expect(formatShownRecordValue("kg", 200, "lb")).toBe("200 lb");
    expect(recordValueIn("reps", 12, "lb")).toBe(12);
  });
});
