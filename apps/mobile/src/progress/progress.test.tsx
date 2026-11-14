import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  type ActivityId,
  ActivityRepository,
  DurationSeconds,
  EpochMillis,
  libraryExerciseId,
  MADE_HERE,
  RoutineRepository,
  type SetDraft,
} from "@svett/core";
import { Effect } from "effect";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appDatabase } from "../data/store";
import type { RootStackParamList } from "../navigation";
import { CalendarScreen } from "./CalendarScreen";
import { ProgressScreen } from "./ProgressScreen";
import { SetEditScreen } from "./SetEditScreen";
import { WorkoutScreen } from "./WorkoutScreen";

const screen = vi.hoisted(() => ({ fontScale: 1 }));
const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  goBack: vi.fn(),
  setOptions: vi.fn(),
  setParams: vi.fn(),
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => {} },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { hairlineWidth: 0.5 },
  Switch: "Switch",
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: screen.fontScale }),
}));
// Renders every row, so the test sees the whole history the list would scroll through.
vi.mock("@legendapp/list/react-native", async () => {
  const { createElement } = await import("react");
  type Props = {
    readonly testID: string;
    readonly data: ReadonlyArray<never>;
    readonly keyExtractor: (item: never) => string;
    readonly renderItem: (info: { readonly item: never }) => ReactNode;
    readonly ListHeaderComponent: ReactNode;
    readonly ListEmptyComponent: ReactNode;
    readonly ListFooterComponent: ReactNode;
  };
  return {
    LegendList: (props: Props) =>
      createElement(
        "LegendList",
        { testID: props.testID },
        props.ListHeaderComponent,
        props.data.length === 0 ? props.ListEmptyComponent : null,
        ...props.data.map((item) =>
          createElement("Item", { key: props.keyExtractor(item) }, props.renderItem({ item })),
        ),
        props.ListFooterComponent,
      ),
  };
});
vi.mock("@expo/ui/community/segmented-control", () => ({
  SegmentedControl: "NativeSegmentedControl",
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {}, useNavigation: () => navigation }));
vi.mock("../data/database", async () => {
  const { ManagedRuntime } = await import("effect");
  const { databaseLayer, Ids } = await import("@svett/core");
  const { openNodeDatabase } = await import("@svett/core/node");
  return {
    launchTarget: () => ({ kind: "file", path: ":memory:" }),
    openDatabase: () =>
      ManagedRuntime.make(databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(7))),
  };
});

const DAY = 86_400_000;
const SQUAT = libraryExerciseId("Barbell_Squat");

const set = (
  weightKg: number,
  reps: number,
  setType: SetDraft["setType"] = "normal",
): SetDraft => ({ setType, weightKg, reps, durationS: null, distanceM: null, rpe: null });

const log = (daysAgo: number, title: string, sets: ReadonlyArray<SetDraft>) =>
  appDatabase().runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.create({
        kind: "strength",
        startedAt: EpochMillis.make(Date.now() - daysAgo * DAY),
        durationS: DurationSeconds.make(3_900),
        title,
        notes: "",
        energyKcal: null,
        audience: "only_you",
        hiddenFields: [],
        origin: MADE_HERE,
        track: null,
        exercises: [{ exerciseId: SQUAT, supersetGroup: null, notes: "", sets }],
      }),
    ),
  );

/** Lets the database reads finish and React show their results. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

/** The props React Navigation gives a stack screen, with the shared mock navigation. */
const screenProps = <Name extends keyof RootStackParamList>(
  name: Name,
  params: RootStackParamList[Name],
) =>
  ({ route: { key: name, name, params }, navigation }) as unknown as NativeStackScreenProps<
    RootStackParamList,
    Name
  >;

const render = async (element: ReactElement) => {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(element);
  });
  await settle();
  if (!tree) throw new Error("did not render");
  return tree;
};

const isHost = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

/** Every line of text on screen. */
const lines = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => isHost(node, "Text")).map(textOf);

const byTestId = (tree: ReactTestRenderer, testID: string) =>
  tree.root.find((node) => typeof node.type === "string" && node.props.testID === testID);

const press = async (node: ReactTestInstance) => {
  await act(async () => node.props.onPress());
  await settle();
};

/** Presses each labelled control in turn, as a finger on the keypad would. */
const pressLabels = (tree: ReactTestRenderer, labels: ReadonlyArray<string>) =>
  labels.reduce<Promise<void>>(
    (pressed, label) =>
      pressed.then(() =>
        press(
          tree.root.find(
            (node) => isHost(node, "Pressable") && node.props.accessibilityLabel === label,
          ),
        ),
      ),
    Promise.resolve(),
  );

const setIds = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((node) => isHost(node, "Pressable") && String(node.props.testID).startsWith("set-"))
    .map((node) => String(node.props.testID).slice("set-".length));

const calendar = () => render(<CalendarScreen {...screenProps("Calendar", undefined)} />);

let older: ActivityId;
let newest: ActivityId;

beforeAll(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  older = await log(9, "Legs", [set(100, 5), set(100, 5)]);
  newest = await log(2, "Heavy legs", [set(60, 8, "warm_up"), set(105, 5), set(100, 5)]);
});

beforeEach(() => {
  screen.fontScale = 1;
  vi.clearAllMocks();
});

describe("a past workout", () => {
  it("shows its sets with record badges and its muscle split", async () => {
    const tree = await render(<WorkoutScreen {...screenProps("Workout", { id: newest })} />);
    const shown = lines(tree);
    expect(shown).toEqual(expect.arrayContaining(["60 kg × 8", "105 kg × 5", "100 kg × 5"]));
    expect(shown).toEqual(expect.arrayContaining(["Heaviest weight", "Estimated 1RM", "Quads"]));
    expect(shown).toContain("100% · 2 sets");
    expect(navigation.setOptions).toHaveBeenCalledWith({ title: "Heavy legs" });
  });

  it("shows an edited set on its detail screen", async () => {
    const detail = await render(<WorkoutScreen {...screenProps("Workout", { id: older })} />);
    expect(lines(detail).filter((line) => line === "100 kg × 5")).toHaveLength(2);
    const [setId = ""] = setIds(detail);

    const edit = await render(
      <SetEditScreen {...screenProps("SetEdit", { activityId: older, setId })} />,
    );
    await pressLabels(edit, ["Delete", "Delete", "Delete", "1", "2", "2", "Decimal point", "5"]);
    await pressLabels(edit, ["Reps", "Delete", "4"]);
    await press(byTestId(edit, "set-edit-save"));

    expect(navigation.goBack).toHaveBeenCalled();
    expect(lines(detail)).toEqual(expect.arrayContaining(["122.5 kg × 4", "100 kg × 5"]));
  });

  it("refuses a set left with no reps and saves nothing", async () => {
    const detail = await render(<WorkoutScreen {...screenProps("Workout", { id: newest })} />);
    const setId = setIds(detail)[1] ?? "";
    const edit = await render(
      <SetEditScreen {...screenProps("SetEdit", { activityId: newest, setId })} />,
    );
    await pressLabels(edit, ["Reps", "Delete"]);
    await press(byTestId(edit, "set-edit-save"));
    expect(textOf(byTestId(edit, "set-edit-error"))).toBe(
      "A set needs reps. Enter how many you did.",
    );
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(lines(detail)).toContain("105 kg × 5");
  });

  it("saves as a routine with its sets as targets", async () => {
    const tree = await render(<WorkoutScreen {...screenProps("Workout", { id: newest })} />);
    await press(byTestId(tree, "workout-save-routine"));
    expect(textOf(byTestId(tree, "routine-saved"))).toContain("Heavy legs");
    const routines = await appDatabase().runPromise(
      Effect.flatMap(Effect.service(RoutineRepository), (repository) => repository.listRoutines),
    );
    expect(routines.map((routine) => routine.title)).toContain("Heavy legs");
  });
});

describe("history", () => {
  it("deletes a workout and brings it back with Undo", async () => {
    const history = await render(<ProgressScreen />);
    expect(textOf(byTestId(history, "workout-counts"))).toBe("2 workouts, 5 sets");
    expect(() => byTestId(history, `workout-${newest}`)).not.toThrow();

    const detail = await render(<WorkoutScreen {...screenProps("Workout", { id: newest })} />);
    await press(byTestId(detail, "workout-delete"));
    expect(navigation.navigate).toHaveBeenCalledWith("Tabs", { screen: "Progress" });
    // The screen keeps showing the workout while it slides away.
    expect(lines(detail)).toContain("105 kg × 5");
    expect(textOf(byTestId(history, "workout-counts"))).toBe("1 workouts, 2 sets");
    expect(() => byTestId(history, `workout-${newest}`)).toThrow();
    expect(textOf(byTestId(history, "undo-delete-banner"))).toContain("Deleted Heavy legs.");

    await press(byTestId(history, "undo-delete"));
    expect(textOf(byTestId(history, "workout-counts"))).toBe("2 workouts, 5 sets");
    expect(() => byTestId(history, `workout-${newest}`)).not.toThrow();
    expect(() => byTestId(history, "undo-delete-banner")).toThrow();
  });
});

describe("the calendar", () => {
  it("shows the month as a grid with the weekly streak", async () => {
    const tree = await calendar();
    expect(lines(tree)).toEqual(expect.arrayContaining(["M", "T", "W", "F", "S"]));
    expect(byTestId(tree, "calendar-streak").props.accessibilityLabel).toMatch(
      /^Streak, [12] weeks?$/,
    );
  });

  it("lists the month's workouts instead of a grid at accessibility text sizes", async () => {
    screen.fontScale = 3.1;
    const tree = await calendar();
    expect(lines(tree)).not.toContain("M");
    const rows = tree.root.findAll(
      (node) =>
        isHost(node, "Pressable") && String(node.props.accessibilityLabel).startsWith("Legs"),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
