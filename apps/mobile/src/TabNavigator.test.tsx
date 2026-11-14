import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { TABS } from "./tabs";
import { TabNavigator } from "./TabNavigator";

// Each navigator draws its screens in place, so the test sees which navigator
// draws each tab's title and with which options.
const { navigator } = vi.hoisted(() => ({
  navigator: (kind: string) => ({
    Navigator: ({ children, ...props }: { readonly children: ReactNode }) =>
      createElement(`${kind}Navigator`, props, children),
    Screen: ({ children, ...props }: { readonly children: () => ReactNode }) =>
      createElement(`${kind}Screen`, props, children()),
  }),
}));

vi.mock("@react-navigation/bottom-tabs", () => ({
  createBottomTabNavigator: () => navigator("Tab"),
}));
vi.mock("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: () => navigator("Stack"),
}));
vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("./progress/ProgressScreen", () => ({ ProgressScreen: () => "progress screen" }));
vi.mock("./PhoneChecksRow", () => ({ PhoneChecksRow: () => "phone checks row" }));
vi.mock("./gallery/DesignGalleryRow", () => ({ DesignGalleryRow: () => "design gallery row" }));
vi.mock("./exercises/ExerciseLibraryRow", () => ({
  ExerciseLibraryRow: () => "exercise library row",
}));
vi.mock("./ui/List", () => ({
  ListSection: ({ children }: { readonly children: ReactNode }) => children,
}));
vi.mock("./ui/AppText", () => ({
  AppText: ({ children }: { readonly children: ReactNode }) => createElement("Text", {}, children),
}));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const ofType = (root: ReactTestInstance, type: string) =>
  root.findAll((node) => node.type === type);

describe("TabNavigator", () => {
  it("titles every tab with a native large title, which grows with Dynamic Type", () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<TabNavigator />);
    });
    if (!tree) throw new Error("did not render");
    const tabs = ofType(tree.root, "TabNavigator")[0]!;
    // The tab navigator's header is fixed at 44 points and would clip a scaled title.
    expect(tabs.props.screenOptions).toMatchObject({ headerShown: false });
    const titles = ofType(tree.root, "TabScreen").map((tab) => {
      const [screen] = ofType(tab, "StackScreen");
      return [tab.props.name, screen?.props.options];
    });
    expect(titles).toEqual(
      TABS.map((tab) => [tab.name, { title: tab.name, headerLargeTitle: true }]),
    );
    const progress = ofType(tree.root, "TabScreen").find((tab) => tab.props.name === "Progress");
    expect(progress?.findAll((node) => node.children.includes("progress screen"))).not.toEqual([]);
  });
});
