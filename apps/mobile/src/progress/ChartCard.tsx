import { describeSeries, labelByMonth, type SeriesPoint } from "@svett/core";
import { View } from "react-native";

import type { ColorToken } from "../design/tokens";
import { AppText } from "../ui/AppText";
import { Chart, ChartBars, ChartGrid, ChartLine } from "../ui/Chart";

/**
 * One chart on its card: what it shows, its headline value, the rule behind
 * the number, and the chart itself, or a line saying the range is empty.
 */
export function ChartCard({
  title,
  value,
  detail,
  rule,
  points,
  format,
  mark = "line",
  color,
  labels,
  testID,
}: {
  readonly title: string;
  readonly value: string | null;
  readonly detail?: string;
  readonly rule: string;
  readonly points: ReadonlyArray<SeriesPoint>;
  readonly format: (value: number) => string;
  readonly mark?: "line" | "bars";
  readonly color?: ColorToken;
  /** X-axis labels by point. Month labels when left out. */
  readonly labels?: ReadonlyArray<string>;
  readonly testID?: string;
}) {
  const monthly = labelByMonth(points);
  const chartPoints = labels
    ? monthly.map((point, index) => ({ ...point, label: labels[index] ?? "" }))
    : monthly;
  return (
    <View testID={testID} className="mx-gutter gap-3 rounded-card bg-surface p-4">
      <View className="gap-1">
        <AppText variant="subheadline" tone="secondary" accessibilityRole="header">
          {title}
        </AppText>
        {value === null ? null : (
          <AppText variant="title2" numeric>
            {value}
          </AppText>
        )}
        {detail ? (
          <AppText variant="footnote" tone="secondary">
            {detail}
          </AppText>
        ) : null}
      </View>
      {points.length === 0 ? (
        <AppText tone="secondary">Nothing logged in this range.</AppText>
      ) : (
        <Chart
          points={chartPoints}
          includeZero={mark === "bars"}
          formatValue={(tick) => String(tick)}
          accessibilityLabel={describeSeries(title, points, format)}
        >
          <ChartGrid />
          {mark === "bars" ? <ChartBars color={color} /> : <ChartLine color={color} />}
        </Chart>
      )}
      <AppText variant="footnote" tone="secondary">
        {rule}
      </AppText>
    </View>
  );
}
