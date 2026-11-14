import {
  monthTicks,
  niceTicks,
  placeAxisLabels,
  placeMonthLabels,
  type PlacedLabel,
  scaleLinear,
  type Ticks,
  timeScale,
} from "@svett/core";
import { createContext, type ReactNode, use, useMemo, useState } from "react";
import { View } from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

import { useColor, useIsAccessibilityTextSize } from "../design/hooks";
import type { ColorToken } from "../design/tokens";
import { AppText } from "./AppText";

export type ChartPoint = {
  /** Identifies the point, such as its date. Unique within a chart. */
  readonly key: string;
  /**
   * The x-axis label under this point in a chart spaced by slots. An empty
   * string leaves it blank. A chart spaced by time labels the months itself.
   */
  readonly label?: string;
  readonly value: number;
  /** When the value was recorded, in epoch milliseconds. A chart spaced by time needs it. */
  readonly at?: number;
};

/**
 * How points sit along the x axis. `slots` gives each point an equal slot,
 * for bars of equal periods, under its own label. `time` places each point by
 * its `at`, so a line shows the real gaps between values, and labels the
 * start of each month on the same scale.
 */
export type ChartSpacing = "slots" | "time";

type XLabel = { readonly key: string; readonly text: string };

type Plot = {
  readonly points: ReadonlyArray<ChartPoint>;
  readonly labels: ReadonlyArray<XLabel>;
  /** Which labels to draw and their left edges, given each label's measured width. */
  readonly placeLabels: (widths: ReadonlyArray<number>) => ReadonlyArray<PlacedLabel>;
  readonly ticks: Ticks;
  readonly width: number;
  readonly height: number;
  /** Point i's x position. Marks and labels share it, so they line up. */
  readonly x: (index: number) => number;
  readonly y: (value: number) => number;
  readonly slot: number;
};

const PlotContext = createContext<Plot | null>(null);

// Keeps points and lines on the plot's edges from being cut in half by the SVG's edge.
const PLOT_INSET = 6;
const X_LABEL_GAP = 4;

function usePlot(): Plot {
  const plot = use(PlotContext);
  if (!plot) throw new Error("Chart marks must be children of <Chart>");
  return plot;
}

/**
 * The frame every chart shares: value axis, x labels and the plot's scales.
 * Marks such as ChartGrid, ChartLine and ChartBars go inside it. Axis labels
 * are text views, so they follow Dynamic Type. VoiceOver reads the chart as
 * one image with the caller's summary.
 */
export function Chart({
  points,
  accessibilityLabel,
  includeZero = false,
  spacing = "slots",
  formatValue = String,
  testID,
  children,
}: {
  readonly points: ReadonlyArray<ChartPoint>;
  /** What the chart shows in words, such as "Bench press best set, rising from 80 to 92.5 kg". */
  readonly accessibilityLabel: string;
  /** Bars start at zero. A line can start near its lowest value. */
  readonly includeZero?: boolean;
  readonly spacing?: ChartSpacing;
  readonly formatValue?: (value: number) => string;
  readonly testID?: string;
  readonly children: ReactNode;
}) {
  const large = useIsAccessibilityTextSize();
  const [width, setWidth] = useState(0);
  const [labelHeight, setLabelHeight] = useState(0);
  const height = large ? 240 : 160;
  const plot = useMemo((): Plot => {
    const ticks = niceTicks(
      points.map((point) => point.value),
      large ? 3 : 4,
      { includeZero },
    );
    const slot = points.length > 0 ? width / points.length : 0;
    const times = points.map((point) => point.at ?? 0);
    const time = timeScale(times, [PLOT_INSET, width - PLOT_INSET]);
    const x = (index: number) =>
      spacing === "time" ? time(times[index] ?? 0) : slot * (index + 0.5);
    const months =
      spacing === "time" && points.length > 0
        ? monthTicks(Math.min(...times), Math.max(...times))
        : null;
    const labels: ReadonlyArray<XLabel> = months
      ? months.map((tick) => ({ key: `month-${tick.month}`, text: tick.label }))
      : points.map((point) => ({ key: point.key, text: point.label ?? "" }));
    const placeLabels = (widths: ReadonlyArray<number>) =>
      months
        ? placeMonthLabels(
            months.map((tick, index) => ({
              month: tick.month,
              center: time(tick.at),
              width: widths[index] ?? 0,
            })),
            width,
            X_LABEL_GAP,
          )
        : placeAxisLabels(
            points.map((_, index) => ({ center: x(index), width: widths[index] ?? 0 })),
            width,
            X_LABEL_GAP,
          );
    return {
      points,
      labels,
      placeLabels,
      ticks,
      width,
      height,
      slot,
      x,
      y: scaleLinear([ticks.min, ticks.max], [height - PLOT_INSET, PLOT_INSET]),
    };
  }, [points, includeZero, spacing, large, width, height]);
  const [labelWidths, setLabelWidths] = useState<Readonly<Record<string, number>>>({});
  const placed = useMemo(() => {
    const widths = plot.labels.flatMap((label) => {
      const measured = labelWidths[label.key];
      return measured === undefined ? [] : [measured];
    });
    if (widths.length < plot.labels.length) return new Map<number, number>();
    return new Map(plot.placeLabels(widths).map(({ index, left }) => [index, left]));
  }, [plot, labelWidths]);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <View className="flex-row gap-2">
        <View
          className="flex-1 gap-1"
          style={{ paddingTop: Math.max(0, labelHeight / 2 - PLOT_INSET) }}
          onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        >
          <View style={{ height }}>
            {width > 0 ? (
              <Svg width={width} height={height}>
                <PlotContext value={plot}>{children}</PlotContext>
              </Svg>
            ) : null}
          </View>
          <View>
            {/* Sets the row's height. Each label keeps its own width, centred on its point
                or its month's start, and labels that would overlap are left out. */}
            <AppText variant="caption1" style={{ opacity: 0 }}>
              0
            </AppText>
            {plot.labels.map((label, index) => {
              const left = placed.get(index);
              return (
                <AppText
                  key={label.key}
                  variant="caption1"
                  tone="secondary"
                  numberOfLines={1}
                  className="absolute top-0 left-0"
                  // Placed with a transform, so moving a label never changes the width it measures.
                  style={{
                    opacity: left === undefined ? 0 : 1,
                    transform: [{ translateX: left ?? 0 }],
                  }}
                  onLayout={({ nativeEvent }) => {
                    const measuredWidth = nativeEvent.layout.width;
                    setLabelWidths((widths) =>
                      widths[label.key] === measuredWidth
                        ? widths
                        : { ...widths, [label.key]: measuredWidth },
                    );
                  }}
                >
                  {label.text}
                </AppText>
              );
            })}
          </View>
        </View>
        <View className="justify-between" style={{ height: height - 2 * PLOT_INSET + labelHeight }}>
          {plot.ticks.values.toReversed().map((tick, index) => (
            <AppText
              key={tick}
              variant="caption1"
              tone="secondary"
              numeric
              onLayout={
                index === 0
                  ? ({ nativeEvent }) => setLabelHeight(nativeEvent.layout.height)
                  : undefined
              }
            >
              {formatValue(tick)}
            </AppText>
          ))}
        </View>
      </View>
    </View>
  );
}

/** A hairline at each value tick, solid at the bottom and dashed above it. */
export function ChartGrid() {
  const { ticks, width, y } = usePlot();
  const color = useColor("separator");
  return ticks.values.map((tick, index) => (
    <Line
      key={tick}
      x1={0}
      x2={width}
      y1={y(tick)}
      y2={y(tick)}
      stroke={color}
      strokeWidth={1}
      strokeDasharray={index === 0 ? undefined : "3 3"}
    />
  ));
}

export function ChartLine({ color = "accent" }: { readonly color?: ColorToken }) {
  const { points, x, y } = usePlot();
  const stroke = useColor(color);
  const surface = useColor("surface");
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point.value)}`)
    .join(" ");
  return (
    <>
      <Path
        d={path}
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {points.map((point, index) => (
        <Circle
          key={point.key}
          cx={x(index)}
          cy={y(point.value)}
          r={4}
          fill={surface}
          stroke={stroke}
          strokeWidth={2.5}
        />
      ))}
    </>
  );
}

export function ChartBars({ color = "accent" }: { readonly color?: ColorToken }) {
  const { points, slot, ticks, x, y } = usePlot();
  const fill = useColor(color);
  const barWidth = slot * 0.6;
  const base = y(Math.max(0, ticks.min));
  return points.map((point, index) => {
    const top = y(point.value);
    return (
      <Rect
        key={point.key}
        x={x(index) - barWidth / 2}
        y={Math.min(top, base)}
        width={barWidth}
        height={Math.abs(base - top)}
        rx={Math.min(6, barWidth / 4)}
        fill={fill}
      />
    );
  });
}
