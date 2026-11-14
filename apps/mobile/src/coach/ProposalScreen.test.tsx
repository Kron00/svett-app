import {
  createProposal,
  databaseLayer,
  Ids,
  libraryExerciseId,
  type ProposalPlan,
  RoutineRepository,
  trainOverview,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ProposalScreen } from "./ProposalScreen";

type HeaderItem = { readonly label: string; readonly onPress: () => void };

const app = vi.hoisted(() => ({
  runtime: undefined as unknown,
  id: "",
  items: (): ReadonlyArray<HeaderItem> => [],
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { hairlineWidth: 0.5 },
  Switch: "Switch",
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 3.1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useNavigation: () => ({
      setOptions: (options: { unstable_headerRightItems: () => ReadonlyArray<HeaderItem> }) => {
        app.items = options.unstable_headerRightItems;
      },
    }),
    useRoute: () => ({ params: { id: app.id } }),
    useFocusEffect: (effect: () => void) => {
      useEffect(effect, [effect]);
    },
  };
});
vi.mock("../data/database", () => ({ appDatabase: () => app.runtime }));

type Runtime = ManagedRuntime.ManagedRuntime<never, never>;
const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  (app.runtime as Runtime).runPromise(effect as Effect.Effect<A, E, never>);

const routine = (title: string) => ({
  title,
  notes: "",
  exercises: [
    {
      exerciseId: libraryExerciseId("Barbell_Squat"),
      restS: null,
      notes: "",
      sets: [
        {
          setType: "normal" as const,
          weightKg: 100,
          repsMin: 5,
          repsMax: 5,
          durationS: null,
          distanceM: null,
        },
      ],
    },
  ],
});

const program: ProposalPlan = {
  kind: "program",
  folder: "Split",
  routines: [routine("Day 1"), routine("Day 2"), routine("Day 3")],
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  const { driver } = openNodeDatabase();
  app.runtime = ManagedRuntime.make(
    Layer.provideMerge(
      databaseLayer(driver, Ids.layerSeeded(5)),
      manualClock(new Date(2026, 10, 14, 12).getTime()).layer,
    ),
  );
});

afterEach(() => (app.runtime as Runtime).dispose());

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

async function open(plan: ProposalPlan) {
  app.id = await run(createProposal(plan, null));
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<ProposalScreen />);
  });
  await settle();
  if (!tree) throw new Error("did not render");
  return tree;
}

const textOf = (tree: ReactTestRenderer, testID: string) =>
  tree.root.findAll((node) => (node.type as string) === "Text" && node.props.testID === testID)[0]
    ?.props.children as string | undefined;

const texts = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((node) => (node.type as string) === "Text")
    .flatMap((node: ReactTestInstance) => node.children)
    .filter((child): child is string => typeof child === "string");

const press = async (label: string) => {
  const item = app.items().find((each) => each.label === label);
  if (item === undefined) throw new Error(`no ${label} in the header`);
  await act(async () => item.onPress());
  await settle();
};

const trainTitles = () =>
  run(
    Effect.map(trainOverview, ({ sections }) =>
      sections.flatMap((section) => section.routines.map((each) => each.title)),
    ),
  );

describe("ProposalScreen", () => {
  it("previews each routine of a program with its sets, and Apply puts them on the Train tab", async () => {
    const tree = await open(program);
    expect(textOf(tree, "proposal-title")).toBe("Split");
    expect(textOf(tree, "proposal-status")).toBe(
      "Not applied. Nothing is saved until you tap Apply.",
    );
    expect(texts(tree)).toEqual(
      expect.arrayContaining(["Day 1", "Day 2", "Day 3", "Barbell Squat", "100 kg × 5 reps"]),
    );
    expect(app.items().map((item) => item.label)).toEqual(["Apply"]);
    expect(await trainTitles()).toEqual([]);

    await press("Apply");
    expect(textOf(tree, "proposal-status")).toBe("Applied. It is on the Train tab.");
    expect(app.items().map((item) => item.label)).toEqual(["Undo"]);
    expect(await trainTitles()).toEqual(["Day 1", "Day 2", "Day 3"]);

    await press("Undo");
    expect(textOf(tree, "proposal-status")).toBe("Undone. svett removed what Apply created.");
    expect(app.items()).toEqual([]);
    expect(await trainTitles()).toEqual([]);
  });

  it("refuses Undo after the routine was edited, says why, and keeps it", async () => {
    await open({ kind: "routine", routine: routine("Legs") });
    await press("Apply");
    await run(
      Effect.gen(function* () {
        const routines = yield* RoutineRepository;
        const [legs] = yield* routines.listRoutines;
        yield* routines.updateRoutine(legs!.id, { title: "Legs A" });
      }),
    );
    const tree = await (async () => {
      let rendered: ReactTestRenderer | undefined;
      await act(async () => {
        rendered = create(<ProposalScreen />);
      });
      await settle();
      return rendered!;
    })();
    await press("Undo");
    expect(textOf(tree, "proposal-problem")).toBe(
      "You changed this routine on the Train tab after Apply, so Undo would throw your changes away. Delete it there if you no longer want it.",
    );
    expect(textOf(tree, "proposal-status")).toBe("Applied. It is on the Train tab.");
    expect(await trainTitles()).toEqual(["Legs A"]);
  });
});
