import {
  CHART_RANGE_LABEL,
  CHART_RANGES,
  type ChartRange,
  EXERCISE_CHART_RULE,
  EXERCISE_METRIC_RULES,
  ExerciseId,
  exerciseMetrics,
  exerciseSeries,
  formatDay,
  formatRecordValue,
  isChartRange,
  personalRecords,
  RECORD_RULES,
  RECORDS_RULE,
  rangeStart,
  summarizeSeries,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { Option, Schema } from "effect";
import { useLayoutEffect, useMemo } from "react";
import { ScrollView, View } from "react-native";

import { useQuery } from "../data/useQuery";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { SegmentedControl } from "../ui/SegmentedControl";
import { ChartCard } from "./ChartCard";
import { exerciseHistory } from "./queries";
import { QueryView } from "./QueryView";

const RANGE_OPTIONS = CHART_RANGES.map((value) => ({ value, label: CHART_RANGE_LABEL[value] }));
const parseExerciseId = Schema.decodeUnknownOption(ExerciseId);

/** One exercise's charts over a chosen range, and its personal records. */
export function ExerciseProgressScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { params } = useRoute<RouteProp<RootStackParamList, "ExerciseProgress">>();
  const range: ChartRange = isChartRange(params.range) ? params.range : "year";
  const query = useMemo(() => {
    const exerciseId = parseExerciseId(params.exerciseId);
    return Option.isSome(exerciseId) ? exerciseHistory(exerciseId.value) : null;
  }, [params.exerciseId]);
  return query === null ? (
    <EmptyState
      symbol="questionmark"
      title="No such exercise"
      message="The link names no exercise."
    />
  ) : (
    <ExerciseProgress
      query={query}
      range={range}
      onRange={(next) => navigation.setParams({ range: next })}
    />
  );
}

function ExerciseProgress({
  query,
  range,
  onRange,
}: {
  readonly query: ReturnType<typeof exerciseHistory>;
  readonly range: ChartRange;
  readonly onRange: (range: ChartRange) => void;
}) {
  const navigation = useNavigation<RootNavigation>();
  const { state } = useQuery(query);
  const title =
    state.status === "ready" ? Option.getOrUndefined(state.value.exercise)?.name : undefined;
  useLayoutEffect(() => {
    if (title !== undefined) navigation.setOptions({ title });
  }, [navigation, title]);

  return (
    <QueryView state={state}>
      {({ exercise, sets, now }) => {
        if (Option.isNone(exercise)) {
          return (
            <EmptyState
              symbol="questionmark"
              title="No such exercise"
              message="This exercise was deleted or never existed."
            />
          );
        }
        const from = rangeStart(range, now);
        const bests = personalRecords(sets).bests;
        return (
          <ScrollView
            testID="exercise-progress"
            contentInsetAdjustmentBehavior="automatic"
            className="flex-1 bg-background"
            contentContainerStyle={{ gap: 16, paddingVertical: 16 }}
          >
            <View className="px-gutter">
              <SegmentedControl
                accessibilityLabel="Chart range"
                options={RANGE_OPTIONS}
                selected={range}
                onSelect={onRange}
              />
            </View>
            {sets.length === 0 ? (
              <EmptyState
                symbol="chart.xyaxis.line"
                title="Not logged yet"
                message="Charts show here once a finished workout has this exercise."
              />
            ) : null}
            {exerciseMetrics(sets).map((metric) => {
              const rule = EXERCISE_METRIC_RULES[metric];
              const points = exerciseSeries(sets, metric, from);
              const summary = summarizeSeries(points);
              const format = (value: number) => formatRecordValue(rule.unit, value);
              return (
                <ChartCard
                  key={metric}
                  testID={`chart-${metric}`}
                  title={rule.label}
                  value={summary === null ? null : format(summary.latest)}
                  detail={
                    summary === null
                      ? undefined
                      : `Latest workout. Best in this range ${format(summary.best)}.`
                  }
                  rule={rule.rule}
                  points={points}
                  format={format}
                />
              );
            })}
            {bests.length > 0 ? (
              <ListSection header="Personal records" footer={RECORDS_RULE}>
                {bests.map((best) => (
                  <ListRow
                    key={best.kind}
                    title={RECORD_RULES[best.kind].label}
                    subtitle={`${formatDay(best.achievedAt)}. ${RECORD_RULES[best.kind].rule}`}
                    value={formatRecordValue(RECORD_RULES[best.kind].unit, best.value)}
                  />
                ))}
              </ListSection>
            ) : null}
            <AppText
              testID="exercise-progress-end"
              variant="footnote"
              tone="secondary"
              className="px-8"
            >
              {EXERCISE_CHART_RULE}
            </AppText>
          </ScrollView>
        );
      }}
    </QueryView>
  );
}
