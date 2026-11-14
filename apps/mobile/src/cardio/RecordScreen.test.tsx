import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { StartOutcome } from "./recorder";

const phone = vi.hoisted(() => ({
  outcome: { kind: "started" } as StartOutcome,
  announced: [] as Array<string>,
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    announceForAccessibility: (text: string) => phone.announced.push(text),
  },
  Alert: { alert: () => undefined },
  Linking: { openSettings: async () => undefined },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  // The largest accessibility text size.
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 3.12 }),
}));
vi.mock("@expo/ui/community/segmented-control", () => ({
  SegmentedControl: "NativeSegmentedControl",
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {}, useNavigation: () => ({}) }));
vi.mock("./recorder", async () => {
  const { createStore } = await import("../checks/store");
  return {
    recording: createStore(undefined),
    recordingProblem: createStore(undefined),
    startRecording: async () => phone.outcome,
    pauseRecording: async () => undefined,
    resumeRecording: async () => undefined,
    finishRecording: async () => undefined,
    discardRecording: async () => undefined,
  };
});

const { RecordScreen } = await import("./RecordScreen");

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const render = () => {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(<RecordScreen />);
  });
  if (!tree) throw new Error("did not render");
  return tree.root;
};

const isText = (node: ReactTestInstance) => (node.type as unknown) === "Text";

/** Every testID and text on the screen, top to bottom. */
const inOrder = (root: ReactTestInstance) =>
  root
    .findAll(
      (node) =>
        typeof node.type === "string" && (typeof node.props.testID === "string" || isText(node)),
    )
    .map((node) => (isText(node) ? String(node.props.children) : `#${node.props.testID}`));

const pressStart = async (root: ReactTestInstance) => {
  const start = root.find(
    (node) => (node.type as unknown) === "Pressable" && node.props.testID === "record-start",
  );
  await act(async () => start.props.onPress());
};

describe("the Record screen at the largest text size", () => {
  it("shows why Start failed under the sport picker, above Start, with the step and the reason", async () => {
    phone.outcome = { kind: "error", step: "location", message: "Location services are disabled" };
    const root = render();
    await pressStart(root);

    const text =
      "The recording did not start, at the location step. Location services are disabled";
    const problem = root.find((node) => node.props.testID === "record-start-problem-text");
    expect(problem.findByType("Text" as never).props.children).toBe(text);
    expect(
      root.find((node) => node.props.testID === "record-start-problem").props
        .accessibilityLiveRegion,
    ).toBe("polite");
    expect(phone.announced).toContain(text);

    const order = inOrder(root);
    const sports = order.lastIndexOf("Ride");
    const shown = order.indexOf(text);
    expect(sports).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(sports);
    expect(shown).toBeLessThan(order.indexOf("#record-start"));
    expect(order.slice(sports + 1, shown)).toEqual(["#record-start-problem"]);
  });

  it("puts a denied location above Start too, with the way to Settings", async () => {
    phone.outcome = { kind: "denied" };
    const root = render();
    await pressStart(root);

    const order = inOrder(root);
    const shown = order.indexOf(
      "svett needs your location to record a route. Allow it in Settings.",
    );
    expect(shown).toBeGreaterThan(order.lastIndexOf("Ride"));
    expect(order.indexOf("Open Settings")).toBeLessThan(order.indexOf("#record-start"));
  });

  it("clears the reason once Start works, and Start can be pressed again", async () => {
    phone.outcome = { kind: "error", step: "journal", message: "No space left on device" };
    const root = render();
    await pressStart(root);
    expect(root.findAll((node) => node.props.testID === "record-start-problem")).not.toHaveLength(
      0,
    );

    phone.outcome = { kind: "started" };
    await pressStart(root);
    expect(root.findAll((node) => node.props.testID === "record-start-problem")).toHaveLength(0);
    const start = root.find(
      (node) => (node.type as unknown) === "Pressable" && node.props.testID === "record-start",
    );
    expect(start.props.disabled).toBe(false);
  });
});
