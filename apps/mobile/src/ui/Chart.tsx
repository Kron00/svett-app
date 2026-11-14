import { niceTicks, placeAxisLabels, scaleLinear, type Ticks, timePositions } from "@svett/core";
import { createContext, type ReactNode, use, useMemo, useState } from "react";
import { View } from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

import { useColor, useIsAccessibilityTextSize } from "../design/hooks";
import type { ColorToken } from "../design/tokens";
import { AppText } from "./AppText";

export type ChartPoint = {
  /** Identifies the point, such as its date. Unique within a chart. */
  readonly key: string;
  /** The x-axis label under this point. An empty string leaves it blank. */
  readonly label: string;
  readonly value: number;
  /** When the value was recorded, in epoch milliseconds. A chart spaced by time needs it. */
  readonly at?: number;
};

/**
 * How points sit along the x axis. `slots` gives each point an equal slot,
 * for bars of equal periods. `time` places each point by its `at`, so a line
 * shows the real gaps between values.
 */
export type ChartSpacing = "slots" | "time";

type Plot = {
  readonly points: ReadonlyArray<ChartPoint>;
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
    const timed =
      spacing === "time"
        ? timePositions(
            points.map((point) => point.at ?? 0),
            [PLOT_INSET, width - PLOT_INSET],
          )
        : null;
    return {
      points,
      ticks,
      width,
      height,
      slot,
      x: (index) => (timed === null ? slot * (index + 0.5) : (timed[index] ?? 0)),
      y: scaleLinear([ticks.min, ticks.max], [height - PLOT_INSET, PLOT_INSET]),
    };
  }, [points, includeZero, spacing, large, width, height]);
  const [labelWidths, setLabelWidths] = useState<Readonly<Record<string, number>>>({});
  const measured = points.every((point) => labelWidths[point.key] !== undefined);
  const placed = useMemo(
    () =>
      new Map(
        measured
          ? placeAxisLabels(
              points.map((point, index) => ({
                center: plot.x(index),
                width: labelWidths[point.key] ?? 0,
              })),
              width,
              X_LABEL_GAP,
            ).map(({ index, left }) => [index, left])
          : [],
      ),
    [points, plot, labelWidths, measured, width],
  );

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
            {/* Sets the row's height. Each label keeps its own width, centred on its point,
                and labels that would overlap at large text sizes are left out. */}
            <AppText variant="caption1" style={{ opacity: 0 }}>
              0
            </AppText>
            {points.map((point, index) => {
              const left = placed.get(index);
              return (
                <AppText
                  key={point.key}
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
                      widths[point.key] === measuredWidth
                        ? widths
                        : { ...widths, [point.key]: measuredWidth },
                    );
                  }}
                >
                  {point.label}
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
