import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConnectedAppsScreen } from "./ConnectedAppsScreen";

type Answer = { readonly status: number; readonly body: unknown };
type AlertButton = {
  readonly text: string;
  readonly style?: string;
  readonly onPress?: () => void;
};

const app = vi.hoisted(() => ({
  signedIn: true,
  settings: {} as Record<string, unknown>,
  sent: [] as Array<string>,
  answers: new Map<string, Array<Answer>>(),
  alerts: [] as Array<{ readonly title: string; readonly buttons: ReadonlyArray<AlertButton> }>,
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, _message: string, buttons: ReadonlyArray<AlertButton>) =>
      app.alerts.push({ title, buttons }),
  },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Settings: { get: (key: string) => app.settings[key] },
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("../account/config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
vi.mock("../account/sync", () => ({ svettServer: () => "https://svett.test" }));
vi.mock("./AssistantProposals", () => ({ AssistantProposals: () => null }));
vi.mock("../progress/dates", () => ({
  formatDay: (millis: number) => `day ${millis}`,
  formatDayAndTime: (millis: number) => `time ${millis}`,
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({
    isLoaded: true,
    userId: app.signedIn ? "user_me" : null,
    getToken: async () => "session-token",
  }),
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  const navigation = { navigate: () => {} };
  return {
    useNavigation: () => navigation,
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
  };
});

const answer = (request: string, ...answers: Array<Answer>) => app.answers.set(request, answers);
const ok = (body: unknown): Answer => ({ status: 200, body });

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  app.signedIn = true;
  app.settings = {};
  app.sent = [];
  app.answers.clear();
  app.alerts = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body: string | null }) => {
    const request = `${init.method} ${url.replace("https://svett.test", "")}`;
    app.sent.push(request);
    const queued = app.answers.get(request);
    const next = queued && queued.length > 1 ? queued.shift() : queued?.[0];
    if (next === undefined) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
});

const rendered: Array<ReactTestRenderer> = [];
afterEach(async () => {
  await act(async () => {
    for (const tree of rendered.splice(0)) tree.unmount();
  });
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
async function until(done: () => boolean, what: string, tries = 0): Promise<void> {
  if (done()) return;
  if (tries > 100) throw new Error(`${what} never happened`);
  await settle();
  return until(done, what, tries + 1);
}

const byTestID = (id: string) => (node: ReactTestInstance) =>
  typeof node.type === "string" && node.props.testID === id;
const find = (root: ReactTestInstance, id: string) => root.find(byTestID(id));
const has = (root: ReactTestInstance, id: string) => root.findAll(byTestID(id)).length > 0;
const texts = (node: ReactTestInstance) =>
  node
    .findAll((each) => String(each.type) === "Text")
    .map((each) => [each.props.children].flat().join(""))
    .join("\n");

async function render(shows: string) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<ConnectedAppsScreen />);
  });
  if (!tree) throw new Error("did not render");
  rendered.push(tree);
  const root = tree.root;
  await until(() => has(root, shows), `showing ${shows}`);
  return root;
}

const press = (root: ReactTestInstance, id: string) =>
  act(async () => {
    find(root, id).props.onPress();
  });

const answerAlert = (label: string) =>
  act(async () => {
    const button = app.alerts.at(-1)?.buttons.find((each) => each.text === label);
    if (button === undefined) throw new Error(`No alert button ${label}`);
    button.onPress?.();
  });

const CHATGPT = {
  id: "c1",
  name: "ChatGPT",
  host: "chatgpt.com",
  scopes: ["svett.read"],
  createdAt: 100,
  lastReadAt: 200,
  recentAccess: [
    { id: "a2", tool: "list_workouts", at: 200 },
    { id: "a1", tool: "search_exercises", at: 150 },
  ],
};

describe("Connected apps", () => {
  it("lists each connection with what it may do, when it last read and its recent access", async () => {
    answer(
      "GET /v1/connections",
      ok({
        connections: [
          CHATGPT,
          {
            ...CHATGPT,
            id: "c2",
            name: "Other",
            scopes: ["svett.propose"],
            lastReadAt: null,
            recentAccess: [],
          },
        ],
      }),
    );
    const root = await render("connection-c1");
    expect(texts(find(root, "connection-c1"))).toBe(
      [
        "ChatGPT",
        "chatgpt.com",
        "Read your training",
        "Last read your data on time 200",
        "Connected on day 100",
        "Recent access",
        "Listed workouts",
        "time 200",
        "Searched exercises",
        "time 150",
        "Revoke",
      ].join("\n"),
    );
    expect(has(root, "connection-c2-recent")).toBe(false);
    expect(texts(find(root, "connection-c2-read"))).toBe("Has not read your data yet");
    expect(texts(find(root, "connection-c2-access"))).toBe("Propose routines and programs");
    expect(find(root, "revoke-c1").props.accessibilityLabel).toBe("Revoke ChatGPT");
    expect(texts(find(root, "connected-apps-address"))).toBe("https://svett.test/mcp");
  });

  it("revokes only after asking, then reads the list again", async () => {
    answer("GET /v1/connections", ok({ connections: [CHATGPT] }), ok({ connections: [] }));
    answer("DELETE /v1/connections/c1", ok({ revoked: true }));
    const root = await render("connection-c1");
    await press(root, "revoke-c1");
    expect(app.alerts.map((alert) => alert.title)).toEqual(["Revoke ChatGPT?"]);
    expect(app.sent).toEqual(["GET /v1/connections"]);
    await answerAlert("Revoke access");
    await until(() => has(root, "connected-apps-empty"), "the empty list");
    expect(app.sent).toEqual([
      "GET /v1/connections",
      "DELETE /v1/connections/c1",
      "GET /v1/connections",
    ]);
  });

  it("asks someone signed out to sign in", async () => {
    app.signedIn = false;
    const root = await render("social-signed-out");
    expect(texts(root)).toContain("Sign in to connect apps");
    expect(app.sent).toEqual([]);
  });

  it("shows the proof's stand-in connection without the server, and revokes it", async () => {
    app.settings = { svettConnectionsStub: "one" };
    app.signedIn = false;
    const root = await render("connection-stand-in-chatgpt");
    expect(texts(find(root, "connection-stand-in-chatgpt-access"))).toBe(
      "Read your training and propose routines and programs",
    );
    expect(texts(find(root, "connection-stand-in-chatgpt-recent"))).toContain("Listed workouts");
    await press(root, "revoke-stand-in-chatgpt");
    await answerAlert("Revoke access");
    await until(() => has(root, "connected-apps-empty"), "the empty list");
    expect(app.sent).toEqual([]);
  });
});
