import {
  addExercisesToWorkout,
  databaseLayer,
  Ids,
  libraryExerciseId,
  type RestTimer,
  startEmptyWorkout,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect, ManagedRuntime } from "effect";
import type { ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const app = vi.hoisted(() => ({ database: { handle: { runtime: undefined as unknown } } }));
vi.mock("../data/current", () => ({
  appDatabase: () => app.database.handle.runtime,
  currentDatabase: () => app.database,
  movePending: () => false,
  sameDatabase: (a: unknown, b: unknown) => a === b,
  stillOpen: (database: unknown) => database === app.database,
  subscribeDatabase: () => () => {},
}));

// The largest accessibility text size, AX5, on the 956 point screen.
const LARGEST = 3.1;
vi.mock("react-native", () => ({
  ActionSheetIOS: { showActionSheetWithOptions: () => undefined },
  Alert: { alert: () => undefined, prompt: () => undefined },
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Settings: { get: () => undefined, set: () => undefined },
  StyleSheet: { hairlineWidth: 0.5 },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: LARGEST }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("expo-notifications", () => ({}));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({
  DarkTheme: {},
  useFocusEffect: () => undefined,
  useNavigation: () => ({ navigate: () => undefined, setOptions: () => undefined }),
}));

// The navigation bar ends 115 points down, and the home indicator takes the last 34.
const HEADER = 115;
const SAFE_BOTTOM = 34;
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => HEADER }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: SAFE_BOTTOM, left: 0, right: 0 }),
}));

const rest = vi.hoisted(() => ({ timer: null as RestTimer | null }));
vi.mock("./rest", () => ({
  adjustRestTimer: () => undefined,
  currentRestTimer: () => rest.timer,
  restEnded: () => undefined,
  restoreRestTimer: () => undefined,
  skipRestTimer: () => {
    rest.timer = null;
  },
  startRestTimer: async () => undefined,
  useRestTimer: () => rest.timer,
}));

/**
 * The screen as UIKit lays it out at the largest text size. The workout fills the screen under
 * the navigation bar and scrolls by `offset`, starting with its top just below the bar. Each set
 * row is as tall as one there: its badge, then its weight on a line of its own, then its reps
 * and done box. `set` gives every row's height and where its fields sit in it.
 */
const screen = { offset: -HEADER, scrolls: [] as Array<number> };
const SCREEN_HEIGHT = 956;
const SET = { height: 256, weight: { top: 66, bottom: 146 }, reps: { top: 154, bottom: 234 } };
// A set whose badge line wraps over several lines, so it is taller than what the keypad and
// the rest timer leave of the screen.
const TALL_SET = {
  height: 420,
  weight: { top: 226, bottom: 306 },
  reps: { top: 318, bottom: 398 },
};
let set = SET;
const FIRST_ROW = 640;
const rowStep = () => set.height + 24;
// What the keypad and the rest timer above it take at that size.
const KEYPAD = 436;
const COMPACT_REST = 124;

const rowTop = (testID: string) => {
  const [, index] = /^workout-set(?:-row)?-0-(\d+)/.exec(testID) ?? [];
  if (index === undefined) throw new Error(`no row ${testID}`);
  return FIRST_ROW + Number(index) * rowStep();
};

type Measured = (x: number, y: number, width: number, height: number) => void;

const nodeMock = (element: ReactElement) => {
  const props = element.props as Record<string, unknown>;
  if (element.type === "ScrollView") {
    return {
      measureInWindow: (done: Measured) => done(0, 0, 440, SCREEN_HEIGHT),
      scrollTo: ({ y }: { y: number }) => {
        screen.offset = y;
        screen.scrolls.push(y);
      },
    };
  }
  // A set row's field box holds the field, whose id names the set and the column.
  const child = props.children as ReactElement<{ testID?: unknown }> | undefined;
  const fieldID = child?.props?.testID;
  if (typeof fieldID === "string" && /^set-0-\d+-(weight|reps)$/.test(fieldID)) {
    const column = fieldID.endsWith("weight") ? set.weight : set.reps;
    return {
      measureLayout: (_relativeTo: unknown, done: Measured) =>
        done(0, rowTop(`workout-${fieldID}`) + column.top, 200, column.bottom - column.top),
    };
  }
  if (props.collapsable === false) {
    return { measureInWindow: (done: Measured) => done(0, -screen.offset, 440, 9000) };
  }
  const testID = props.testID;
  if (typeof testID === "string" && testID.startsWith("workout-set-row-")) {
    return {
      measureLayout: (_relativeTo: unknown, done: Measured) =>
        done(0, rowTop(testID), 440, set.height),
    };
  }
  return {};
};

/** Where a set's row shows on screen now. */
const shownAt = (index: number) => {
  const top = rowTop(`workout-set-row-0-${index}`) - screen.offset;
  return { top, bottom: top + set.height };
};

/** Where a set's field shows on screen now. */
const fieldAt = (index: number, column: "weight" | "reps") => {
  const row = shownAt(index);
  return { top: row.top + set[column].top, bottom: row.top + set[column].bottom };
};

const byTestID = (id: string) => (node: ReactTestInstance) =>
  typeof node.type === "string" && node.props.testID === id;

const press = (root: ReactTestInstance, id: string) =>
  act(() => root.find(byTestID(id)).props.onPress());

/** UIKit lays out what covers the bottom of the workout at its height. */
const layOutCover = (root: ReactTestInstance, height: number) =>
  act(() =>
    root.find(byTestID("workout-cover")).props.onLayout({
      nativeEvent: { layout: { x: 0, y: SCREEN_HEIGHT - height, width: 440, height } },
    }),
  );

const squat = libraryExerciseId("Barbell_Squat");

/** Opens a workout of Barbell Squat with three sets, as the app's store reads it. */
const openWorkout = async () => {
  const { database, driver } = openNodeDatabase(":memory:");
  const runtime = ManagedRuntime.make(databaseLayer(driver, Ids.layerSeeded(1)));
  await runtime.runPromise(
    Effect.gen(function* () {
      const id = yield* startEmptyWorkout(9);
      yield* addExercisesToWorkout(id, [squat]);
    }),
  );
  app.database = { handle: { runtime } };
  vi.resetModules();
  const store = await import("./store");
  const actions = await import("./actions");
  const squatInWorkout = () => store.currentWorkout()!.exercises[0]!;
  // A new exercise starts with one set. Each Add set copies the last.
  await store.reloadWorkout();
  actions.addSet(squatInWorkout());
  await store.reloadWorkout();
  actions.addSet(squatInWorkout());
  await store.reloadWorkout();
  expect(squatInWorkout().sets).toHaveLength(3);
  const { WorkoutScreen } = await import("./WorkoutScreen");
  return { database, runtime, store, WorkoutScreen };
};

/** Starts a rest after the workout's first exercise, as marking a set done does. */
const startRest = (store: Awaited<ReturnType<typeof openWorkout>>["store"]) => {
  const activityExercise = store.currentWorkout()!.exercises[0]!.row;
  rest.timer = {
    endsAt: Date.now() + 102_000,
    totalS: 120,
    exercise: "Barbell Squat",
    activityId: activityExercise.activityId,
    activityExerciseId: activityExercise.id,
  };
};

/** Whether a span shows whole between the navigation bar and what covers the workout. */
const clear = (span: { top: number; bottom: number }, covered: number) =>
  span.top >= HEADER && span.bottom <= SCREEN_HEIGHT - covered;

let opened: Awaited<ReturnType<typeof openWorkout>> | null = null;
let tree: ReactTestRenderer | null = null;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  act(() => tree?.unmount());
  tree = null;
  rest.timer = null;
  set = SET;
  await opened?.runtime.dispose();
  opened?.database.close();
  opened = null;
});

describe("the workout at the largest text size", () => {
  it("keeps the set being typed into on screen above the keypad and the rest timer", async () => {
    opened = await openWorkout();
    screen.offset = -HEADER;
    screen.scrolls = [];
    const { WorkoutScreen, store } = opened;
    act(() => {
      tree = create(<WorkoutScreen />, { createNodeMock: nodeMock });
    });
    const root = tree!.root;
    // The first set starts below where the keypad will be.
    expect(shownAt(0).bottom).toBeGreaterThan(SCREEN_HEIGHT - KEYPAD);

    press(root, "set-0-0-weight");
    layOutCover(root, KEYPAD);
    expect(shownAt(0).top).toBeGreaterThanOrEqual(HEADER);
    expect(shownAt(0).bottom).toBeLessThanOrEqual(SCREEN_HEIGHT - KEYPAD);

    // Next goes to the reps, then on to the second set.
    press(root, "keypad-next");
    press(root, "keypad-next");
    expect(root.find(byTestID("set-0-1-weight")).props.accessibilityState).toEqual({
      selected: true,
    });
    expect(shownAt(1).top).toBeGreaterThanOrEqual(HEADER);
    expect(shownAt(1).bottom).toBeLessThanOrEqual(SCREEN_HEIGHT - KEYPAD);

    // The rest timer appears above the keypad, as it does when a set is marked done.
    startRest(store);
    act(() => tree!.update(<WorkoutScreen />));
    // It keeps to one row there, without the word "Rest" above the time.
    const texts = root
      .find(byTestID("rest-timer"))
      .findAll((node) => (node.type as unknown) === "Text")
      .map((node) => node.props.children);
    expect(texts).not.toContain("Rest");
    layOutCover(root, KEYPAD + COMPACT_REST);
    expect(shownAt(1).top).toBeGreaterThanOrEqual(HEADER);
    expect(shownAt(1).bottom).toBeLessThanOrEqual(SCREEN_HEIGHT - KEYPAD - COMPACT_REST);
    // The workout can scroll its last sets above them too.
    expect(root.find(byTestID("workout")).props.contentInset).toEqual({
      bottom: KEYPAD + COMPACT_REST - SAFE_BOTTOM,
    });

    // The rest going away leaves the set where it shows whole.
    const scrolled = screen.scrolls.length;
    press(root, "rest-timer-skip");
    act(() => tree!.update(<WorkoutScreen />));
    layOutCover(root, KEYPAD);
    expect(screen.scrolls).toHaveLength(scrolled);
    expect(shownAt(1).bottom).toBeLessThanOrEqual(SCREEN_HEIGHT - KEYPAD);
  });

  it("keeps the field being typed into on screen when its set is taller than the space left", async () => {
    set = TALL_SET;
    opened = await openWorkout();
    screen.offset = -HEADER;
    screen.scrolls = [];
    const { WorkoutScreen, store } = opened;
    act(() => {
      tree = create(<WorkoutScreen />, { createNodeMock: nodeMock });
    });
    const root = tree!.root;
    const selected = (id: string) =>
      expect(root.find(byTestID(id)).props.accessibilityState).toEqual({ selected: true });

    press(root, "set-0-0-weight");
    layOutCover(root, KEYPAD);
    expect(set.height).toBeGreaterThan(SCREEN_HEIGHT - KEYPAD - HEADER);
    expect(clear(fieldAt(0, "weight"), KEYPAD)).toBe(true);

    // Next within the set moves to its reps, lower in the same row.
    press(root, "keypad-next");
    selected("set-0-0-reps");
    expect(clear(fieldAt(0, "reps"), KEYPAD)).toBe(true);

    // The rest timer appearing shrinks the space, and the reps stay in it.
    startRest(store);
    act(() => tree!.update(<WorkoutScreen />));
    layOutCover(root, KEYPAD + COMPACT_REST);
    expect(clear(fieldAt(0, "reps"), KEYPAD + COMPACT_REST)).toBe(true);

    // Next across sets goes to the second set's weight.
    press(root, "keypad-next");
    selected("set-0-1-weight");
    expect(clear(fieldAt(1, "weight"), KEYPAD + COMPACT_REST)).toBe(true);

    // A press on a field below the space brings it up.
    press(root, "set-0-2-reps");
    selected("set-0-2-reps");
    expect(clear(fieldAt(2, "reps"), KEYPAD + COMPACT_REST)).toBe(true);

    // A key typed after the workout was scrolled away brings the field back.
    act(() => {
      screen.offset = -HEADER;
    });
    expect(clear(fieldAt(2, "reps"), KEYPAD + COMPACT_REST)).toBe(false);
    press(root, "key-5");
    expect(clear(fieldAt(2, "reps"), KEYPAD + COMPACT_REST)).toBe(true);

    // The rest going away leaves more room, and the field still shows.
    press(root, "rest-timer-skip");
    act(() => tree!.update(<WorkoutScreen />));
    layOutCover(root, KEYPAD);
    expect(clear(fieldAt(2, "reps"), KEYPAD)).toBe(true);
  });

  it("leaves the workout where it is when the set pressed already shows above the keypad", async () => {
    opened = await openWorkout();
    // Scrolled so the first set sits just below the navigation bar.
    screen.offset = FIRST_ROW - HEADER - 20;
    screen.scrolls = [];
    const { WorkoutScreen } = opened;
    act(() => {
      tree = create(<WorkoutScreen />, { createNodeMock: nodeMock });
    });
    const root = tree!.root;
    press(root, "set-0-0-reps");
    layOutCover(root, KEYPAD);
    expect(screen.scrolls).toEqual([]);
    expect(shownAt(0).bottom).toBeLessThanOrEqual(SCREEN_HEIGHT - KEYPAD);
  });
});
