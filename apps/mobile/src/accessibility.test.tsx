import {
  ActivityRepository,
  DurationSeconds,
  EpochMillis,
  libraryExerciseId,
  MADE_HERE,
  RoutineRepository,
} from "@svett/core";
import { Effect, Option } from "effect";
import { createElement, type ComponentType, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import App from "./App";
import { unlabelledControls } from "./test-accessibility";
import { addExercises, startEmpty } from "./workout/actions";
import { currentWorkout } from "./workout/store";

type ScreenProps = {
  readonly name: string;
  readonly component?: ComponentType<{ readonly navigation: object; readonly route: object }>;
  readonly children?: () => ReactNode;
};

// The navigators record their screens instead of drawing them, so the test can draw each screen
// on its own, the way large-titles.test.tsx does, with a real database underneath.
const app = vi.hoisted(() => ({
  recorded: [] as Array<ScreenProps>,
  route: { key: "screen", name: "screen", params: {} as object },
  navigation: {
    addListener: () => () => {},
    canGoBack: () => true,
    dispatch: () => {},
    getParent: () => undefined,
    goBack: () => {},
    isFocused: () => true,
    navigate: () => {},
    pop: () => {},
    popTo: () => {},
    push: () => {},
    replace: () => {},
    reset: () => {},
    setOptions: () => {},
    setParams: () => {},
  },
  database: undefined as unknown,
  fontScale: 1,
}));

vi.mock("@react-navigation/native-stack", async () => {
  const { createElement: element } = await import("react");
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children }: { readonly children: ReactNode }) =>
        element("Navigator", null, children),
      Group: ({ children }: { readonly children: ReactNode }) => children,
      Screen: (props: ScreenProps) => {
        app.recorded.push(props);
        return null;
      },
    }),
  };
});
vi.mock("@react-navigation/bottom-tabs", () => ({
  createBottomTabNavigator: () => ({
    Navigator: ({ children }: { readonly children: ReactNode }) => children,
    Screen: ({ children }: { readonly children: () => ReactNode }) => children(),
  }),
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    DarkTheme: { colors: {}, fonts: {} },
    NavigationContainer: ({ children }: { readonly children: ReactNode }) => children,
    getFocusedRouteNameFromRoute: () => undefined,
    // Runs once when the screen appears, as React Navigation does on focus.
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => effect(), [effect]),
    useNavigation: () => app.navigation,
    useRoute: () => app.route,
  };
});
vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  return {
    AccessibilityInfo: { announceForAccessibility: () => {} },
    ActionSheetIOS: { showActionSheetWithOptions: () => {} },
    Alert: { alert: () => {} },
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Linking: { openURL: () => Promise.resolve(), getInitialURL: () => Promise.resolve(null) },
    // A modal draws its children only while it is open, as iOS does.
    Modal: ({ visible, children }: { readonly visible?: boolean; readonly children: ReactNode }) =>
      visible === false ? null : element("Modal", null, children),
    Platform: { OS: "ios", select: (choices: { readonly ios?: unknown }) => choices.ios },
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    Settings: { get: () => undefined, set: () => {} },
    StyleSheet: { hairlineWidth: 0.5, create: (styles: object) => styles },
    Switch: "Switch",
    Text: "Text",
    TextInput: "TextInput",
    View: "View",
    useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: app.fontScale }),
  };
});
// Draws every row it is given, so each row's controls are checked.
vi.mock("@legendapp/list/react-native", async () => {
  const { createElement: element } = await import("react");
  type Props = {
    readonly testID?: string;
    readonly data: ReadonlyArray<never>;
    readonly keyExtractor: (item: never) => string;
    readonly renderItem: (info: { readonly item: never; readonly index: number }) => ReactNode;
    readonly ListHeaderComponent?: ReactNode;
    readonly ListEmptyComponent?: ReactNode;
    readonly ListFooterComponent?: ReactNode;
  };
  return {
    LegendList: (props: Props) =>
      element(
        "LegendList",
        { testID: props.testID },
        props.ListHeaderComponent,
        props.data.length === 0 ? props.ListEmptyComponent : null,
        ...props.data.map((item, index) =>
          element("Item", { key: props.keyExtractor(item) }, props.renderItem({ item, index })),
        ),
        props.ListFooterComponent,
      ),
  };
});
vi.mock("../global.css", () => ({}));
vi.mock("../modules/svett-native", () => ({
  default: {
    launchedAt: 0,
    launchMarks: {},
    prewarmed: false,
    signedEntitlements: () => null,
    addListener: () => ({ remove: () => {} }),
  },
}));
vi.mock("expo", () => ({ uuid: { v4: () => crypto.randomUUID() } }));
vi.mock("expo-location", () => ({
  hasStartedLocationUpdatesAsync: async () => false,
  stopLocationUpdatesAsync: async () => undefined,
  getForegroundPermissionsAsync: async () => ({ granted: false, status: "undetermined" }),
  getBackgroundPermissionsAsync: async () => ({ granted: false, status: "undetermined" }),
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { Fitness: 3 },
}));
vi.mock("expo-task-manager", () => ({
  defineTask: () => undefined,
  isTaskRegisteredAsync: async () => false,
}));
vi.mock("expo-maps", () => ({ AppleMaps: { View: "AppleMapsView" } }));
vi.mock("react-native-svg", () => ({
  default: "Svg",
  Circle: "Circle",
  Line: "Line",
  Path: "Path",
  Polyline: "Polyline",
  Rect: "Rect",
}));
vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  File: class {
    exists = false;
  },
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: async () => ({ canceled: true }) }));
vi.mock("expo-sharing", () => ({ shareAsync: async () => undefined }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "0.1.0", nativeBuildVersion: "1" }));
vi.mock("expo-crypto", () => ({
  getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(bytes),
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock("expo-glass-effect", () => ({ GlassView: "GlassView" }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("expo-notifications", () => ({
  addNotificationReceivedListener: () => ({ remove: () => {} }),
  setNotificationHandler: () => {},
  getPermissionsAsync: async () => ({ granted: false, status: "undetermined" }),
  getLastNotificationResponse: () => null,
  getPresentedNotificationsAsync: async () => [],
  cancelScheduledNotificationAsync: async () => undefined,
}));
vi.mock("@expo/ui/swift-ui", () => ({
  BottomSheet: ({ children }: { readonly children: ReactNode }) => children,
  Group: ({ children }: { readonly children: ReactNode }) => children,
  Host: ({ children }: { readonly children: ReactNode }) => children,
  RNHostView: ({ children }: { readonly children: ReactNode }) => children,
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  presentationDragIndicator: () => ({}),
  presentationSizing: () => ({}),
}));
vi.mock("@expo/ui/community/segmented-control", () => ({
  SegmentedControl: "NativeSegmentedControl",
}));
vi.mock("@expo/ui/community/datetime-picker", () => ({ DateTimePicker: "DateTimePicker" }));
vi.mock("uniwind", () => ({
  useCSSVariable: () => "#000000",
  withUniwind: (component: unknown) => component,
}));
vi.mock("expo-sqlite", () => ({}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} },
}));
vi.mock("@clerk/expo", () => ({
  ClerkProvider: ({ children }: { readonly children: ReactNode }) => children,
  useAuth: () => ({ isLoaded: true, userId: null, getToken: async () => null }),
  useClerk: () => ({ signOut: async () => undefined }),
  useUser: () => ({ user: null }),
  useSignIn: () => ({ isLoaded: true }),
  useSignUp: () => ({ isLoaded: true }),
}));
vi.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));
// Accounts are set up and nobody is signed in, so Account offers sign-in and the social
// screens ask for it.
vi.mock("./account/config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
// The coach is signed in with plan usage, so it shows its chat.
vi.mock("./chatgpt/native", () => ({
  chatGPTStatus: async () => ({
    state: "signedIn",
    scope: "openid",
    planUsage: true,
    expiresAt: Date.now() + 3_600_000,
  }),
  renewChatGPT: async () => ({
    account: {
      state: "signedIn",
      scope: "openid",
      planUsage: true,
      expiresAt: Date.now() + 3_600_000,
    },
  }),
  signInWithChatGPT: () => new Promise(() => {}),
  pasteSignInAddress: async () => null,
  cancelSignIn: () => {},
  signOutOfChatGPT: () => new Promise(() => {}),
  forgetChatGPTAccount: () => new Promise(() => {}),
}));
vi.mock("./coach/native", () => ({ swiftTransport: {} }));
vi.mock("./data/database", () => ({}));
vi.mock("./data/current", async () => {
  const effect = await import("effect");
  const { databaseLayer, Ids } = await import("@svett/core");
  const { openNodeDatabase } = await import("@svett/core/node");
  const runtime = effect.ManagedRuntime.make(
    databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(11)),
  );
  const database = {
    owner: { kind: "anonymous" },
    handle: { target: { kind: "owner", owner: { kind: "anonymous" } }, runtime },
    version: 0,
  };
  app.database = database;
  return {
    appDatabase: () => runtime,
    currentDatabase: () => database,
    dataChanged: () => {},
    followSession: () => {},
    movePending: () => false,
    ownerOf: () => ({ kind: "anonymous" }),
    sameDatabase: (a: unknown, b: unknown) => a === b,
    sameOwner: () => true,
    databasesClosed: async () => {},
    prepareAppDatabase: () => {},
    reopenDatabase: () => {},
    sessionLapsed: () => false,
    signedOut: () => {},
    stillOpen: () => true,
    subscribeDatabase: () => () => {},
    switchOwner: () => {},
    useCurrentDatabase: () => database,
  };
});

beforeAll(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterAll(() => {
  vi.useRealTimers();
});

const runtime = () =>
  (app.database as { handle: { runtime: { runPromise: <A>(e: unknown) => Promise<A> } } }).handle
    .runtime;

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

/** Every native-stack screen in the app, with those of the navigators nested in a screen. */
const appScreens = async () => {
  app.recorded.length = 0;
  const shell = create(<App />);
  await settle();
  // Drawing a screen records the screens of any navigator inside it, which the loop then reaches.
  const all: Array<ScreenProps> = [];
  for (let index = 0; index < app.recorded.length; index++) {
    const screen = app.recorded[index];
    if (screen === undefined || all.some((seen) => seen.name === screen.name)) continue;
    all.push(screen);
    // Only the tab navigator holds navigators, one per tab.
    if (screen.name === "Tabs" && screen.component) {
      const component = screen.component;
      let drawn: ReactTestRenderer | undefined;
      act(() => {
        drawn = create(createElement(component, { navigation: app.navigation, route: app.route }));
      });
      drawn?.unmount();
    }
  }
  shell.unmount();
  return all;
};

const draw = async (screen: ScreenProps, params: object) => {
  app.route = { key: screen.name, name: screen.name, params };
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(
      screen.component
        ? createElement(screen.component, { navigation: app.navigation, route: app.route })
        : createElement(() => screen.children?.()),
    );
  });
  await settle();
  await settle();
  if (!tree) throw new Error(`${screen.name} did not render`);
  return tree;
};

const SQUAT = libraryExerciseId("Barbell_Squat");

/** A workout, a cardio entry and a routine, so screens draw rows, not only empty states. */
const seed = () =>
  runtime().runPromise<{ workout: string; cardio: string; set: string; routine: string }>(
    Effect.gen(function* () {
      const activities = yield* ActivityRepository;
      const routines = yield* RoutineRepository;
      const day = 86_400_000;
      const strength = yield* activities.create({
        kind: "strength",
        startedAt: EpochMillis.make(Date.now() - 2 * day),
        durationS: DurationSeconds.make(3_600),
        title: "Legs",
        notes: "",
        energyKcal: null,
        audience: "only_you",
        hiddenFields: [],
        origin: MADE_HERE,
        track: null,
        exercises: [
          {
            exerciseId: SQUAT,
            supersetGroup: null,
            notes: "",
            sets: [
              {
                setType: "normal",
                weightKg: 100,
                reps: 5,
                durationS: null,
                distanceM: null,
                rpe: null,
              },
            ],
          },
        ],
      });
      const cardio = yield* activities.create({
        kind: "run",
        startedAt: EpochMillis.make(Date.now() - day),
        durationS: DurationSeconds.make(1_800),
        title: "Morning run",
        notes: "",
        energyKcal: null,
        audience: "only_you",
        hiddenFields: [],
        origin: MADE_HERE,
        track: null,
        exercises: [],
      });
      const detail = Option.getOrNull(yield* activities.get(strength));
      const routine = yield* routines.createRoutine({
        folderId: null,
        title: "Push day",
        notes: "",
        position: 0,
        exercises: [{ exerciseId: SQUAT, supersetGroup: null, restS: null, notes: "", sets: [] }],
      });
      const set = detail?.exercises[0]?.sets[0]?.id ?? "";
      return { workout: strength, cardio, set, routine };
    }),
  );

type Seeded = Awaited<ReturnType<typeof seed>> & { readonly logged?: string };

/** Each screen's link parameters, so it draws what it is for, not a "not found". */
const paramsFor = (name: string, rows: Seeded | null): object => {
  const id = rows ?? { workout: "missing", cardio: "missing", set: "missing", routine: "missing" };
  const byName: Record<string, object> = {
    Activity: { id: id.cardio },
    Workout: { id: id.workout },
    SetEdit: { activityId: id.workout, setId: id.set },
    Exercise: { id: SQUAT },
    EditExercise: { id: SQUAT },
    ExerciseProgress: { exerciseId: SQUAT, range: "all" },
    Routine: { id: id.routine },
    EditRoutine: { id: id.routine },
    SetTarget: { exercise: "0", set: "0" },
    Proposal: { id: "missing" },
    UndoImport: { importBatchId: "missing" },
    Profile: { username: "anna" },
    Connections: { username: "anna", list: "followers" },
    Post: { id: "missing" },
    ReplaceWorkoutExercise: { exercise: rows?.logged ?? "missing" },
    WarmUp: { exercise: rows?.logged ?? "missing" },
    ImportPreview: { file: "missing.svett" },
    HealthImport: { file: "missing.zip" },
    Measurements: { kind: "body_weight", range: "all" },
  };
  return byName[name] ?? {};
};

/** The empty states on a screen that offer an action, by test ID. */
const emptyStatesWithAction = (root: ReactTestInstance) =>
  root
    .findAll(
      (node) =>
        typeof node.type === "string" &&
        typeof node.props.testID === "string" &&
        node.props.testID.endsWith("-empty") &&
        node.findAll((inner) => (inner.type as unknown) === "Pressable").length > 0,
    )
    .map((node) => String(node.props.testID));

const walk = async (rows: Seeded | null) => {
  const screens = await appScreens();
  const problems: Array<string> = [];
  const filled = new Map<string, ReadonlyArray<string>>();
  const controls = new Map<string, number>();
  for (const screen of screens) {
    // One screen at a time, because they share one database and one route.
    // oxlint-disable-next-line no-await-in-loop
    const tree = await draw(screen, paramsFor(screen.name, rows));
    problems.push(...unlabelledControls(tree.root).map((problem) => `${screen.name}: ${problem}`));
    filled.set(screen.name, emptyStatesWithAction(tree.root));
    controls.set(
      screen.name,
      tree.root.findAll((node) => (node.type as unknown) === "Pressable").length,
    );
    tree.unmount();
  }
  return { screens: screens.map((screen) => screen.name), problems, filled, controls };
};

let seeded: Seeded | undefined;

describe("every screen, for VoiceOver", () => {
  it("on a fresh install, labels every control and offers the action that fills each empty list", async () => {
    const { screens, problems, filled } = await walk(null);
    expect(screens).toEqual(expect.arrayContaining(["HomeRoot", "TrainRoot", "YouRoot"]));
    expect(screens.length).toBeGreaterThan(48);
    expect(problems).toEqual([]);
    expect(Object.fromEntries(filled)).toMatchObject({
      ProgressRoot: expect.arrayContaining(["history-empty", "records-empty"]),
      Calendar: ["calendar-empty"],
      Measurements: ["measurements-empty"],
      CoachRoot: ["coach-empty"],
    });
  });

  it("with workouts, a run and a routine, labels every control", async () => {
    seeded = await seed();
    const { problems } = await walk(seeded);
    expect(problems).toEqual([]);
  });

  it("at the largest text size, with a workout in progress, labels every control", async () => {
    await act(async () => {
      await startEmpty();
      addExercises([SQUAT]);
    });
    await settle();
    const logged = currentWorkout()?.exercises[0]?.row.id;
    expect(logged).toBeDefined();
    app.fontScale = 3.1;
    const { problems, controls } = await walk({ ...(seeded ?? (await seed())), logged });
    app.fontScale = 1;
    // The logger and the library drew their rows, so their controls were checked too.
    expect(controls.get("ActiveWorkout")).toBeGreaterThan(8);
    expect(controls.get("AddWorkoutExercise")).toBeGreaterThan(500);
    expect(problems).toEqual([]);
  });
});
