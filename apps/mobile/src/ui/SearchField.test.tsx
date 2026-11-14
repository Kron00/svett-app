import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { SearchField } from "./SearchField";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: (name: string) => name }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const render = (value: string, onChangeText = vi.fn()) => {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SearchField
        label="Search exercises"
        placeholder="Search"
        value={value}
        onChangeText={onChangeText}
      />,
    );
  });
  if (!tree) throw new Error("did not render");
  return tree.root;
};

const outline = (root: ReactTestInstance) =>
  root.find(
    (node) => (node.type as unknown) === "View" && node.props.className?.includes("absolute"),
  );

describe("SearchField", () => {
  it("is a labelled search field with a hairline edge that turns accent while focused", () => {
    const root = render("");
    const input = root.findByType("TextInput" as never);
    expect(input.props).toMatchObject({
      accessibilityRole: "search",
      accessibilityLabel: "Search exercises",
    });
    expect(outline(root).props.style).toMatchObject({
      borderWidth: 0.5,
      borderColor: "--color-separator",
    });
    act(() => input.props.onFocus());
    expect(outline(root).props.style).toMatchObject({
      borderWidth: 2,
      borderColor: "--color-accent",
    });
  });

  it("offers a 44 point clear button only when there is text", () => {
    expect(
      render("").findAll((node) => node.props.accessibilityLabel === "Clear search"),
    ).toHaveLength(0);
    const onChangeText = vi.fn();
    const clear = render("bench", onChangeText).find(
      (node) =>
        (node.type as unknown) === "Pressable" && node.props.accessibilityLabel === "Clear search",
    );
    expect(clear.props).toMatchObject({ accessibilityRole: "button" });
    expect(clear.props.className).toContain("min-h-target min-w-target");
    act(() => clear.props.onPress());
    expect(onChangeText).toHaveBeenCalledWith("");
  });
});
