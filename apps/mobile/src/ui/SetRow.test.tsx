import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { SetRow, type SetRowColumn, type SetRowField } from "./SetRow";

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

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const POUNDS_AND_REPS: ReadonlyArray<SetRowColumn> = [
  { title: "LB", wide: true },
  { title: "REPS", wide: false },
];

const field = (name: string, placeholder: string, unit: string): SetRowField => ({
  name,
  value: "",
  placeholder,
  unit,
  testID: `field-${name}`,
});

function renderAt(
  fontScale: number,
  fields: ReadonlyArray<SetRowField>,
  columns: ReadonlyArray<SetRowColumn>,
) {
  screen.fontScale = fontScale;
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SetRow
        setType="normal"
        normalSetNumber={1}
        previous="132.28 lb × 8"
        columns={columns}
        fields={fields}
        done={false}
        onPressSetType={() => {}}
        onPressField={() => {}}
        onToggleDone={() => {}}
        testID="set"
      />,
    );
  });
  if (!tree) throw new Error("did not render");
  return tree.root;
}

const isHost = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;

const byTestID = (root: ReactTestInstance, testID: string) =>
  root.find((node) => typeof node.type === "string" && node.props.testID === testID);

/** The nearest View around `node`. */
const viewAround = (node: ReactTestInstance): ReactTestInstance => {
  const parent = node.parent;
  if (parent === null) throw new Error("no View around it");
  return isHost(parent, "View") ? parent : viewAround(parent);
};

/** The test IDs of the controls on each line below the set's badge, in order. */
const linesOf = (root: ReactTestInstance) =>
  root
    .findAll((node) => isHost(node, "View") && node.props.testID === "set-row-line")
    .map((line) =>
      line.findAll((node) => isHost(node, "Pressable")).map((node) => String(node.props.testID)),
    );

describe("SetRow", () => {
  it("gives a pound weight a line of its own at the largest text size, so it never wraps", () => {
    const root = renderAt(
      LARGEST,
      [field("weight", "132.28", "lb"), field("reps", "8", "reps")],
      POUNDS_AND_REPS,
    );
    expect(linesOf(root)).toEqual([["field-weight"], ["field-reps", "set"]]);
    const weight = byTestID(root, "field-weight");
    expect(viewAround(weight).props.className).toBe("flex-1");
    expect(weight.props.accessibilityValue).toEqual({ text: "Empty" });
    const shown = weight.findAll((node) => isHost(node, "Text")).map((node) => node.props.children);
    expect(shown).toEqual(["132.28", "lb"]);
  });

  it("keeps the done box beside the last wide field when no narrow field follows", () => {
    const root = renderAt(
      LARGEST,
      [field("distance", "5000", "m"), field("time", "25:00", "")],
      [
        { title: "METRES", wide: true },
        { title: "TIME", wide: true },
      ],
    );
    expect(linesOf(root)).toEqual([["field-distance"], ["field-time", "set"]]);
  });

  it("keeps every field on the badge's line at standard text sizes", () => {
    const root = renderAt(
      1,
      [field("weight", "132.28", "lb"), field("reps", "8", "reps")],
      POUNDS_AND_REPS,
    );
    expect(linesOf(root)).toEqual([]);
    const row = viewAround(viewAround(byTestID(root, "field-weight")));
    expect(
      row.findAll((node) => isHost(node, "Pressable")).map((node) => node.props.testID),
    ).toEqual(["set-type", "field-weight", "field-reps", "set"]);
  });
});
