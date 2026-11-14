import { isWorkingSet, groupByWorkout, type PerformedSet } from "./performed-set.ts";
import { RECORD_RULES, type RecordKind, type RecordUnit, recordValueIn } from "./records.ts";
import type { SeriesPoint } from "./series.ts";
import type { WeightUnit } from "./weight-unit.ts";

export const EXERCISE_METRICS = [
  "best_one_rep_max",
  "heaviest_weight",
  "session_volume",
  "most_reps",
  "total_reps",
  "longest_duration",
  "longest_distance",
] as const;
export type ExerciseMetric = (typeof EXERCISE_METRICS)[number];

export interface ExerciseMetricRule {
  readonly label: string;
  readonly unit: RecordUnit;
  readonly rule: string;
  /** The workout's value from its working sets, or null when none of them has one. */
  readonly summarize: (sets: ReadonlyArray<PerformedSet>) => number | null;
}

const valuesOf = (kind: RecordKind, sets: ReadonlyArray<PerformedSet>) =>
  sets.flatMap((set) => {
    const value = RECORD_RULES[kind].valueOf(set);
    return value === null ? [] : [value];
  });

const best = (kind: RecordKind) => (sets: ReadonlyArray<PerformedSet>) => {
  const values = valuesOf(kind, sets);
  return values.length === 0 ? null : Math.max(...values);
};

const total = (kind: RecordKind) => (sets: ReadonlyArray<PerformedSet>) => {
  const values = valuesOf(kind, sets);
  return values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
};

const fromRecord = (kind: RecordKind, rule = RECORD_RULES[kind].rule): ExerciseMetricRule => ({
  label: RECORD_RULES[kind].label,
  unit: RECORD_RULES[kind].unit,
  rule: `The workout's best set. ${rule}`,
  summarize: best(kind),
});

export const EXERCISE_METRIC_RULES: Readonly<Record<ExerciseMetric, ExerciseMetricRule>> = {
  best_one_rep_max: fromRecord("best_one_rep_max"),
  heaviest_weight: fromRecord("heaviest_weight"),
  session_volume: {
    label: "Volume",
    unit: "kg",
    rule: "Weight × reps, added up over the workout's sets. On a bodyweight exercise it counts only the added weight.",
    summarize: total("best_set_volume"),
  },
  most_reps: fromRecord("most_reps"),
  total_reps: {
    label: "Total reps",
    unit: "reps",
    rule: "Reps added up over the workout's sets with no added weight.",
    summarize: total("most_reps"),
  },
  longest_duration: fromRecord("longest_duration"),
  longest_distance: fromRecord("longest_distance"),
};

/** The rule every exercise chart follows, shown under the charts. */
export const EXERCISE_CHART_RULE = "Each point is one workout. Warm-up sets never count.";

/**
 * One exercise's workouts as points for `metric`, oldest first, from `from` on.
 * A workout with no working set that has a value for the metric is left out.
 */
export const exerciseSeries = (
  sets: ReadonlyArray<PerformedSet>,
  metric: ExerciseMetric,
  from: number | null = null,
): ReadonlyArray<SeriesPoint> =>
  groupByWorkout([...sets].sort((a, b) => a.startedAt - b.startedAt)).flatMap((workout) => {
    const first = workout[0];
    if (first === undefined || (from !== null && first.startedAt < from)) return [];
    const value = EXERCISE_METRIC_RULES[metric].summarize(workout.filter(isWorkingSet));
    return value === null ? [] : [{ key: first.activityId, at: first.startedAt, value }];
  });

/**
 * Points in the unit the app shows, so a chart's line, ticks and summary read in pounds when
 * weights do. Kilogram values become `weightUnit`, other units stay as they are.
 */
export const seriesIn = (
  points: ReadonlyArray<SeriesPoint>,
  unit: RecordUnit,
  weightUnit: WeightUnit,
): ReadonlyArray<SeriesPoint> =>
  points.map((point) => ({ ...point, value: recordValueIn(unit, point.value, weightUnit) }));

/** The metrics an exercise's history has values for, in EXERCISE_METRICS order. */
export const exerciseMetrics = (
  sets: ReadonlyArray<PerformedSet>,
): ReadonlyArray<ExerciseMetric> => {
  const working = sets.filter(isWorkingSet);
  return EXERCISE_METRICS.filter(
    (metric) => EXERCISE_METRIC_RULES[metric].summarize(working) !== null,
  );
};
