import { describe, expect, it } from "vite-plus/test";

import { exerciseMetrics, exerciseSeries, seriesIn } from "./exercise-progress.ts";
import { niceTicks } from "./chart-scale.ts";
import { describeSeries, labelByMonth, summarizeSeries } from "./series.ts";
import { BENCH, PLANK, PULLUPS, workoutSets } from "./test-sets.ts";

const first = workoutSets(21, new Date(2026, 0, 5, 18), [
  { exercise: BENCH, type: "warm_up", kg: 50, reps: 10 },
  { exercise: BENCH, kg: 80, reps: 5 },
  { exercise: BENCH, kg: 80, reps: 5 },
  { exercise: BENCH, kg: 85, reps: 3 },
]);
const second = workoutSets(22, new Date(2026, 0, 8, 18), [
  { exercise: BENCH, type: "warm_up", kg: 60, reps: 10 },
  { exercise: BENCH, kg: 82.5, reps: 5 },
  { exercise: BENCH, kg: 82.5, reps: 5 },
  { exercise: BENCH, kg: 85, reps: 2 },
  { exercise: PULLUPS, reps: 8 },
  { exercise: PULLUPS, reps: 10 },
]);
const third = workoutSets(23, new Date(2026, 1, 2, 18), [
  { exercise: BENCH, kg: 90, reps: 1 },
  { exercise: BENCH, kg: 70, reps: 15 },
  { exercise: BENCH, type: "failure", kg: 72.5, reps: 12 },
  { exercise: PULLUPS, reps: 10 },
  { exercise: PULLUPS, kg: 10, reps: 12 },
]);
const bench = [...first, ...second, ...third].filter((set) => set.exerciseId === BENCH);
const pullups = [...second, ...third].filter((set) => set.exerciseId === PULLUPS);
const values = (points: ReadonlyArray<{ readonly value: number }>) => points.map((p) => p.value);

describe("exerciseSeries", () => {
  it("gives each workout's best estimated 1RM and heaviest weight", () => {
    expect(values(exerciseSeries(bench, "best_one_rep_max"))).toEqual([93.5, 96.25, 101.5]);
    expect(values(exerciseSeries(bench, "heaviest_weight"))).toEqual([85, 85, 90]);
  });

  it("adds up each workout's volume without its warm-ups", () => {
    // 400 + 400 + 255, then 412.5 + 412.5 + 170, then 90 + 1050 + 870.
    expect(values(exerciseSeries(bench, "session_volume"))).toEqual([1055, 995, 2010]);
  });

  it("counts reps without added weight", () => {
    expect(values(exerciseSeries(pullups, "total_reps"))).toEqual([18, 10]);
    expect(values(exerciseSeries(pullups, "most_reps"))).toEqual([10, 10]);
  });

  it("keys points by workout and leaves out workouts before the range", () => {
    const points = exerciseSeries(bench, "heaviest_weight", new Date(2026, 0, 6).getTime());
    expect(points.map((point) => point.key)).toEqual([second[0]!.activityId, third[0]!.activityId]);
  });
});

describe("exerciseMetrics", () => {
  it("offers only the metrics the exercise's sets have values for", () => {
    expect(exerciseMetrics(bench)).toEqual([
      "best_one_rep_max",
      "heaviest_weight",
      "session_volume",
    ]);
    expect(exerciseMetrics(pullups)).toEqual([
      "heaviest_weight",
      "session_volume",
      "most_reps",
      "total_reps",
    ]);
    const plank = workoutSets(24, new Date(2026, 0, 5), [{ exercise: PLANK, seconds: 60 }]);
    expect(exerciseMetrics(plank)).toEqual(["longest_duration"]);
  });
});

describe("series helpers", () => {
  const points = exerciseSeries(bench, "best_one_rep_max");

  it("label the first point and each new month, keeping each point's time", () => {
    expect(labelByMonth(points).map(({ label, at }) => [label, at])).toEqual([
      ["2026", first[0]!.startedAt],
      ["", second[0]!.startedAt],
      ["Feb", third[0]!.startedAt],
    ]);
  });

  it("summarise the latest, best and lowest values", () => {
    expect(summarizeSeries(points)).toEqual({ latest: 101.5, best: 101.5, lowest: 93.5 });
    expect(summarizeSeries([])).toBeNull();
  });

  it("describe the chart for VoiceOver", () => {
    expect(describeSeries("Estimated 1RM", points, (value) => `${value} kg`)).toBe(
      "Estimated 1RM, 3 points from 5 Jan 2026 to 2 Feb 2026, from 93.5 kg to 101.5 kg, highest 101.5 kg",
    );
    expect(describeSeries("Estimated 1RM", [], String)).toBe("Estimated 1RM, no data");
  });
});

describe("seriesIn", () => {
  it("charts weights in pounds when weights show in pounds, so the ticks land on round pounds", () => {
    const points = seriesIn(exerciseSeries(bench, "heaviest_weight"), "kg", "lb");
    expect(values(points).map((value) => Math.round(value * 100) / 100)).toEqual([
      187.39, 187.39, 198.42,
    ]);
    const ticks = niceTicks(values(points), 4);
    expect(ticks.values.every((tick) => Number.isInteger(tick))).toBe(true);
    expect(ticks.min).toBeLessThanOrEqual(187.39);
    expect(ticks.max).toBeGreaterThanOrEqual(198.42);
  });

  it("leaves kilograms and every other unit as they are", () => {
    expect(values(seriesIn(exerciseSeries(bench, "heaviest_weight"), "kg", "kg"))).toEqual([
      85, 85, 90,
    ]);
    expect(values(seriesIn(exerciseSeries(pullups, "total_reps"), "reps", "lb"))).toEqual([18, 10]);
  });
});
