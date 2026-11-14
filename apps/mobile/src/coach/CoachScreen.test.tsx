import {
  type ChatGPTStatus,
  type CoachEvent,
  databaseLayer,
  Ids,
  libraryExerciseId,
  PLAN_LIMIT_CODE,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Layer, ManagedRuntime } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CoachScreen } from "./CoachScreen";

const app = vi.hoisted(() => ({
  runtime: undefined as unknown,
  status: (): Promise<unknown> => Promise.resolve(undefined),
  /** The events the stand-in for Swift streams for request n. */
  answer: (_number: number): ReadonlyArray<unknown> => [],
  requests: 0,
  focus: undefined as (() => void) | undefined,
  navigated: [] as Array<readonly [string, unknown]>,
  appState: undefined as ((state: string) => void) | undefined,
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_: string, listener: (state: string) => void) => {
      app.appState = listener;
      return { remove: () => {} };
    },
  },
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Linking: { openURL: () => Promise.resolve() },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("expo", () => ({ uuid: { v4: () => crypto.randomUUID() } }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    DarkTheme: {},
    useNavigation: () => ({
      navigate: (name: string, params: unknown) => app.navigated.push([name, params]),
      setParams: () => {},
    }),
    useRoute: () => ({ params: undefined }),
    useFocusEffect: (effect: () => void) => {
      useEffect(() => {
        app.focus = effect;
        effect();
      }, [effect]);
    },
  };
});
vi.mock("../chatgpt/native", () => ({ chatGPTStatus: () => app.status() }));
vi.mock("../data/database", () => ({ appDatabase: () => app.runtime }));
vi.mock("./native", async () => {
  const { Effect } = await import("effect");
  return {
    swiftTransport: {
      send: (_: unknown, onEvent: (event: unknown) => void) =>
        Effect.sync(() => {
          const events = app.answer(++app.requests);
          events.forEach(onEvent);
          return events;
        }),
    },
  };
});

const SIGNED_IN: ChatGPTStatus = {
  state: "signedIn",
  scope: "openid",
  planUsage: true,
  expiresAt: Date.UTC(2027, 0, 1),
};

const searchCall: CoachEvent = {
  type: "toolCall",
  callId: "call_1",
  name: "search_exercises",
  namespace: "svett",
  arguments: JSON.stringify({ query: "squat", limit: 3 }),
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
  app.status = () => Promise.resolve(SIGNED_IN);
  app.answer = () => [{ type: "text", delta: "Hello." }, { type: "done" }];
  app.requests = 0;
  app.navigated = [];
});

afterEach(() => (app.runtime as ManagedRuntime.ManagedRuntime<never, never>).dispose());

/** Lets the screen's promises and the database settle. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

async function open() {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<CoachScreen />);
  });
  await settle();
  if (!tree) throw new Error("did not render");
  return tree;
}

const byTestID = (tree: ReactTestRenderer, testID: string) =>
  tree.root.findAll((node) => typeof node.type === "string" && node.props.testID === testID);

const texts = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((node) => (node.type as string) === "Text")
    .flatMap((node: ReactTestInstance) => node.children)
    .filter((child): child is string => typeof child === "string");

async function send(tree: ReactTestRenderer, question: string) {
  const [field] = byTestID(tree, "coach-input");
  act(() => field!.props.onChangeText(question));
  const [button] = byTestID(tree, "coach-send");
  await act(async () => button!.props.onPress());
  await settle();
}

const proposeUpper = (exerciseId: string): CoachEvent => ({
  type: "toolCall",
  callId: "call_propose",
  name: "propose_routine",
  namespace: "svett",
  arguments: JSON.stringify({
    title: "Upper",
    exercises: [{ exerciseId, sets: [{ weightKg: 60, repsMin: 8, repsMax: 10 }] }],
  }),
});

const answerAfter = (call: CoachEvent) => (number: number) =>
  number === 1
    ? [call, { type: "done" }]
    : [{ type: "text", delta: "Here it is." }, { type: "done" }];

const pressables = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll(
    (node) => (node.type as string) === "Pressable" && node.props.accessibilityLabel === label,
  );

const sendDisabled = (tree: ReactTestRenderer) =>
  byTestID(tree, "coach-send")[0]!.props.disabled as boolean;

describe("CoachScreen", () => {
  it("shows that the sign-in could not be read, and opens the coach when Try again works", async () => {
    app.status = () => Promise.reject(new Error("module missing"));
    const tree = await open();
    expect(byTestID(tree, "coach-status-failed")).toHaveLength(1);
    expect(texts(tree)).not.toContain("Opening the coach…");
    app.status = () => Promise.resolve(SIGNED_IN);
    await act(async () => byTestID(tree, "coach-retry")[0]!.props.onPress());
    await settle();
    expect(byTestID(tree, "coach-status-failed")).toHaveLength(0);
    expect(byTestID(tree, "coach-composer")).toHaveLength(1);
  });

  it("keeps showing what a failed question read after the chat loads again", async () => {
    app.answer = (number) =>
      number === 1 ? [searchCall, { type: "done" }] : [{ type: "failed", code: "server_error" }];
    const tree = await open();
    await send(tree, "Best squat?");
    expect(byTestID(tree, "coach-failure-other")).toHaveLength(1);
    expect(texts(tree)).toContain('Read: Exercise search "squat" (3 found)');
    act(() => tree.unmount());
    const again = await open();
    expect(texts(again)).toContain("Best squat?");
    expect(texts(again)).toContain('Read: Exercise search "squat" (3 found)');
  });

  it("keeps Send off after the plan's limit until the next status check", async () => {
    app.answer = () => [{ type: "failed", code: PLAN_LIMIT_CODE }];
    const tree = await open();
    await send(tree, "Best squat?");
    expect(byTestID(tree, "coach-failure-planLimit")).toHaveLength(1);
    act(() => byTestID(tree, "coach-input")[0]!.props.onChangeText("And now?"));
    expect(sendDisabled(tree)).toBe(true);
    await act(async () => byTestID(tree, "coach-new")[0]!.props.onPress());
    expect(byTestID(tree, "coach-failure-planLimit")).toHaveLength(1);
    expect(sendDisabled(tree)).toBe(true);

    await act(async () => app.appState?.("active"));
    await settle();
    act(() => byTestID(tree, "coach-input")[0]!.props.onChangeText("And now?"));
    expect(sendDisabled(tree)).toBe(false);

    await send(tree, "And now?");
    expect(sendDisabled(tree)).toBe(true);
    await act(async () => app.focus?.());
    await settle();
    act(() => byTestID(tree, "coach-input")[0]!.props.onChangeText("Once more?"));
    expect(sendDisabled(tree)).toBe(false);
  });

  it("shows a routine the coach proposed under its answer, with Preview", async () => {
    app.answer = answerAfter(proposeUpper(libraryExerciseId("Barbell_Squat")));
    const tree = await open();
    await send(tree, "Plan a routine");
    expect(texts(tree)).toEqual(
      expect.arrayContaining([
        "Here it is.",
        "Upper",
        "A routine of 1 exercise",
        "Not applied. Nothing is saved until you tap Apply.",
      ]),
    );
    expect(byTestID(tree, "coach-proposal-error")).toHaveLength(0);
    const [preview] = pressables(tree, "Preview Upper");
    await act(async () => preview!.props.onPress());
    expect(app.navigated).toEqual([["Proposal", { id: expect.any(String) }]]);
  });

  it("says why svett refused a proposal with an exercise it does not have, and shows no card", async () => {
    app.answer = answerAfter(proposeUpper("019a0000-0000-7000-8000-00000000beef"));
    const tree = await open();
    await send(tree, "Plan a routine");
    const [refusal] = byTestID(tree, "coach-proposal-error");
    expect(refusal!.props.children).toBe(
      "svett refused a proposal from the coach, so nothing was saved. no exercise has the id 019a0000-0000-7000-8000-00000000beef. Find exercise ids with search_exercises, then propose again",
    );
    expect(pressables(tree, "Preview Upper")).toHaveLength(0);
  });
});
