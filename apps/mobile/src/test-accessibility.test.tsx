import { createElement as h, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { unlabelledControls } from "./test-accessibility";

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

// Host views by the names react-native's mocks give them in the screen tests.
const problemsIn = (element: ReactElement) => {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(element);
  });
  if (!tree) throw new Error("did not render");
  return unlabelledControls(tree.root);
};

describe("unlabelledControls", () => {
  it("passes a labelled button with a target, and a row whose one view holds the target", () => {
    expect(
      problemsIn(
        h(
          "View",
          null,
          h("Pressable", {
            accessibilityRole: "button",
            accessibilityLabel: "Save",
            className: "min-h-target",
          }),
          h(
            "Pressable",
            { accessibilityRole: "button", accessibilityLabel: "Bench press" },
            h("View", { className: "min-h-target flex-row" }),
          ),
          h("SymbolView", { name: "chevron.right", accessibilityElementsHidden: true }),
          h("View", { accessibilityLabel: "Bench press, 100 kg in June" }, h("Svg")),
        ),
      ),
    ).toEqual([]);
  });

  it("names each pressable missing a role, a label or a target, and unlabelled symbols, switches and charts", () => {
    expect(
      problemsIn(
        h(
          "View",
          { testID: "screen" },
          h("Pressable", {
            testID: "no-role",
            accessibilityLabel: "Save",
            className: "min-h-target",
          }),
          h("Pressable", {
            testID: "no-label",
            accessibilityRole: "button",
            className: "min-h-key",
          }),
          h("Pressable", {
            testID: "small",
            accessibilityRole: "button",
            accessibilityLabel: "Tiny",
          }),
          h("Switch", { testID: "switch" }),
          h("SymbolView", { name: "trophy.fill" }),
          h("Svg"),
          h("View", { accessibilityElementsHidden: true }, h("Pressable", { testID: "hidden" })),
        ),
      ),
    ).toEqual([
      "#no-role has no role",
      "#no-label has no label",
      "#small has no 44 point target",
      "#switch has no label",
      "the symbol trophy.fill under #screen is neither labelled nor hidden",
      "a Svg under #screen has no text summary",
    ]);
  });
});
