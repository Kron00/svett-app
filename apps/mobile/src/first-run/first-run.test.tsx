import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RootStackParamList } from "../navigation";

const phone = vi.hoisted(() => ({
  defaults: new Map<string, unknown>(),
  announced: [] as Array<string>,
}));
const navigation = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    announceForAccessibility: (text: string) => phone.announced.push(text),
  },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Settings: {
    get: (key: string) => phone.defaults.get(key),
    set: (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) phone.defaults.set(key, value);
    },
  },
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  phone.defaults.clear();
  phone.announced.length = 0;
  navigation.reset.mockClear();
});

const isHost = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const lines = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => isHost(node, "Text")).map(textOf);
const button = (tree: ReactTestRenderer, label: string) =>
  tree.root.find((node) => isHost(node, "Pressable") && node.props.accessibilityLabel === label);
const press = (tree: ReactTestRenderer, label: string) => {
  act(() => {
    button(tree, label).props.onPress();
  });
};

/** A launch of svett: the first run reads the phone's defaults afresh. */
const launch = async () => {
  vi.resetModules();
  const { FirstRunScreen } = await import("./FirstRunScreen");
  const { firstRunShown } = await import("./store");
  const props = {
    navigation,
    route: { key: "FirstRun", name: "FirstRun" },
  } as unknown as NativeStackScreenProps<RootStackParamList, "FirstRun">;
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(<FirstRunScreen {...props} />);
  });
  if (!tree) throw new Error("did not render");
  return { tree, shown: firstRunShown() };
};

const openedTrain = () =>
  expect(navigation.reset).toHaveBeenCalledWith({
    index: 0,
    routes: [{ name: "Tabs", params: { screen: "Train" } }],
  });

describe("the first run", () => {
  it("opens on a fresh install and says what svett is, where data lives, accounts and the coach", async () => {
    const { tree, shown } = await launch();
    expect(shown).toBe(true);
    const seen: Array<string> = [];
    for (let page = 1; page <= 4; page++) {
      expect(lines(tree)).toContain(`${page} of 4`);
      seen.push(...lines(tree));
      if (page < 4) press(tree, "Next");
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        "Lifting and cardio in one feed",
        "Your data stays on this phone",
        "An account is optional",
        "The coach runs on your ChatGPT plan",
      ]),
    );
    expect(seen.join(" ")).toMatch(/export all of it/);
    expect(seen.join(" ")).toMatch(/only for the feed and to sync/);
    expect(phone.announced).toEqual([
      "Your data stays on this phone",
      "An account is optional",
      "The coach runs on your ChatGPT plan",
    ]);
    expect(navigation.reset).not.toHaveBeenCalled();
    expect(phone.defaults.get("svettFirstRunSeen")).toBeUndefined();
  });

  it("ends on Train and is not shown at the next launch", async () => {
    const { tree } = await launch();
    for (let page = 1; page < 4; page++) press(tree, "Next");
    press(tree, "Start training");
    openedTrain();
    expect(phone.defaults.get("svettFirstRunSeen")).toBe(1);
    expect((await launch()).shown).toBe(false);
  });

  it("can be skipped from any page, which counts as seen", async () => {
    const { tree } = await launch();
    press(tree, "Next");
    press(tree, "Skip");
    openedTrain();
    expect((await launch()).shown).toBe(false);
  });

  it("asks for no sign-in and no permission", async () => {
    const { tree } = await launch();
    const labels = () =>
      tree.root
        .findAll((node) => isHost(node, "Pressable"))
        .map((node) => String(node.props.accessibilityLabel));
    const all = new Set<string>();
    for (let page = 1; page <= 4; page++) {
      for (const label of labels()) all.add(label);
      if (page < 4) press(tree, "Next");
    }
    expect([...all].sort()).toEqual(["Next", "Skip", "Start training"]);
  });

  it("stays out of the way of a proof script that launches with -svettFirstRun skip", async () => {
    phone.defaults.set("svettFirstRun", "skip");
    expect((await launch()).shown).toBe(false);
    phone.defaults.delete("svettFirstRun");
    expect((await launch()).shown).toBe(false);
  });
});
