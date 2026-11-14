import { DEFAULT_BARS_AND_PLATES } from "@svett/core";
import type { ComponentProps } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { PlatesScreen } from "./PlatesScreen";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("@expo/ui/community/segmented-control", () => ({
  SegmentedControl: "NativeSegmentedControl",
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));
vi.mock("../settings/store", () => ({
  useWorkoutSettings: () => ({ unit: "lb", logRpe: false }),
}));
vi.mock("../settings/gear", () => ({
  useBarsAndPlates: () => ({ status: "ready", value: DEFAULT_BARS_AND_PLATES }),
  GearNotReady: () => null,
}));

type Props = ComponentProps<typeof PlatesScreen>;

const navigation = { navigate: () => undefined } as unknown as Props["navigation"];

/** The Plates screen as a link to `svett://tools/plates?kg=<kg>` opens it. */
const linkedTo = (kg: string) => (
  <PlatesScreen
    route={{ key: "Plates-1", name: "Plates", params: { kg } }}
    navigation={navigation}
  />
);

const byTestID = (id: string) => (node: ReactTestInstance) =>
  typeof node.type === "string" && node.props.testID === id;

const weight = (root: ReactTestInstance) =>
  root.find(byTestID("plates-weight")).props.accessibilityValue.text;

const press = (root: ReactTestInstance, id: string) =>
  act(() => root.find(byTestID(id)).props.onPress());

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

describe("the Plates screen", () => {
  it("shows the new weight, in pounds, when another link opens on the same screen", () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = create(linkedTo(String(225 * 0.45359237)));
    });
    if (!tree) throw new Error("did not render");
    const { root } = tree;
    expect(weight(root)).toBe("225 lb");

    act(() => tree!.update(linkedTo("100")));

    expect(weight(root)).toBe("220.46 lb");
    // The first key replaces the linked weight, as it does when the screen first opens.
    press(root, "key-2");
    expect(weight(root)).toBe("2 lb");
  });

  it("keeps what was typed while the link stays the same", () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = create(linkedTo("100"));
    });
    if (!tree) throw new Error("did not render");
    const { root } = tree;
    press(root, "key-2");
    press(root, "key-5");

    act(() => tree!.update(linkedTo("100")));

    expect(weight(root)).toBe("25 lb");
  });
});
