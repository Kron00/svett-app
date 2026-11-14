import { formatDay, monthLabels } from "./progress-dates.ts";

/** One value at one time, such as a workout's best set or a weigh-in. */
export interface SeriesPoint {
  /** Unique within the series, such as the workout's or the measurement's ID. */
  readonly key: string;
  readonly at: number;
  readonly value: number;
}

/** What a chart draws for a point: its key, its time, its x-axis label and its value. */
export interface LabelledPoint extends SeriesPoint {
  readonly label: string;
}

/** Points in time order with month labels for the x axis. */
export const labelByMonth = (points: ReadonlyArray<SeriesPoint>): ReadonlyArray<LabelledPoint> => {
  const labels = monthLabels(points.map((point) => point.at));
  return points.map((point, index) => ({ ...point, label: labels[index] ?? "" }));
};

export interface SeriesSummary {
  readonly latest: number;
  readonly best: number;
  readonly lowest: number;
}

/** The latest, highest and lowest values, or null for an empty series. */
export const summarizeSeries = (points: ReadonlyArray<SeriesPoint>): SeriesSummary | null => {
  const last = points[points.length - 1];
  if (last === undefined) return null;
  const values = points.map((point) => point.value);
  return { latest: last.value, best: Math.max(...values), lowest: Math.min(...values) };
};

/**
 * What VoiceOver reads for a chart: what it shows, over which days, and where
 * it starts, ends and peaks.
 */
export const describeSeries = (
  title: string,
  points: ReadonlyArray<SeriesPoint>,
  format: (value: number) => string,
): string => {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return `${title}, no data`;
  if (points.length === 1) return `${title}, ${format(first.value)} on ${formatDay(first.at)}`;
  const best = Math.max(...points.map((point) => point.value));
  return `${title}, ${points.length} points from ${formatDay(first.at)} to ${formatDay(last.at)}, from ${format(first.value)} to ${format(last.value)}, highest ${format(best)}`;
};
