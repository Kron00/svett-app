import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { OptionSheet } from "./OptionSheet";

vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

const OPTIONS = [
  { value: "chest", label: "Chest" },
  { value: "lats", label: "Lats" },
  { value: "triceps", label: "Triceps" },
] as const;
type Value = (typeof OPTIONS)[number]["value"];

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const render = (element: React.ReactElement) => {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(element);
  });
  if (!tree) throw new Error("did not render");
  return tree.root;
};

const rows = (root: ReactTestInstance) =>
  root.findAll(
    (node) => node.props.accessibilityRole === "button" && typeof node.type === "string",
  );
const press = (root: ReactTestInstance, label: string) => {
  const row = rows(root).find((node) => node.props.accessibilityLabel === label);
  if (!row) throw new Error(`no ${label} row`);
  act(() => row.props.onPress());
};

describe("OptionSheet", () => {
  it("chooses one option and closes, with a first row that clears the choice", () => {
    const onSelect = vi.fn<(value: Value | null) => void>();
    const onDismiss = vi.fn();
    const root = render(
      <OptionSheet
        title="Muscle"
        mode="single"
        noneLabel="All muscles"
        options={OPTIONS}
        selected="lats"
        onSelect={onSelect}
        isPresented
        onDismiss={onDismiss}
      />,
    );
    expect(root.findByType("Modal" as never).props).toMatchObject({
      visible: true,
      presentationStyle: "pageSheet",
    });
    expect(
      rows(root).map((row) => [row.props.accessibilityLabel, row.props.accessibilityState]),
    ).toEqual([
      ["Done", { disabled: false }],
      ["All muscles", { selected: false }],
      ["Chest", { selected: false }],
      ["Lats", { selected: true }],
      ["Triceps", { selected: false }],
    ]);
    for (const row of rows(root)) expect(row.props.className).toContain("min-h-target");

    press(root, "Chest");
    expect(onSelect).toHaveBeenLastCalledWith("chest");
    press(root, "All muscles");
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("toggles each of several options and stays open until Done", () => {
    const onSelect = vi.fn<(values: ReadonlyArray<Value>) => void>();
    const onDismiss = vi.fn();
    const root = render(
      <OptionSheet
        title="Other muscles"
        mode="multiple"
        options={OPTIONS}
        selected={["chest", "triceps"]}
        onSelect={onSelect}
        isPresented
        onDismiss={onDismiss}
      />,
    );
    press(root, "Lats");
    expect(onSelect).toHaveBeenLastCalledWith(["chest", "triceps", "lats"]);
    press(root, "Chest");
    expect(onSelect).toHaveBeenLastCalledWith(["triceps"]);
    expect(onDismiss).not.toHaveBeenCalled();
    press(root, "Done");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
