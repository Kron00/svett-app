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

import { appDatabase } from "../data/database";
import { write } from "../data/store";
import type { RootStackParamList } from "../navigation";
import { CalendarScreen } from "./CalendarScreen";
import { ProgressScreen } from "./ProgressScreen";
import { SetEditScreen } from "./SetEditScreen";
import { WorkoutScreen } from "./WorkoutScreen";

const screen = vi.hoisted(() => ({ fontScale: 1 }));
const time = vi.hoisted(() => ({ set: (_millis: number): void => {} }));
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  goBack: vi.fn(),
  setOptions: vi.fn(),
  setParams: vi.fn(),
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => {} },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { hairlineWidth: 0.5 },
  Switch: "Switch",
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: screen.fontScale }),
}));
// Renders the rows it is given. progress-screens.test.tsx loads more through onEndReached.
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
  const effect = await import("effect");
  const { databaseLayer, Ids } = await import("@svett/core");
  const { manualClock, openNodeDatabase } = await import("@svett/core/node");
  const clock = manualClock(Date.now());
  time.set = (millis) => effect.Effect.runSync(clock.set(millis));
  const runtime = effect.ManagedRuntime.make(
    effect.Layer.provideMerge(
      databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(7)),
      clock.layer,
    ),
  );
  return { appDatabase: () => runtime };
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
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(30);
    else await new Promise((resolve) => setTimeout(resolve, 30));
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

/** Lets reads finish until the element with `testID` is on screen, or gone when `shown` is false. */
const showsTestId = async (
  tree: ReactTestRenderer,
  testID: string,
  shown = true,
  tries = 50,
): Promise<void> => {
  const found =
    tree.root.findAll((node) => typeof node.type === "string" && node.props.testID === testID)
      .length > 0;
  if (tries === 0 || found === shown) return;
  await settle();
  return showsTestId(tree, testID, shown, tries - 1);
};

/** Lets reads finish until `line` is on screen, as a detail reads a set again after a save. */
const showsLine = async (tree: ReactTestRenderer, line: string, tries = 50): Promise<void> => {
  if (tries === 0 || lines(tree).includes(line)) return;
  await settle();
  return showsLine(tree, line, tries - 1);
};

const calendar = () => render(<CalendarScreen {...screenProps("Calendar", undefined)} />);

let older: ActivityId;
let newest: ActivityId;
let newestAt: number;

beforeAll(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  older = await log(9, "Legs", [set(100, 5), set(100, 5)]);
  newestAt = Date.now() - 2 * DAY;
  newest = await log(2, "Heavy legs", [set(60, 8, "warm_up"), set(105, 5), set(100, 5)]);
});

beforeEach(() => {
  time.set(Date.now());
  screen.fontScale = 1;
  vi.clearAllMocks();
});

describe("a past workout", () => {
  it("shows its sets with record badges and its muscle split", async () => {
    const tree = await render(<WorkoutScreen {...screenProps("Workout", { id: newest })} />);
    const shown = lines(tree);
    expect(shown).toEqual(expect.arrayContaining(["60 kg × 8", "105 kg × 5", "100 kg × 5"]));
    expect(shown).toEqual(
      expect.arrayContaining(["Heaviest weight", "Estimated 1RM", "Quadriceps"]),
    );
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
    await showsLine(detail, "122.5 kg × 4");

    expect(navigation.goBack).toHaveBeenCalled();
    expect(lines(detail)).toEqual(expect.arrayContaining(["122.5 kg × 4", "100 kg × 5"]));
  });

  it("saves a set once and goes back once however often Save is pressed", async () => {
    const detail = await render(<WorkoutScreen {...screenProps("Workout", { id: older })} />);
    const setId = setIds(detail)[1] ?? "";
    const edit = await render(
      <SetEditScreen {...screenProps("SetEdit", { activityId: older, setId })} />,
    );
    await pressLabels(edit, ["Reps", "Delete", "7"]);
    act(() => {
      for (let tap = 0; tap < 3; tap++) byTestId(edit, "set-edit-save").props.onPress();
    });
    expect(byTestId(edit, "set-edit-save").props.disabled).toBe(true);
    expect(byTestId(edit, "set-edit-cancel").props.disabled).toBe(true);
    await showsLine(detail, "100 kg × 7");

    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(lines(detail)).toEqual(expect.arrayContaining(["122.5 kg × 4", "100 kg × 7"]));
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
    // The counts and the list are separate reads that finish in either order, so wait for each.
    await showsLine(history, "1 workouts, 2 sets");
    expect(textOf(byTestId(history, "workout-counts"))).toBe("1 workouts, 2 sets");
    await showsTestId(history, `workout-${newest}`, false);
    expect(() => byTestId(history, `workout-${newest}`)).toThrow();
    expect(textOf(byTestId(history, "undo-delete-banner"))).toContain("Deleted Heavy legs.");

    await press(byTestId(history, "undo-delete"));
    await showsLine(history, "2 workouts, 5 sets");
    expect(textOf(byTestId(history, "workout-counts"))).toBe("2 workouts, 5 sets");
    await showsTestId(history, `workout-${newest}`);
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

/** The last minute of the Sunday after the newest workout's week, which still counts that week. */
const lastMinute = () => {
  const day = new Date(newestAt);
  const monday = day.getDate() - ((day.getDay() + 6) % 7);
  return new Date(day.getFullYear(), day.getMonth(), monday + 14).getTime() - 30_000;
};

const streak = (tree: ReactTestRenderer) =>
  String(byTestId(tree, "streak-current").props.accessibilityLabel);

/** Lets reads finish until the streak reads `label`. */
const streakReads = async (tree: ReactTestRenderer, label: RegExp, tries = 50): Promise<void> => {
  if (tries === 0 || label.test(streak(tree))) {
    expect(streak(tree)).toMatch(label);
    return;
  }
  await settle();
  return streakReads(tree, label, tries - 1);
};

describe("the streak across midnight", () => {
  it("ends on the Monday the screen stays open into", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      time.set(lastMinute());
      const history = await render(<ProgressScreen />);
      await streakReads(history, /^Streak, [12] weeks?$/);

      time.set(lastMinute() + 60_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000);
      });
      expect(streak(history)).toMatch(/^Streak, [12] weeks?$/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await streakReads(history, /^Streak, 0 weeks$/);
      await act(async () => history.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the clock again when svett comes back to the foreground", async () => {
    time.set(lastMinute());
    const history = await render(<ProgressScreen />);
    expect(streak(history)).toMatch(/^Streak, [12] weeks?$/);

    time.set(lastMinute() + 3 * DAY);
    for (const listener of appState.listeners) listener("background");
    await settle();
    expect(streak(history)).toMatch(/^Streak, [12] weeks?$/);
    for (const listener of appState.listeners) listener("active");
    await settle();
    expect(streak(history)).toBe("Streak, 0 weeks");
    await act(async () => history.unmount());
  });
});

describe("a recorded run in history", () => {
  it("opens on its route screen, and a workout opens on its sets", async () => {
    const history = await render(<ProgressScreen />);
    const run = await write(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.create({
          kind: "run",
          startedAt: EpochMillis.make(Date.now() - DAY),
          durationS: DurationSeconds.make(1_800),
          title: "Morning run",
          notes: "",
          energyKcal: null,
          audience: "only_you",
          hiddenFields: [],
          origin: MADE_HERE,
          track: null,
          exercises: [],
        }),
      ),
    );
    await showsTestId(history, `workout-${run}`);

    await press(byTestId(history, `workout-${run}`));
    expect(navigation.navigate).toHaveBeenCalledWith("Activity", { id: run });
    await press(byTestId(history, `workout-${newest}`));
    expect(navigation.navigate).toHaveBeenLastCalledWith("Workout", { id: newest });
    await act(async () => history.unmount());
  });
});
