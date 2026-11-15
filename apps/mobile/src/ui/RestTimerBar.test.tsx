import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { RestTimerBar } from "./RestTimerBar";

const screen = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
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

let tree: ReactTestRenderer | null = null;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

const pressed: Array<string> = [];

function renderAt(fontScale: number, compact: boolean) {
  screen.fontScale = fontScale;
  pressed.length = 0;
  act(() => {
    tree = create(
      <RestTimerBar
        left="1:42"
        leftLabel="1 minute 42 seconds"
        progress={102 / 120}
        onLess={() => pressed.push("less")}
        onMore={() => pressed.push("more")}
        onSkip={() => pressed.push("skip")}
        atBottom={!compact}
        compact={compact}
        testID="rest"
      />,
    );
  });
  return tree!.root;
}

const isHost = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;

const byTestID = (root: ReactTestInstance, testID: string) =>
  root.find((node) => typeof node.type === "string" && node.props.testID === testID);

/** What each control says to VoiceOver, in order. */
const controls = (root: ReactTestInstance) =>
  root
    .findAll((node) => isHost(node, "Pressable") || (isHost(node, "View") && node.props.accessible))
    .map((node) => `${node.props.accessibilityRole}: ${node.props.accessibilityLabel}`);

const texts = (node: ReactTestInstance) =>
  node.findAll((child) => isHost(child, "Text")).map((child) => child.props.children);

describe("RestTimerBar", () => {
  it("keeps to one row of time and Skip above the keypad at the largest text size", () => {
    const root = renderAt(LARGEST, true);
    expect(controls(root)).toEqual([
      "timer: Rest, 1 minute 42 seconds left",
      "button: 15 seconds less",
      "button: 15 seconds more",
      "button: Skip rest",
    ]);
    const time = byTestID(root, "rest-left");
    expect(texts(time)).toEqual(["1:42"]);
    // The time and the buttons share one row, which wraps rather than clips.
    const row = time.parent!;
    expect(row.props.className).toContain("flex-row");
    expect(row.props.className).toContain("flex-wrap");
    expect(row.children).toHaveLength(2);
    expect(texts(byTestID(root, "rest-skip"))).toEqual(["Skip"]);
    // The 15 seconds either way show as symbols, which stay at most twice their size.
    expect(
      [byTestID(root, "rest-less"), byTestID(root, "rest-more")].map(
        (button) => button.find((node) => isHost(node, "SymbolView")).props.name,
      ),
    ).toEqual(["gobackward.15", "goforward.15"]);

    // Each is a 44 point target that names what it does, though its symbol is smaller.
    expect(
      [byTestID(root, "rest-less"), byTestID(root, "rest-more")].map((button) => [
        button.props.accessibilityRole,
        button.props.accessibilityLabel,
        button.props.className.split(" ").filter((name: string) => name.endsWith("-target")),
      ]),
    ).toEqual([
      ["button", "15 seconds less", ["min-h-target", "min-w-target"]],
      ["button", "15 seconds more", ["min-h-target", "min-w-target"]],
    ]);

    for (const id of ["rest-less", "rest-more", "rest-skip"]) {
      act(() => byTestID(root, id).props.onPress());
    }
    expect(pressed).toEqual(["less", "more", "skip"]);
  });

  it("stacks the buttons under the time when the keypad is closed at the largest text size", () => {
    const root = renderAt(LARGEST, false);
    const time = byTestID(root, "rest-left");
    expect(texts(time)).toEqual(["Rest", "1:42"]);
    expect(time.parent!.props.className).toBe("gap-2");
    expect(texts(byTestID(root, "rest-less"))).toEqual(["−15"]);
  });

  it("keeps its usual row at standard text sizes, also above the keypad", () => {
    const root = renderAt(1, true);
    expect(texts(byTestID(root, "rest-left"))).toEqual(["Rest", "1:42"]);
    expect(texts(byTestID(root, "rest-more"))).toEqual(["+15"]);
    expect(controls(root)).toEqual([
      "timer: Rest, 1 minute 42 seconds left",
      "button: 15 seconds less",
      "button: 15 seconds more",
      "button: Skip rest",
    ]);
  });
});
