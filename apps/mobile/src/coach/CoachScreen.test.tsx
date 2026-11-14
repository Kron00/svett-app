import {
  AccountId,
  ANONYMOUS,
  type ChatGPTStatus,
  type CoachEvent,
  CoachMessageRepository,
  databaseLayer,
  Ids,
  PLAN_LIMIT_CODE,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { switchOwner } from "../data/current";
import { CoachScreen } from "./CoachScreen";

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  /** The stand-in for Swift waits for this before it streams. */
  gate: Promise.resolve(),
  status: (): Promise<unknown> => Promise.resolve(undefined),
  /** The events the stand-in for Swift streams for request n. */
  answer: (_number: number): ReadonlyArray<unknown> => [],
  requests: 0,
  focus: undefined as (() => void) | undefined,
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
    useNavigation: () => ({ navigate: () => {}, setParams: () => {} }),
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
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} },
}));
vi.mock("../account/config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
// Each owner's file is an in-memory SQLite database that outlives its handles, as a file would.
vi.mock("../data/database", () => ({
  launchFixture: () => undefined,
  openDatabaseHandle: (target: { kind: string; owner?: { kind: string; accountId?: string } }) => ({
    target,
    get runtime() {
      return app.databases.get(target.owner?.accountId ?? target.owner?.kind ?? target.kind);
    },
    close: async () => {},
  }),
}));
vi.mock("./native", async () => {
  const effect = await import("effect");
  return {
    swiftTransport: {
      send: (_: unknown, onEvent: (event: unknown) => void) =>
        effect.Effect.promise(async () => {
          const number = ++app.requests;
          await app.gate;
          const events = app.answer(number);
          events.forEach(onEvent);
          return events;
        }),
    },
  };
});

const FIRST = AccountId.make("user_svett_first");
type Runtime = ManagedRuntime.ManagedRuntime<CoachMessageRepository, unknown>;

const openDatabase = (): Runtime => {
  const { driver } = openNodeDatabase();
  return ManagedRuntime.make(
    Layer.provideMerge(
      databaseLayer(driver, Ids.layerSeeded(5)),
      manualClock(new Date(2026, 10, 14, 12).getTime()).layer,
    ),
  );
};

const latestConversation = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(
      Effect.service(CoachMessageRepository),
      (messages) => messages.latestConversation,
    ),
  );

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
  app.databases.set("anonymous", openDatabase());
  app.databases.set(FIRST, openDatabase());
  switchOwner(ANONYMOUS);
  app.gate = Promise.resolve();
  app.status = () => Promise.resolve(SIGNED_IN);
  app.answer = () => [{ type: "text", delta: "Hello." }, { type: "done" }];
  app.requests = 0;
});

afterEach(() =>
  Promise.all([...app.databases.values()].map((runtime) => (runtime as Runtime).dispose())),
);

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

  it("opens the new owner's chat on a sign-in, and keeps an answer arriving for the previous one out of it", async () => {
    const gate = Promise.withResolvers<void>();
    app.gate = gate.promise;
    app.answer = () => [{ type: "text", delta: "Phone answer." }, { type: "done" }];
    const tree = await open();
    await send(tree, "Phone question?");
    expect(byTestID(tree, "coach-pending")).toHaveLength(1);

    await act(async () => switchOwner({ kind: "account", accountId: FIRST }));
    await settle();
    expect(texts(tree)).not.toContain("Phone question?");
    expect(byTestID(tree, "coach-pending")).toHaveLength(0);
    act(() => byTestID(tree, "coach-input")[0]!.props.onChangeText("Account question?"));
    expect(sendDisabled(tree)).toBe(false);

    await act(async () => gate.resolve());
    await settle();
    expect(texts(tree)).not.toContain("Phone question?");
    expect(texts(tree)).not.toContain("Phone answer.");
    expect(byTestID(tree, "coach-new")).toHaveLength(0);
    const account = app.databases.get(FIRST) as Runtime;
    expect(await latestConversation(account)).toBeNull();

    await act(async () => switchOwner(ANONYMOUS));
    await settle();
    expect(texts(tree)).toContain("Phone question?");
    expect(texts(tree)).toContain("Phone answer.");
  });
});
