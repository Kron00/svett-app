import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { Chart, type ChartPoint, type ChartSpacing, ChartLine } from "./Chart";

vi.mock("react-native", () => ({
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("react-native-svg", () => ({
  default: "Svg",
  Circle: "Circle",
  Line: "Line",
  Path: "Path",
  Rect: "Rect",
}));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

const DAY = 86_400_000;
// Two workouts a day apart, then one 179 days later.
const POINTS: ReadonlyArray<ChartPoint> = [0, 1, 180].map((day, index) => ({
  key: `workout-${index}`,
  value: 80 + index,
  at: day * DAY,
}));

/** Midnight on the first of `month` 2026, in the phone's time zone. */
const local = (month: number) => new Date(2026, month, 1).getTime();

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

/** Draws the chart `width` points wide and returns its renderer. */
function drawChart(
  points: ReadonlyArray<ChartPoint>,
  spacing: ChartSpacing,
  width: number,
): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <Chart points={points} spacing={spacing} accessibilityLabel="Bench press">
        <ChartLine />
      </Chart>,
    );
  });
  if (!tree) throw new Error("did not render");
  const plot = tree.root.find(
    (node) => String(node.type) === "View" && typeof node.props.onLayout === "function",
  );
  act(() => plot.props.onLayout({ nativeEvent: { layout: { width, height: 160 } } }));
  return tree;
}

/** Where each line point sits in a chart 192 points wide. */
function pointPositions(spacing: ChartSpacing): ReadonlyArray<number> {
  return drawChart(POINTS, spacing, 192)
    .root.findAll((node) => String(node.type) === "Circle")
    .map((node) => node.props.cx);
}

const xLabels = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => String(node.type) === "Text" && node.props.numberOfLines === 1);

/** The x labels the chart shows, with their left edges, once each measures `labelWidth`. */
function shownLabels(tree: ReactTestRenderer, labelWidth: number) {
  act(() => {
    for (const label of xLabels(tree)) {
      label.props.onLayout({ nativeEvent: { layout: { width: labelWidth, height: 16 } } });
    }
  });
  return xLabels(tree).flatMap((label) => {
    const style = Object.assign({}, ...[label.props.style].flat(2));
    return style.opacity === 1 ? [[label.props.children, style.transform[0].translateX]] : [];
  });
}

describe("Chart", () => {
  it("places a line's points by the time between them when spaced by time", () => {
    // The plot runs from 6 to 186, inside its 6-point inset.
    expect(pointPositions("time")).toEqual([6, 7, 186]);
  });

  it("gives each point an equal slot when spaced by slots", () => {
    expect(pointPositions("slots")).toEqual([32, 96, 160]);
  });

  it("labels each month's start on the points' time scale, through a gap with no points", () => {
    // Workouts on 1 January and 1 February, then none until 1 June, across a plot from 6 to 186.
    const points = [0, 1, 5].map((month) => ({
      key: `workout-${month}`,
      value: 80 + month,
      at: local(month),
    }));
    const tree = drawChart(points, "time", 192);
    const x = (time: number) => 6 + ((time - local(0)) / (local(5) - local(0))) * 180;
    expect(shownLabels(tree, 20)).toEqual([
      ["2026", 0],
      ["Feb", x(local(1)) - 10],
      ["Mar", x(local(2)) - 10],
      ["Apr", x(local(3)) - 10],
      ["May", x(local(4)) - 10],
      ["Jun", 192 - 20],
    ]);
  });

  it("keeps time labels a whole number of months apart when they do not all fit", () => {
    const points = [0, 5].map((month) => ({
      key: `workout-${month}`,
      value: 80,
      at: local(month),
    }));
    const tree = drawChart(points, "time", 192);
    expect(shownLabels(tree, 40).map(([text]) => text)).toEqual(["2026", "Mar", "May"]);
  });
});
