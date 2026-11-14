import { databaseLayer, Ids, libraryExerciseId } from "@svett/core";
import { buildFixture, manualClock, openNodeDatabase } from "@svett/core/node";
import { Layer, ManagedRuntime } from "effect";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { Chart } from "../ui/Chart";
import { ExerciseProgressScreen } from "./ExerciseProgressScreen";
import { MeasurementsScreen } from "./MeasurementsScreen";
import { MuscleSetsScreen } from "./MuscleSetsScreen";
import { ProgressScreen } from "./ProgressScreen";

const app = vi.hoisted(() => ({
  runtime: undefined as unknown,
  onEndReached: undefined as (() => void) | undefined,
  route: { params: {} as Record<string, unknown> | undefined },
  fontScale: 1,
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: app.fontScale }),
}));
vi.mock("react-native-svg", () => ({
  default: "Svg",
  Circle: "Circle",
  Line: "Line",
  Path: "Path",
  Rect: "Rect",
}));
// Renders the rows it is given and keeps onEndReached, which a scroll near the end calls.
vi.mock("@legendapp/list/react-native", async () => {
  const { createElement } = await import("react");
  type Props = {
    readonly testID: string;
    readonly data: ReadonlyArray<never>;
    readonly keyExtractor: (item: never) => string;
    readonly renderItem: (info: { readonly item: never }) => ReactNode;
    readonly onEndReached: () => void;
    readonly ListHeaderComponent: ReactNode;
    readonly ListFooterComponent: ReactNode;
  };
  return {
    LegendList: (props: Props) => {
      app.onEndReached = props.onEndReached;
      return createElement(
        "LegendList",
        { testID: props.testID },
        props.ListHeaderComponent,
        ...props.data.map((item) =>
          createElement("Item", { key: props.keyExtractor(item) }, props.renderItem({ item })),
        ),
        props.ListFooterComponent,
      );
    },
  };
});
vi.mock("@expo/ui/community/segmented-control", () => ({
  SegmentedControl: "NativeSegmentedControl",
}));
vi.mock("@expo/ui/swift-ui", () => ({
  BottomSheet: "BottomSheet",
  Group: "Group",
  Host: "Host",
  RNHostView: "RNHostView",
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  presentationDragIndicator: () => ({}),
  presentationSizing: () => ({}),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  const navigation = {
    navigate: () => {},
    setOptions: () => {},
    setParams: (params: Record<string, unknown>) => {
      app.route.params = { ...app.route.params, ...params };
    },
  };
  return {
    DarkTheme: {},
    useNavigation: () => navigation,
    useRoute: () => app.route,
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
  };
});
vi.mock("../data/current", () => {
  const database = {
    owner: { kind: "anonymous" },
    handle: {
      target: { kind: "owner", owner: { kind: "anonymous" } },
      get runtime() {
        return app.runtime;
      },
    },
  };
  return {
    appDatabase: () => app.runtime,
    currentDatabase: () => database,
    stillOpen: (open: unknown) => open === database,
    subscribeDatabase: () => () => undefined,
  };
});

// Twelve days after the fixture's last workout, like the day this was written.
const NOW = new Date(2026, 10, 13, 12).getTime();
const BENCH = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");

beforeAll(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { driver } = openNodeDatabase();
  await buildFixture(driver);
  app.runtime = ManagedRuntime.make(
    Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(7)), manualClock(NOW).layer),
  );
}, 60_000);

afterAll(() => (app.runtime as ManagedRuntime.ManagedRuntime<never, never>).dispose());

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function until(done: () => boolean, what: string, tries = 0): Promise<void> {
  if (done()) return;
  if (tries > 200) throw new Error(`${what} never happened`);
  await settle();
  return until(done, what, tries + 1);
}

/** Renders the screen and waits until `shows` is on it. */
async function show(screen: ReactElement, shows: string, params?: Record<string, unknown>) {
  app.route.params = params;
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(screen);
  });
  const { root } = tree ?? { root: undefined };
  if (!root) throw new Error("did not render");
  await until(() => root.findAll(byTestID(shows)).length > 0, `showing ${shows}`);
  return root;
}

const byTestID = (id: string) => (node: ReactTestInstance) =>
  typeof node.type === "string" && node.props.testID === id;

const byTestIDPrefix = (prefix: string) => (node: ReactTestInstance) =>
  typeof node.type === "string" && String(node.props.testID).startsWith(prefix);

const texts = (node: ReactTestInstance): ReadonlyArray<string> =>
  node
    .findAll((each) => String(each.type) === "Text")
    .map((each) => [each.props.children].flat().join(""));

const chartIn = (root: ReactTestInstance, testID: string) =>
  root.find((node) => node.type === Chart && node.props.testID === testID);

describe("Progress screens with the 300-workout fixture", () => {
  it("shows the workout counts and the five newest records on the Progress tab", async () => {
    const root = await show(<ProgressScreen />, "progress");
    const counts = () => texts(root.find(byTestID("workout-counts")))[0] ?? "";
    await until(() => counts() !== "Opening the database", "counting workouts");
    expect(counts()).toMatch(/^300 workouts, \d+ sets$/);
    expect(root.findAll(byTestID("recent-record"))).toHaveLength(5);
  });

  it("loads all 300 workouts as the history list scrolls to its end", async () => {
    const root = await show(<ProgressScreen />, "history-row");
    const workouts = () =>
      root
        .findAll(byTestIDPrefix("workout-"))
        .map((node) => String(node.props.testID))
        .filter((id) => id !== "workout-counts");
    expect(workouts()).toHaveLength(60);
    const scrollToEnd = async (): Promise<void> => {
      const shown = workouts().length;
      if (shown >= 300) return;
      await act(async () => app.onEndReached?.());
      await until(() => workouts().length > shown, `loading more than ${shown} workouts`);
      return scrollToEnd();
    };
    await scrollToEnd();
    expect(new Set(workouts()).size).toBe(300);
    await act(async () => app.onEndReached?.());
    await settle();
    expect(workouts()).toHaveLength(300);
  });

  it("charts every bench press workout with its three lifting metrics and lists its records", async () => {
    const root = await show(<ExerciseProgressScreen />, "exercise-progress", {
      exerciseId: BENCH,
      range: "all",
    });
    for (const metric of ["best_one_rep_max", "heaviest_weight", "session_volume"]) {
      // Bench press opens every one of the 100 push workouts.
      expect(chartIn(root, `chart-${metric}`).props.points).toHaveLength(100);
    }
    expect(root.findAll(byTestID("chart-most_reps"))).toHaveLength(0);
    const heaviest = chartIn(root, "chart-heaviest_weight").props;
    // The fixture's bench press starts at 70 kg and ends 30% heavier, in 2.5 kg steps.
    expect(heaviest.points[0].value).toBe(70);
    expect(heaviest.points[99].value).toBe(90);
    expect(heaviest.accessibilityLabel).toMatch(/^Heaviest weight, 100 points from .* to 90 kg/);
    // Each point keeps its workout's time, so the line shows the gaps between workouts.
    expect(heaviest.spacing).toBe("time");
    const times = heaviest.points.map((point: { at: number }) => point.at);
    expect(times).toEqual(times.toSorted((a: number, b: number) => a - b));
    expect(
      new Set(times.slice(1).map((at: number, i: number) => at - times[i]!)).size,
    ).toBeGreaterThan(1);
    const all = texts(root);
    expect(all).toContain("Personal records");
    expect(all).toContain("Each point is one workout. Warm-up sets never count.");
  });

  it("narrows the charts to the chosen range", async () => {
    const root = await show(<ExerciseProgressScreen />, "exercise-progress", { exerciseId: BENCH });
    const year = chartIn(root, "chart-heaviest_weight").props.points.length;
    expect(year).toBeGreaterThan(40);
    expect(year).toBeLessThan(60);
  });

  it("counts the sets per muscle of the fixture's last full week, with the rule beside them", async () => {
    const root = await show(<MuscleSetsScreen />, "muscle-sets", { week: "2026-10-26" });
    expect(texts(root.find(byTestID("muscle-week")))).toEqual(["26 Oct to 1 Nov 2026"]);
    const chart = chartIn(root, "chart-muscle-weeks").props;
    expect(chart.points).toHaveLength(12);
    expect(chart.spacing).toBe("slots");
    expect(chart.points.every((point: { value: number }) => point.value >= 0)).toBe(true);
    expect(root.findAll(byTestIDPrefix("muscle-row-")).length).toBeGreaterThan(3);
    expect(texts(root).filter((text) => text.startsWith("Each set counts 1"))).not.toHaveLength(0);
  });

  it("shows no sets for the current week, which the fixture has no workouts in", async () => {
    const root = await show(<MuscleSetsScreen />, "muscle-sets");
    expect(texts(root)).toContain("No sets this week");
    expect(root.find(byTestID("next-week")).props.accessibilityState).toEqual({ disabled: true });
  });

  it("charts every weekly weigh-in and saves a new body weight", async () => {
    const root = await show(<MeasurementsScreen />, "measurements", {
      kind: "body_weight",
      range: "all",
    });
    // A weigh-in every 7 days over 730 days.
    expect(chartIn(root, "chart-measurement").props.points).toHaveLength(105);
    expect(root.findAll(byTestIDPrefix("measurement-row-"))).toHaveLength(16);

    const sheet = root.find(byTestID("measurement-sheet"));
    const keypad = sheet.find((node) => typeof node.props.onKey === "function");
    await act(async () => {
      for (const key of ["7", "9", ".", "5"]) keypad.props.onKey(key);
    });
    await act(async () => {
      root
        .find(
          (node) => node.props.testID === "save-measurement" && String(node.type) === "Pressable",
        )
        .props.onPress();
    });
    await until(() => texts(root).includes("79.5 kg"), "showing the new weight");
    expect(chartIn(root, "chart-measurement").props.points).toHaveLength(106);
  });

  it("saves one measurement however often Save is pressed while it saves", async () => {
    const root = await show(<MeasurementsScreen />, "measurements", {
      kind: "body_weight",
      range: "all",
      sheet: "open",
    });
    const before = chartIn(root, "chart-measurement").props.points.length;
    const keypad = root
      .find(byTestID("measurement-sheet"))
      .find((node) => typeof node.props.onKey === "function");
    await act(async () => {
      for (const key of ["8", "0"]) keypad.props.onKey(key);
    });
    const save = () =>
      root.find(
        (node) => node.props.testID === "save-measurement" && String(node.type) === "Pressable",
      );
    act(() => {
      for (let press = 0; press < 3; press++) save().props.onPress();
    });
    expect(save().props.disabled).toBe(true);
    await until(() => app.route.params?.sheet === undefined, "closing the sheet");
    await until(
      () => chartIn(root, "chart-measurement").props.points.length !== before,
      "showing the new weight",
    );
    expect(chartIn(root, "chart-measurement").props.points).toHaveLength(before + 1);
  });
});
