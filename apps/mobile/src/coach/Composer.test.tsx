import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_MAX_LINES, Composer } from "./Composer";

const screen = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: screen.fontScale }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

/** React Native's font scale at iOS's largest accessibility text size. */
const LARGEST_FONT_SCALE = 3.571;
const BODY_LINE_HEIGHT = 22;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

function renderAt(fontScale: number) {
  screen.fontScale = fontScale;
  const onSend = vi.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(<Composer busy={false} onSend={onSend} />);
  });
  if (!tree) throw new Error("did not render");
  const root = tree.root;
  const byTestID = (testID: string) =>
    root.find((node) => typeof node.type === "string" && node.props.testID === testID);
  return {
    onSend,
    composer: byTestID("coach-composer"),
    field: byTestID("coach-input"),
    send: byTestID("coach-send"),
  };
}

describe("Composer", () => {
  it("at the largest text size, grows the question field with its text and stacks Send under it", () => {
    const { composer, field, send } = renderAt(LARGEST_FONT_SCALE);
    // In the stacked column a flex-1 field has a zero flex basis, so it sat at its 44 point
    // minimum and clipped the placeholder and the question.
    expect(composer.props.className).not.toContain("flex-row");
    expect(field.props.className.split(" ")).not.toContain("flex-1");
    expect(field.props.className).toContain("min-h-target");
    expect(field.props.style.height).toBeUndefined();
    expect(field.props.multiline).toBe(true);
    expect(field.props.scrollEnabled).not.toBe(false);
    // Several lines fit before it scrolls inside.
    expect(field.props.style.maxHeight).toBeGreaterThan(2 * BODY_LINE_HEIGHT * LARGEST_FONT_SCALE);
    expect(send.props.className).toContain("min-h-target");
  });

  it("at standard text sizes, sets Send beside a field that grows to five lines", () => {
    const { composer, field } = renderAt(1);
    expect(composer.props.className).toContain("flex-row");
    expect(field.props.className.split(" ")).toContain("flex-1");
    expect(field.props.style.maxHeight).toBeGreaterThanOrEqual(
      COMPOSER_MAX_LINES * BODY_LINE_HEIGHT,
    );
  });

  it("sends the trimmed question and clears the field", () => {
    const { onSend, field, send } = renderAt(LARGEST_FONT_SCALE);
    expect(send.props.disabled).toBe(true);
    act(() => field.props.onChangeText("  Best squat?  "));
    act(() => send.props.onPress());
    expect(onSend).toHaveBeenCalledWith("Best squat?");
    expect(field.props.value).toBe("");
  });
});
