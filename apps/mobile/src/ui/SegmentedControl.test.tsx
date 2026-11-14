import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { SegmentedControl } from "./SegmentedControl";

const screen = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: screen.fontScale }),
}));
vi.mock("@expo/ui/community/segmented-control", () => ({
  SegmentedControl: "NativeSegmentedControl",
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

const OPTIONS = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
] as const;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

function renderAt(fontScale: number) {
  screen.fontScale = fontScale;
  const onSelect = vi.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SegmentedControl
        accessibilityLabel="Chart range"
        options={OPTIONS}
        selected="month"
        onSelect={onSelect}
      />,
    );
  });
  if (!tree) throw new Error("did not render");
  return { root: tree.root, onSelect };
}

describe("SegmentedControl", () => {
  it("uses the native control at standard text sizes", () => {
    const { root, onSelect } = renderAt(1.35);
    const native = root.findByType("NativeSegmentedControl" as never);
    expect(native.props.values).toEqual(["Week", "Month", "Year"]);
    expect(native.props.selectedIndex).toBe(1);
    expect(native.props.accessibilityLabel).toBe("Chart range");
    act(() => native.props.onChange({ nativeEvent: { selectedSegmentIndex: 2 } }));
    expect(onSelect).toHaveBeenCalledWith("year");
  });

  it("lists the options as selectable rows at accessibility text sizes", () => {
    const { root, onSelect } = renderAt(1.8);
    expect(root.findAllByType("NativeSegmentedControl" as never)).toHaveLength(0);

    const rows = root.findAll((node) => node.props.accessibilityRole === "button");
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual(["Week", "Month", "Year"]);
    expect(rows.map((row) => row.props.accessibilityState)).toEqual([
      { selected: false },
      { selected: true },
      { selected: false },
    ]);
    for (const row of rows) {
      expect(row.props.className).toContain("min-h-target");
      expect(row.findByType("Text" as never).props.children).toBe(row.props.accessibilityLabel);
    }

    const week = rows[0];
    if (!week) throw new Error("no rows");
    act(() => week.props.onPress());
    expect(onSelect).toHaveBeenCalledWith("week");
  });
});
