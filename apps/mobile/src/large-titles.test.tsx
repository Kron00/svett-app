import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createElement, type ComponentType, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import App from "./App";

type Options = object | ((props: object) => object);

type ScreenProps = {
  readonly name: string;
  readonly component?: ComponentType<{ readonly navigation: object; readonly route: object }>;
  readonly children?: () => ReactNode;
  readonly options?: Options;
};

/** A screen as its navigator declared it, with the screenOptions above it, outermost first. */
type Recorded = { readonly screen: ScreenProps; readonly layers: ReadonlyArray<Options> };

// The navigators record their screens instead of drawing them, so the test can
// draw each screen on its own, look for navigators inside it, and look at the
// first view of each large-title screen.
const { recorded, navigation, stableRoute } = vi.hoisted(() => ({
  recorded: [] as Array<Recorded>,
  navigation: { navigate: () => {}, setOptions: () => {}, setParams: () => {}, goBack: () => {} },
  // One object, as React Navigation keeps it, so effects that depend on params run once.
  stableRoute: { key: "screen", params: {} },
}));

vi.mock("@react-navigation/native-stack", async () => {
  const { createContext, createElement: element, useContext } = await import("react");
  const Layers = createContext<ReadonlyArray<Options>>([]);
  type LayerProps = { readonly children: ReactNode; readonly screenOptions?: Options };
  const Layer = ({ children, screenOptions }: LayerProps) => {
    const outer = useContext(Layers);
    const layers = screenOptions === undefined ? outer : [...outer, screenOptions];
    return element(Layers.Provider, { value: layers }, children);
  };
  return {
    createNativeStackNavigator: () => ({
      // A navigator inside a screen does not inherit the outer navigator's screenOptions.
      Navigator: ({ children, screenOptions }: LayerProps) =>
        element(Layers.Provider, { value: [] }, element(Layer, { screenOptions, children })),
      Group: Layer,
      Screen: (props: ScreenProps) => {
        recorded.push({ screen: props, layers: useContext(Layers) });
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
vi.mock("@react-navigation/native", () => ({
  DarkTheme: { colors: {}, fonts: {} },
  NavigationContainer: ({ children }: { readonly children: ReactNode }) => children,
  getFocusedRouteNameFromRoute: () => undefined,
  useFocusEffect: () => {},
  useNavigation: () => navigation,
  useRoute: () => stableRoute,
}));
// A scroll view or list draws only itself, since the test checks which view comes first.
vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const childless =
    (type: string) =>
    ({ children: _children, ...props }: { readonly children?: ReactNode }) =>
      element(type, props);
  return {
    AccessibilityInfo: { announceForAccessibility: () => {} },
    ActionSheetIOS: { showActionSheetWithOptions: () => {} },
    Alert: { alert: () => {} },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Linking: { openURL: () => Promise.resolve() },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    Platform: { OS: "ios", select: (choices: { readonly ios?: unknown }) => choices.ios },
    Pressable: "Pressable",
    ScrollView: childless("ScrollView"),
    Settings: { get: () => undefined },
    StyleSheet: { hairlineWidth: 0.5, create: (styles: object) => styles },
    Text: "Text",
    TextInput: "TextInput",
    View: "View",
    useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
  };
});
vi.mock("@legendapp/list/react-native", async () => {
  const { createElement: element } = await import("react");
  return {
    LegendList: ({
      testID,
      contentInsetAdjustmentBehavior,
    }: {
      readonly testID?: string;
      readonly contentInsetAdjustmentBehavior?: string;
    }) => element("LegendList", { testID, contentInsetAdjustmentBehavior }),
  };
});
vi.mock("../global.css", () => ({}));
vi.mock("../modules/svett-native", () => ({ default: { launchedAt: 0, launchMarks: {} } }));
vi.mock("expo", () => ({ uuid: { v4: () => "00000000-0000-4000-8000-000000000000" } }));
// K1's recorder and map load native modules; the guard only needs them to import.
vi.mock("expo-location", () => ({
  hasStartedLocationUpdatesAsync: async () => false,
  stopLocationUpdatesAsync: async () => undefined,
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { Fitness: 3 },
}));
vi.mock("expo-task-manager", () => ({
  defineTask: () => undefined,
  isTaskRegisteredAsync: async () => false,
}));
vi.mock("expo-maps", () => ({ AppleMaps: { View: "AppleMapsView" } }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  File: class {
    exists = false;
  },
}));
// The coach stays on "Opening the coach" while its sign-in status is unread.
vi.mock("./chatgpt/native", () => ({ chatGPTStatus: () => new Promise(() => {}) }));
vi.mock("./coach/native", () => ({ swiftTransport: {} }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("expo-notifications", () => ({}));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("./data/store", () => ({ useQuery: () => ({ status: "loading" }) }));
vi.mock("./data/database", () => ({}));
// The database never opens, so every screen stays on its loading state.
vi.mock("./data/current", () => {
  const database = {
    owner: { kind: "anonymous" },
    handle: {
      target: { kind: "owner", owner: { kind: "anonymous" } },
      runtime: { runPromise: () => new Promise(() => {}) },
    },
  };
  return {
    appDatabase: () => database.handle.runtime,
    currentDatabase: () => database,
    dataChanged: () => {},
    followSession: () => {},
    movePending: () => false,
    sameDatabase: (a: unknown, b: unknown) => a === b,
    stillOpen: () => true,
    subscribeDatabase: () => () => {},
    useCurrentDatabase: () => database,
  };
});
vi.mock("./transfer/files", () => ({
  exportAndShare: () => Promise.resolve(),
  pickImportFile: () => Promise.resolve(undefined),
  withTransfers: () => Promise.resolve([]),
}));
vi.mock("expo-sqlite", () => ({}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} },
}));
vi.mock("@clerk/expo", () => ({
  ClerkProvider: ({ children }: { readonly children: ReactNode }) => children,
  useAuth: () => ({ isLoaded: false, userId: null }),
  useUser: () => ({ user: null }),
}));
vi.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));
vi.mock("./ui/OptionSheet", () => ({ OptionSheet: "OptionSheet" }));
vi.mock("./ui/Sheet", () => ({ Sheet: "Sheet" }));
vi.mock("./ui/SegmentedControl", () => ({ SegmentedControl: "SegmentedControl" }));
vi.mock("./ui/Chart", () => ({
  Chart: "Chart",
  ChartBars: "ChartBars",
  ChartGrid: "ChartGrid",
  ChartLine: "ChartLine",
}));
vi.mock("./ui/WorkoutBar", () => ({ WorkoutBar: "WorkoutBar" }));
// Screens without a large title are not drawn.
vi.mock("./chatgpt/ChatGPTScreen", () => ({ ChatGPTScreen: () => null }));
vi.mock("./chatgpt/ChatGPTRow", () => ({ ChatGPTRow: () => null }));
vi.mock("./account/AccountScreen", () => ({ AccountScreen: () => null }));
vi.mock("./account/AccountRow", () => ({ AccountRow: () => null }));
vi.mock("./checks/PhoneChecksScreen", () => ({ PhoneChecksScreen: () => null }));
vi.mock("./PhoneChecksRow", () => ({ PhoneChecksRow: () => null }));
vi.mock("./exercises/ExerciseDetailScreen", () => ({ ExerciseDetailScreen: () => null }));
vi.mock("./exercises/ExerciseFormScreen", () => ({
  EditExerciseScreen: () => null,
  NewExerciseScreen: () => null,
}));
vi.mock("./progress/CalendarScreen", () => ({ CalendarScreen: () => null }));
vi.mock("./progress/ExerciseProgressScreen", () => ({ ExerciseProgressScreen: () => null }));
vi.mock("./progress/ExercisesScreen", () => ({ ExercisesScreen: () => null }));
vi.mock("./progress/MeasurementsScreen", () => ({ MeasurementsScreen: () => null }));
vi.mock("./progress/MuscleSetsScreen", () => ({ MuscleSetsScreen: () => null }));
vi.mock("./progress/SetEditScreen", () => ({ SetEditScreen: () => null }));
vi.mock("./progress/WorkoutScreen", () => ({ WorkoutScreen: () => null }));
vi.mock("./transfer/ImportPreviewScreen", () => ({ ImportPreviewScreen: () => null }));
vi.mock("./transfer/UndoImportScreen", () => ({ UndoImportScreen: () => null }));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const draw = (node: ReactNode) => {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<>{node}</>);
  });
  if (!tree) throw new Error("did not render");
  return tree;
};

const firstView = (json: ReactTestRendererJSON | ReactTestRendererJSON[] | null) =>
  Array.isArray(json) ? json[0] : json;

const resolve = (options: Options | undefined, route: object) =>
  typeof options === "function" ? options({ navigation, route }) : options;

/** The options a screen ends up with: its navigator's and groups' screenOptions, then its own. */
const screenOptionsOf = ({ screen, layers }: Recorded) => {
  const route = { name: screen.name, params: {} };
  return Object.assign(
    {},
    ...layers.map((layer) => resolve(layer, route)),
    resolve(screen.options, route),
  ) as { readonly headerLargeTitle?: boolean };
};

const content = (screen: ScreenProps) =>
  screen.component
    ? createElement(screen.component, { navigation, route: { name: screen.name, params: {} } })
    : screen.children?.();

/** Every native-stack screen under `root`, including those of navigators nested in a screen. */
const allScreens = (root: ReactNode) => {
  recorded.length = 0;
  draw(root);
  // Drawing a screen records the screens of any navigator inside it, which this loop then reaches.
  for (let index = 0; index < recorded.length; index++) {
    const entry = recorded[index];
    if (entry) draw(content(entry.screen)).unmount();
  }
  return [...recorded];
};

const largeTitleScreens = (root: ReactNode) =>
  allScreens(root).filter((entry) => screenOptionsOf(entry).headerLargeTitle === true);

/** The large-title screens whose first view is not a scroll view that insets itself below the bar. */
const drawnUnderTheTitle = (found: ReadonlyArray<Recorded>) =>
  found
    .filter(({ screen }) => {
      const first = firstView(draw(content(screen)).toJSON());
      return !(
        (first?.type === "ScrollView" || first?.type === "LegendList") &&
        first.props.contentInsetAdjustmentBehavior === "automatic"
      );
    })
    .map(({ screen }) => screen.name);

// Small apps that show the guard finds what it must.
const Outer = createNativeStackNavigator();
const Inner = createNativeStackNavigator();
const Plain = () => <View />;
const Scrolls = () => <ScrollView contentInsetAdjustmentBehavior="automatic" />;

const nested = (component: ComponentType) => {
  const Nested = () => (
    <Inner.Navigator>
      <Inner.Screen name="Inside" component={component} options={{ headerLargeTitle: true }} />
    </Inner.Navigator>
  );
  return (
    <Outer.Navigator screenOptions={{ headerShown: false }}>
      <Outer.Screen name="Holder" component={Nested} />
    </Outer.Navigator>
  );
};

const fromScreenOptions = (component: ComponentType) => (
  <Outer.Navigator screenOptions={() => ({ headerLargeTitle: true })}>
    <Outer.Screen name="Titled" component={component} />
    <Outer.Screen name="Untitled" component={Plain} options={{ headerLargeTitle: false }} />
    <Outer.Group screenOptions={{ headerLargeTitle: false }}>
      <Outer.Screen name="Grouped" component={Plain} />
    </Outer.Group>
  </Outer.Navigator>
);

/** A navigator whose one screen sets no large title of its own. */
const Untitled = () => (
  <Inner.Navigator>
    <Inner.Screen name="Inside" component={Plain} />
  </Inner.Navigator>
);

describe("screens under a native large title", () => {
  // A large title makes the header translucent, so a screen's content starts under
  // the bar and a plain View draws under the title. The title collapses, and what
  // scrolls under the bar blurs, only for the scroll view UIKit tracks. It tracks
  // a scroll view that is the screen's first view, as in the design gallery, but
  // not a list inside a View, as on Progress.
  it("start with a scroll view that insets itself below the bar", () => {
    const found = largeTitleScreens(<App />);
    expect(found.map(({ screen }) => screen.name).sort()).toEqual(
      [
        "AddWorkoutExercise",
        "Data",
        "Exercises",
        "Gallery",
        "PickExercise",
        "Plates",
        "ReplaceWorkoutExercise",
        "WarmUp",
        "WorkoutSettings",
        "HomeRoot",
        "TrainRoot",
        "ProgressRoot",
        "CoachRoot",
        "YouRoot",
      ].sort(),
    );
    expect(drawnUnderTheTitle(found)).toEqual([]);
  });

  it("finds a large title in a navigator nested inside a screen", () => {
    const found = largeTitleScreens(nested(Plain));
    expect(found.map(({ screen }) => screen.name)).toEqual(["Inside"]);
    expect(drawnUnderTheTitle(found)).toEqual(["Inside"]);
    expect(drawnUnderTheTitle(largeTitleScreens(nested(Scrolls)))).toEqual([]);
  });

  it("finds a large title set in a navigator's screenOptions", () => {
    const found = largeTitleScreens(fromScreenOptions(Plain));
    expect(found.map(({ screen }) => screen.name)).toEqual(["Titled"]);
    expect(drawnUnderTheTitle(found)).toEqual(["Titled"]);
    expect(drawnUnderTheTitle(largeTitleScreens(fromScreenOptions(Scrolls)))).toEqual([]);
  });

  it("does not hand a navigator's screenOptions to a navigator nested inside it", () => {
    const found = largeTitleScreens(
      <Outer.Navigator screenOptions={{ headerLargeTitle: true }}>
        <Outer.Screen name="Holder" component={Untitled} options={{ headerLargeTitle: false }} />
      </Outer.Navigator>,
    );
    expect(found).toEqual([]);
  });
});
