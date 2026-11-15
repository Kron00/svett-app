import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { ListRow } from "./List";

const screen = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Switch: "Switch",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: screen.fontScale }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

// The largest accessibility text size, AX5.
const LARGEST = 3.1;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

function renderAt(fontScale: number) {
  screen.fontScale = fontScale;
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <ListRow
        title="Connected apps"
        value="1"
        icon={{ symbol: "link", color: "sport-walk" }}
        trailing={{ type: "chevron", onPress: () => {} }}
      />,
    );
  });
  if (!tree) throw new Error("did not render");
  return tree.root;
}

const isView = (node: ReactTestInstance) => (node.type as unknown) === "View";
const isIcon = (node: ReactTestInstance) =>
  (node.type as unknown) === "SymbolView" && node.props.name === "link";

/** The nearest View that holds both the row's icon and its title. */
const iconAndTitleBox = (root: ReactTestInstance) => {
  const symbol = root.find(isIcon);
  const title = root.find(
    (node) => (node.type as unknown) === "Text" && node.props.children === "Connected apps",
  );
  let box = symbol.parent;
  while (box !== null && !(isView(box) && box.findAll((node) => node === title).length > 0)) {
    box = box.parent;
  }
  if (box === null) throw new Error("no View holds both");
  return box;
};

describe("ListRow", () => {
  it("keeps the icon beside the title at the default text size", () => {
    expect(String(iconAndTitleBox(renderAt(1)).props.className)).toContain("flex-row");
  });

  it("puts the icon above the title at the largest text size, so the title gets the row's width", () => {
    const box = iconAndTitleBox(renderAt(LARGEST));
    expect(String(box.props.className)).not.toContain("flex-row");
    const [icon, text] = box.children as ReadonlyArray<ReactTestInstance>;
    expect(icon!.findAll(isIcon)).toHaveLength(1);
    expect(String(text!.props.className)).toContain("self-stretch");
  });
});
