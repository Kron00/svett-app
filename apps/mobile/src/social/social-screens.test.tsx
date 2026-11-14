import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ConnectionsScreen,
  EditProfileScreen,
  FollowRequestsScreen,
  PeopleScreen,
} from "./PeopleScreens";
import { ProfileScreen } from "./ProfileScreens";

type Answer = { readonly status: number; readonly body: unknown };

const app = vi.hoisted(() => ({
  route: { params: {} as Record<string, unknown> },
  signedIn: true,
  sent: [] as Array<string>,
  answers: new Map<string, Array<Answer>>(),
  navigated: [] as Array<string>,
  getToken: async () => "session-token",
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("../account/config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
vi.mock("../account/sync", () => ({ svettServer: () => "https://svett.test" }));
vi.mock("../progress/dates", () => ({ formatDay: (millis: number) => `day ${millis}` }));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({
    isLoaded: true,
    userId: app.signedIn ? "user_me" : null,
    getToken: app.getToken,
  }),
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  const navigation = {
    canGoBack: () => true,
    goBack: () => app.navigated.push("back"),
    navigate: (name: string) => app.navigated.push(name),
    push: (name: string, params: { username: string }) =>
      app.navigated.push(`${name} ${params.username}`),
  };
  return {
    useNavigation: () => navigation,
    useRoute: () => app.route,
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
  };
});

/** Answers `METHOD path` with each of `answers` in turn, keeping the last. */
const answer = (request: string, ...answers: Array<Answer>) => app.answers.set(request, answers);
const ok = (body: unknown): Answer => ({ status: 200, body });

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  app.signedIn = true;
  app.sent = [];
  app.answers.clear();
  app.navigated = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body: string | null }) => {
    const request = `${init.method} ${url.replace("https://svett.test", "")}`;
    app.sent.push(init.body === null ? request : `${request} ${init.body}`);
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

async function render(screen: React.ReactElement, shows: string) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(screen);
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

const profile = (overrides: Record<string, unknown>) => ({
  username: "Anna.K",
  private: true,
  self: false,
  followers: 3,
  following: 1,
  follow: "none",
  followsYou: false,
  activities: [],
  ...overrides,
});

describe("someone's profile", () => {
  beforeEach(() => {
    app.route.params = { username: "Anna.K" };
  });

  it("asks a private profile for approval, then shows the request", async () => {
    answer("GET /v1/profiles/Anna.K", ok(profile({})), ok(profile({ follow: "requested" })));
    answer("PUT /v1/profiles/Anna.K/follow", ok({ follow: "requested" }));
    const root = await render(<ProfileScreen />, "follow-button");
    expect(find(root, "follow-button").props.accessibilityLabel).toBe("Ask to follow");
    expect(texts(root)).toContain("Nothing shared with everyone yet. Followers may see more.");

    await press(root, "follow-button");
    await until(
      () => find(root, "follow-button").props.accessibilityLabel === "Requested",
      "the button saying Requested",
    );
    expect(app.sent).toEqual([
      "GET /v1/profiles/Anna.K",
      "PUT /v1/profiles/Anna.K/follow",
      "GET /v1/profiles/Anna.K",
    ]);
  });

  it("shows the activities the server sent, and says when a start time is hidden", async () => {
    answer(
      "GET /v1/profiles/Anna.K",
      ok(
        profile({
          follow: "following",
          followsYou: true,
          activities: [
            {
              id: "6f1c2a4e-93b0-4d5e-8a71-0c9e4b2d7f13",
              kind: "run",
              startedAt: null,
              durationS: 1800,
              title: "Easy run",
              notes: "",
              energyKcal: null,
              hiddenFields: ["start_time"],
            },
          ],
        }),
      ),
    );
    const root = await render(<ProfileScreen />, "activity-6f1c2a4e-93b0-4d5e-8a71-0c9e4b2d7f13");
    const row = find(root, "activity-6f1c2a4e-93b0-4d5e-8a71-0c9e4b2d7f13");
    expect(row.props.accessibilityLabel).toBe("Easy run, Run · 30 min · Start time hidden");
    expect(texts(root)).toContain("Private profile · Follows you");
    expect(find(root, "follow-button").props.accessibilityLabel).toBe("Following");
  });

  it("says why it did not load", async () => {
    answer("GET /v1/profiles/Anna.K", { status: 404, body: { error: "not_found" } });
    const root = await render(<ProfileScreen />, "profile-failed");
    expect(texts(root)).toContain("Nobody has that username.");
  });

  it("asks a signed-out person to sign in, and asks the server nothing", async () => {
    app.signedIn = false;
    const root = await render(<ProfileScreen />, "social-signed-out");
    expect(texts(root)).toContain("Sign in to use profiles");
    expect(app.sent).toEqual([]);
  });
});

describe("editing your profile", () => {
  const own = { username: null, private: true, followers: 0, following: 0, requests: 0 };

  it("refuses a username the rules refuse, without asking the server", async () => {
    app.route.params = { username: "ab" };
    answer("GET /v1/profile", ok(own));
    const root = await render(<EditProfileScreen />, "username-field");
    await press(root, "save-profile");
    expect(texts(root)).toContain("A username has at least 3 characters.");
    expect(app.sent).toEqual(["GET /v1/profile"]);
  });

  it("saves a username and the private choice, then goes back", async () => {
    app.route.params = {};
    answer("GET /v1/profile", ok(own));
    answer("PUT /v1/profile", ok({ ...own, username: "Anna.K", private: false }));
    const root = await render(<EditProfileScreen />, "username-field");
    await act(async () => {
      find(root, "username-field").props.onChangeText("Anna.K");
    });
    await press(root, "private-switch");
    await press(root, "save-profile");
    await until(() => app.navigated.includes("back"), "going back");
    expect(app.sent).toEqual([
      "GET /v1/profile",
      `PUT /v1/profile ${JSON.stringify({ username: "Anna.K", private: false })}`,
    ]);
  });

  it("says that going public approves the requests waiting", async () => {
    app.route.params = {};
    answer("GET /v1/profile", ok({ ...own, username: "Anna.K", requests: 2 }));
    const root = await render(<EditProfileScreen />, "username-field");
    expect(texts(root)).not.toContain("Saving approves");
    await press(root, "private-switch");
    expect(texts(root)).toContain("Saving approves 2 waiting requests.");
  });

  it("says when someone already has the username", async () => {
    app.route.params = { username: "taken" };
    answer("GET /v1/profile", ok(own));
    answer("PUT /v1/profile", { status: 409, body: { error: "username_taken" } });
    const root = await render(<EditProfileScreen />, "username-field");
    await press(root, "save-profile");
    await until(() => texts(root).includes("Someone already has that username."), "the problem");
    expect(app.navigated).toEqual([]);
  });
});

describe("finding people", () => {
  it("searches by the start of a username and opens a result", async () => {
    app.route.params = { q: "ann" };
    answer(
      "GET /v1/profiles?prefix=ann",
      ok({ profiles: [{ username: "Anna.K", private: true, follow: "requested" }] }),
    );
    const root = await render(<PeopleScreen />, "person-anna.k");
    expect(find(root, "person-anna.k").props.accessibilityLabel).toBe(
      "Anna.K, Private · Requested",
    );
    await press(root, "person-anna.k");
    expect(app.navigated).toEqual(["Profile Anna.K"]);
  });

  it("says when nobody's username starts with the text", async () => {
    app.route.params = { q: "zz" };
    answer("GET /v1/profiles?prefix=zz", ok({ profiles: [] }));
    const root = await render(<PeopleScreen />, "people-empty");
    expect(texts(root)).toContain("Nobody's username starts with “zz”.");
  });
});

const person = (username: string) => ({ username, private: true, follow: "none" });

describe("followers", () => {
  it("shows more followers a page at a time until the last page", async () => {
    app.route.params = { username: "Anna.K", list: "followers" };
    answer("GET /v1/profiles/Anna.K/followers", ok({ profiles: [person("ben")], next: "ben" }));
    answer(
      "GET /v1/profiles/Anna.K/followers?after=ben",
      ok({ profiles: [person("cara")], next: null }),
    );
    const root = await render(<ConnectionsScreen />, "person-ben");
    await press(root, "connections-more");
    await until(() => has(root, "person-cara"), "the second page");
    expect(has(root, "person-ben")).toBe(true);
    expect(has(root, "connections-more")).toBe(false);
    expect(app.sent).toEqual([
      "GET /v1/profiles/Anna.K/followers",
      "GET /v1/profiles/Anna.K/followers?after=ben",
    ]);
  });
});

describe("follow requests", () => {
  const BEN_REQUEST = "0190a0b2-0000-4000-8000-0000000000be";

  it("approves a request by its ID and reads the list again", async () => {
    app.route.params = {};
    answer(
      "GET /v1/follow-requests",
      ok({ requests: [{ id: BEN_REQUEST, username: "ben", private: true, follow: "none" }] }),
      ok({ requests: [] }),
    );
    answer(`PUT /v1/follow-requests/${BEN_REQUEST}`, ok({}));
    const root = await render(<FollowRequestsScreen />, "approve-ben");
    await press(root, "approve-ben");
    await until(() => has(root, "requests-empty"), "the empty list");
    expect(app.sent).toEqual([
      "GET /v1/follow-requests",
      `PUT /v1/follow-requests/${BEN_REQUEST}`,
      "GET /v1/follow-requests",
    ]);
  });

  it("declines a request by its ID and says when it is already gone", async () => {
    app.route.params = {};
    answer(
      "GET /v1/follow-requests",
      ok({ requests: [{ id: BEN_REQUEST, username: "ben", private: true, follow: "none" }] }),
    );
    answer(`DELETE /v1/follow-requests/${BEN_REQUEST}`, {
      status: 404,
      body: { error: "request_not_found" },
    });
    const root = await render(<FollowRequestsScreen />, "decline-ben");
    await press(root, "decline-ben");
    await until(
      () => texts(root).includes("That request was already answered or taken back."),
      "the message",
    );
    expect(app.sent).toEqual([
      "GET /v1/follow-requests",
      `DELETE /v1/follow-requests/${BEN_REQUEST}`,
    ]);
  });
});
