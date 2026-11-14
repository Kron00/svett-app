import {
  BaseNavigationContainer,
  createNavigatorFactory,
  getActionFromState,
  getStateFromPath,
  type NavigationContainerRef,
  StackRouter,
  useNavigationBuilder,
} from "@react-navigation/core";
import { databaseLayer, Ids } from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Layer, ManagedRuntime } from "effect";
import { createRef, type ReactNode } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { linking } from "../linking";
import type { RootStackParamList } from "../navigation";
import { ImportPreviewScreen } from "./ImportPreviewScreen";

const app = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("expo-glass-effect", () => ({
  GlassView: "GlassView",
  isLiquidGlassAvailable: () => false,
}));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
// The screen gets the real router, which @react-navigation/native re-exports from core.
vi.mock("@react-navigation/native", async () => ({
  ...(await import("@react-navigation/core")),
  DarkTheme: {},
}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-sharing", () => ({}));
// svett://import?file=<name> reads <name> from svett's documents, here the core test data.
vi.mock("expo-file-system", async () => {
  const { readFile } = await import("node:fs/promises");
  return {
    Paths: { cache: { uri: "file:///cache/" }, document: "documents" },
    File: class {
      readonly name: string;
      constructor(_folder: unknown, name: string) {
        this.name = name;
      }
      text() {
        return readFile(
          new URL(`../../../../packages/core/test-data/${this.name}`, import.meta.url),
          "utf8",
        );
      }
    },
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
    useCurrentDatabase: () => database,
    sameDatabase: (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b),
    stillOpen: () => true,
    subscribeDatabase: () => () => undefined,
  };
});

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { driver } = openNodeDatabase();
  app.runtime = ManagedRuntime.make(
    Layer.provideMerge(
      databaseLayer(driver, Ids.layerSeeded(3)),
      manualClock(new Date(2026, 10, 14, 12).getTime()).layer,
    ),
  );
});

afterAll(() => (app.runtime as ManagedRuntime.ManagedRuntime<never, never>).dispose());

/** A stack that shows only its top screen, on the same router as the app's native stack. */
function TopScreenStack(props: {
  readonly initialRouteName: string;
  readonly children: ReactNode;
}) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, props);
  return (
    <NavigationContent>{descriptors[state.routes[state.index]!.key]!.render()}</NavigationContent>
  );
}
const Home = () => null;
const Stack = createNavigatorFactory(TopScreenStack)();

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function until(done: () => boolean, what: string, tries = 0): Promise<void> {
  if (done()) return;
  if (tries > 400) throw new Error(`${what} never happened`);
  await settle();
  return until(done, what, tries + 1);
}

const byTestID = (id: string) => (node: ReactTestInstance) =>
  typeof node.type === "string" && node.props.testID === id;

const press = (root: ReactTestInstance, testID: string) =>
  act(async () => root.find(byTestID(testID)).props.onPress());

describe("ImportPreviewScreen", () => {
  it("starts a new preview when a link opens the file whose import result is on screen", async () => {
    const navigation = createRef<NavigationContainerRef<RootStackParamList>>();
    // What linking does with a svett:// link once the app is open.
    const openLink = (path: string) =>
      act(async () => {
        const action = getActionFromState(getStateFromPath(path, linking.config)!, linking.config);
        navigation.current!.dispatch(action!);
      });
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(
        <BaseNavigationContainer ref={navigation}>
          <Stack.Navigator initialRouteName="Tabs">
            <Stack.Screen name="Tabs" component={Home} />
            <Stack.Screen name="ImportPreview" component={ImportPreviewScreen} />
          </Stack.Navigator>
        </BaseNavigationContainer>,
      );
    });
    const root = tree!.root;
    const shows = (testID: string) => root.findAll(byTestID(testID)).length > 0;
    const link = "import?file=hevy-sample.csv&kind=hevy";

    await openLink(link);
    await until(() => shows("hevy-match"), "asking for the unknown names");
    await press(root, "match-continue");
    await until(() => shows("hevy-summary"), "showing the preview");
    await press(root, "import-apply");
    await until(() => shows("import-done"), "importing the sample");
    const screen = navigation.current!.getCurrentRoute()!.key;

    await openLink(link);
    expect(navigation.current!.getCurrentRoute()!.key).toBe(screen);
    await until(() => shows("import-nothing-new"), "previewing the same file again");
    expect(shows("import-done")).toBe(false);
    expect(shows("hevy-summary")).toBe(true);
  });
});
