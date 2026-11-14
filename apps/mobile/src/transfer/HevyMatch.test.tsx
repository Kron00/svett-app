import { type ExerciseId, suggestExercises } from "@svett/core";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { HevyMatch, type MatchExercise, type NameChoices } from "./HevyMatch";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Switch: "Switch",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const exercise = (
  name: string,
  equipment: MatchExercise["equipment"],
  muscle: MatchExercise["primaryMuscles"][number],
): MatchExercise => ({
  id: `id-${name}` as ExerciseId,
  name,
  equipment,
  primaryMuscles: [muscle],
  source: "library",
});

const EXERCISES: ReadonlyArray<MatchExercise> = [
  exercise("Seated Leg Curl (Machine)", "machine", "hamstrings"),
  exercise("Standing Leg Curl (Machine)", "machine", "hamstrings"),
  exercise("Leg Extension (Machine)", "machine", "quadriceps"),
  exercise("Prone Hamstring Curl", "machine", "hamstrings"),
  exercise("Skull Crusher", "barbell", "triceps"),
  exercise("Bench Press (Barbell)", "barbell", "chest"),
];

const byName = (name: string) => EXERCISES.find((each) => each.name === name)!;

const render = (name: string, onContinue: (choices: NameChoices) => void) => {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <HevyMatch
        names={[{ name, suggestions: suggestExercises(name, EXERCISES) }]}
        exercises={EXERCISES}
        onContinue={onContinue}
      />,
    );
  });
  if (!tree) throw new Error("did not render");
  return tree.root;
};

const pressable = (root: ReactTestInstance, testID: string) =>
  root.find((node) => (node.type as unknown) === "Pressable" && node.props.testID === testID);

const titles = (root: ReactTestInstance, prefix: string) =>
  root
    .findAll(
      (node) =>
        (node.type as unknown) === "Pressable" &&
        typeof node.props.testID === "string" &&
        node.props.testID.startsWith(prefix),
    )
    .map((node) => String(node.props.accessibilityLabel).split(",")[0]);

describe("HevyMatch", () => {
  it.each([
    {
      case: "ranks fourth",
      name: "Lying Leg Curl (Machine)",
      query: "prone",
      wanted: "Prone Hamstring Curl",
      rank: 3,
    },
    {
      case: "shares no words",
      name: "Skullcrusher (Barbell)",
      query: "skull",
      wanted: "Skull Crusher",
      rank: -1,
    },
  ])(
    "matches a name to an exercise that $case through the search",
    ({ name, query, wanted, rank }) => {
      const ranked = suggestExercises(name, EXERCISES, Infinity).map((each) => each.name);
      expect(ranked.indexOf(wanted)).toBe(rank);
      const onContinue = vi.fn<(choices: NameChoices) => void>();
      const root = render(name, onContinue);
      expect(titles(root, "match-0-")).not.toContain(wanted);

      const search = root.find(
        (node) => (node.type as unknown) === "TextInput" && node.props.testID === "match-0-search",
      );
      act(() => search.props.onChangeText(query));
      expect(titles(root, "match-0-result-")).toEqual([wanted]);
      act(() => pressable(root, "match-0-result-0").props.onPress());
      expect(pressable(root, "match-0-result-0").props.accessibilityState).toEqual({
        checked: true,
      });

      // The choice stays on screen, checked, once the search is cleared.
      act(() => search.props.onChangeText(""));
      expect(titles(root, "match-0-result-")).toEqual([]);
      expect(pressable(root, "match-0-chosen").props).toMatchObject({
        accessibilityLabel: expect.stringContaining(wanted),
        accessibilityState: { checked: true },
      });
      expect(pressable(root, "match-0-new").props.accessibilityState).toEqual({ checked: false });

      act(() => pressable(root, "match-continue").props.onPress());
      expect(onContinue).toHaveBeenCalledWith(new Map([[name, byName(wanted).id]]));
    },
  );

  it("keeps a new exercise as the choice until one is picked", () => {
    const onContinue = vi.fn<(choices: NameChoices) => void>();
    const root = render("Skullcrusher (Barbell)", onContinue);
    act(() => pressable(root, "match-continue").props.onPress());
    expect(onContinue).toHaveBeenCalledWith(new Map([["Skullcrusher (Barbell)", "new"]]));
  });
});
