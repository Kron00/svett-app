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
  label: "",
  value: 80 + index,
  at: day * DAY,
}));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

/** Draws the chart 192 points wide and returns where each line point sits. */
function pointPositions(spacing: ChartSpacing): ReadonlyArray<number> {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <Chart points={POINTS} spacing={spacing} accessibilityLabel="Bench press">
        <ChartLine />
      </Chart>,
    );
  });
  if (!tree) throw new Error("did not render");
  const { root } = tree;
  const plot = root.find(
    (node) => String(node.type) === "View" && typeof node.props.onLayout === "function",
  );
  act(() => plot.props.onLayout({ nativeEvent: { layout: { width: 192, height: 160 } } }));
  return root.findAll((node) => String(node.type) === "Circle").map((node) => node.props.cx);
}

describe("Chart", () => {
  it("places a line's points by the time between them when spaced by time", () => {
    // The plot runs from 6 to 186, inside its 6-point inset.
    expect(pointPositions("time")).toEqual([6, 7, 186]);
  });

  it("gives each point an equal slot when spaced by slots", () => {
    expect(pointPositions("slots")).toEqual([32, 96, 160]);
  });
});
