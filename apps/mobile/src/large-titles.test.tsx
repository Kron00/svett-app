import { createElement, type ComponentType, type ReactNode } from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import App from "./App";
import { TabNavigator } from "./TabNavigator";

type ScreenProps = {
  readonly name: string;
  readonly component?: ComponentType<{ readonly navigation: object; readonly route: object }>;
  readonly children?: () => ReactNode;
  readonly options?: object | ((props: object) => object);
};

// The navigators record their screens instead of drawing them, so the test can
// draw each large-title screen on its own and look at its first view.
const { screens, navigation } = vi.hoisted(() => ({
  screens: new Map<string, ScreenProps>(),
  navigation: { navigate: () => {}, setOptions: () => {}, setParams: () => {}, goBack: () => {} },
}));

vi.mock("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: () => ({
    Navigator: ({ children }: { readonly children: ReactNode }) => children,
    Screen: (props: ScreenProps) => {
      screens.set(props.name, props);
      return null;
    },
  }),
}));
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
  useRoute: () => ({ params: undefined }),
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
vi.mock("../modules/svett-native", () => ({ default: { launchedAt: 0 } }));
vi.mock("expo", () => ({ uuid: { v4: () => "00000000-0000-4000-8000-000000000000" } }));
// The coach stays on "Opening the coach" while its sign-in status is unread.
vi.mock("./chatgpt/native", () => ({ chatGPTStatus: () => new Promise(() => {}) }));
vi.mock("./coach/native", () => ({ swiftTransport: {} }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("expo-notifications", () => ({}));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("./data/store", () => ({ useQuery: () => ({ status: "loading" }) }));
vi.mock("./data/database", () => ({
  appDatabase: () => ({ runPromise: () => new Promise(() => {}) }),
}));
vi.mock("./transfer/files", () => ({
  exportAndShare: () => Promise.resolve(),
  pickImportFile: () => Promise.resolve(undefined),
  withTransfers: () => Promise.resolve([]),
}));
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

const largeTitleScreens = () => {
  screens.clear();
  draw(<App />);
  draw(<TabNavigator />);
  return [...screens.values()].filter((screen) => {
    const options =
      typeof screen.options === "function"
        ? screen.options({ navigation, route: { name: screen.name, params: {} } })
        : screen.options;
    return (options as { readonly headerLargeTitle?: boolean } | undefined)?.headerLargeTitle;
  });
};

describe("screens under a native large title", () => {
  // A large title makes the header translucent, so a screen's content starts under
  // the bar and a plain View draws under the title. The title collapses, and what
  // scrolls under the bar blurs, only for the scroll view UIKit tracks. It tracks
  // a scroll view that is the screen's first view, as in the design gallery, but
  // not a list inside a View, as on Progress.
  it("start with a scroll view that insets itself below the bar", () => {
    const found = largeTitleScreens();
    expect(found.map((screen) => screen.name).sort()).toEqual(
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
    const firstViews = found.map((screen) => {
      const content = screen.component
        ? createElement(screen.component, { navigation, route: { name: screen.name } })
        : screen.children?.();
      const first = firstView(draw(content).toJSON());
      return [screen.name, first?.type, first?.props.contentInsetAdjustmentBehavior];
    });
    expect(firstViews).toEqual(
      found.map((screen) => [
        screen.name,
        expect.stringMatching(/^(ScrollView|LegendList)$/),
        "automatic",
      ]),
    );
  });
});
