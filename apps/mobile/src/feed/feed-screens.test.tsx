import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FeedScreen } from "./FeedScreen";
import { InboxScreen } from "./InboxScreen";
import { PostScreen } from "./PostScreen";

type Answer = { readonly status: number; readonly body: unknown };

const app = vi.hoisted(() => ({
  signedIn: true,
  sent: [] as Array<string>,
  answers: new Map<string, Array<Answer>>(),
  navigated: [] as Array<string>,
  options: {} as Record<string, unknown>,
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
vi.mock("react-native-svg", () => ({ default: "Svg", Polyline: "Polyline" }));
vi.mock("@legendapp/list/react-native", async () => {
  const { createElement } = await import("react");
  type Props = {
    readonly testID: string;
    readonly data: ReadonlyArray<never>;
    readonly keyExtractor: (item: never) => string;
    readonly renderItem: (info: { readonly item: never }) => ReactNode;
    readonly ListEmptyComponent: ReactNode;
    readonly ListFooterComponent: ReactNode;
    readonly onEndReached: () => void;
  };
  return {
    LegendList: (props: Props) =>
      createElement(
        "LegendList",
        { testID: props.testID, onEndReached: props.onEndReached },
        props.data.length === 0 ? props.ListEmptyComponent : null,
        ...props.data.map((item) =>
          createElement("Item", { key: props.keyExtractor(item) }, props.renderItem({ item })),
        ),
        props.ListFooterComponent,
      ),
  };
});
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("../account/config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
vi.mock("../account/sync", () => ({ svettServer: () => "https://svett.test" }));
vi.mock("../progress/dates", () => ({
  formatDay: (millis: number) => `day ${millis}`,
  formatDayAndTime: (millis: number) => `at ${millis}`,
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
  const navigation = {
    navigate: (name: string) => app.navigated.push(name),
    push: (name: string, params: Record<string, string>) =>
      app.navigated.push(`${name} ${Object.values(params).join(" ")}`),
    setOptions: (options: Record<string, unknown>) => Object.assign(app.options, options),
  };
  return {
    useNavigation: () => navigation,
    useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
  };
});

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
  app.options = {};
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

const LIFT_ID = "0196f000-5e4f-4000-8000-0000000000a1";
const RUN_ID = "0196f000-5e4f-4000-8000-0000000000a2";

const activity = (id: string, kind: string, title: string, hiddenFields: Array<string> = []) => ({
  id,
  kind,
  startedAt: hiddenFields.includes("start_time") ? null : 1_790_000_000_000,
  durationS: 1500,
  title,
  notes: "",
  energyKcal: null,
  hiddenFields,
});

const set = (position: number, setType: string, weightKg: number | null, reps: number) => ({
  position,
  setType,
  weightKg,
  reps,
  durationS: null,
  distanceM: null,
  rpe: null,
});

const liftingPost = {
  username: "anna",
  mine: false,
  audience: null,
  activity: activity(LIFT_ID, "strength", "Legs", ["weight"]),
  detail: {
    type: "lifting",
    exercises: [
      {
        position: 0,
        name: "Barbell Squat",
        sets: [set(0, "warm_up", null, 8), set(1, "normal", null, 5)],
      },
      { position: 1, name: "Leg Press", sets: [set(0, "normal", null, 10)] },
    ],
    split: [{ muscle: "quadriceps", sets: 2, percent: 100 }],
    volumeKg: null,
  },
  likes: 2,
  liked: false,
  comments: 1,
};

const runPost = {
  username: "me",
  mine: true,
  audience: "followers",
  activity: activity(RUN_ID, "run", "River loop"),
  detail: {
    type: "route",
    distanceM: 4440,
    elevationGainM: 18,
    paceSPerKm: 337.8,
    splits: [{ distanceM: 1000, endM: 1000, durationS: 330 }],
    route: [
      [
        { latitude: 59.952, longitude: 10.75 },
        { latitude: 59.96, longitude: 10.75 },
      ],
    ],
    averageHeartRateBpm: 151,
  },
  likes: 0,
  liked: false,
  comments: 0,
};

const inbox = (items: ReadonlyArray<unknown> = [], unread = 0) => ok({ items, next: null, unread });

describe("the feed", () => {
  it("shows a lifting post and a run each with their own detail", async () => {
    answer("GET /v1/feed", ok({ posts: [runPost, liftingPost], next: null }));
    answer("GET /v1/inbox", inbox([], 3));
    const root = await render(<FeedScreen />, `post-${LIFT_ID}`);
    expect(texts(find(root, `post-${LIFT_ID}`))).toContain("anna");
    expect(texts(find(root, `post-numbers-${LIFT_ID}`))).toBe(
      "2 exercises · 3 sets · Weight hidden",
    );
    expect(texts(find(root, `post-muscles-${LIFT_ID}`))).toBe("Quadriceps 100%");
    expect(texts(find(root, `post-${LIFT_ID}`))).toContain("Barbell Squat · 2 sets");
    expect(texts(find(root, `post-numbers-${RUN_ID}`))).toBe("4.44 km · 5:38 /km");
    expect(has(root, `post-route-${RUN_ID}`)).toBe(true);
    expect(texts(find(root, `post-${RUN_ID}`))).toContain("You");
    expect(find(root, `post-open-${RUN_ID}`).props.accessibilityLabel).toBe(
      "River loop, Run · 25 min · day 1790000000000 · Followers",
    );
    expect(texts(root)).toContain("You are all caught up.");

    type Item = { type: string; accessibilityLabel: string; badge?: unknown; onPress: () => void };
    const inboxButton = () =>
      (app.options.unstable_headerRightItems as (() => ReadonlyArray<Item>) | undefined)?.()[0];
    await until(() => inboxButton()?.accessibilityLabel === "Inbox, 3 unread", "the unread count");
    expect(inboxButton()).toMatchObject({ type: "button", badge: { value: 3 } });
    inboxButton()!.onPress();
    expect(app.navigated).toEqual(["Inbox"]);
  });

  it("likes a post once and shows the server's count", async () => {
    answer("GET /v1/feed", ok({ posts: [liftingPost], next: null }));
    answer("GET /v1/inbox", inbox());
    answer(`PUT /v1/posts/${LIFT_ID}/like`, ok({ likes: 3, liked: true }));
    const root = await render(<FeedScreen />, `post-like-${LIFT_ID}`);
    expect(find(root, `post-like-${LIFT_ID}`).props.accessibilityLabel).toBe("Like, 2");
    await press(root, `post-like-${LIFT_ID}`);
    await until(
      () => find(root, `post-like-${LIFT_ID}`).props.accessibilityLabel === "Liked, 3",
      "the like counted",
    );
    expect(app.sent).toContain(`PUT /v1/posts/${LIFT_ID}/like`);
  });

  it("loads the next page at the end of the list", async () => {
    answer("GET /v1/feed", ok({ posts: [runPost], next: "page-2" }));
    answer("GET /v1/feed?cursor=page-2", ok({ posts: [liftingPost], next: null }));
    answer("GET /v1/inbox", inbox());
    const root = await render(<FeedScreen />, `post-${RUN_ID}`);
    await act(async () => find(root, "feed").props.onEndReached());
    await until(() => has(root, `post-${LIFT_ID}`), "the second page");
  });

  it("asks for a username first", async () => {
    answer("GET /v1/feed", { status: 403, body: { error: "username_required" } });
    answer("GET /v1/inbox", inbox());
    const root = await render(<FeedScreen />, "feed-no-username");
    expect(texts(root)).toContain("Choose a username");
  });

  it("asks a signed-out person to sign in, and asks the server nothing", async () => {
    app.signedIn = false;
    const root = await render(<FeedScreen />, "social-signed-out");
    expect(texts(root)).toContain("Sign in to see your feed");
    expect(app.sent).toEqual([]);
  });
});

const props = (id: string) =>
  ({
    route: { key: "post", name: "Post", params: { id } },
    navigation: {
      setOptions: (options: Record<string, unknown>) => Object.assign(app.options, options),
    },
  }) as unknown as Parameters<typeof PostScreen>[0];

describe("a post", () => {
  it("shows a lifting post's sets and muscle split, and says what is hidden", async () => {
    answer(`GET /v1/posts/${LIFT_ID}`, ok({ post: liftingPost, comments: [] }));
    const root = await render(<PostScreen {...props(LIFT_ID)} />, "post-exercises");
    expect(texts(find(root, "post-hidden"))).toBe("anna hides weight.");
    expect(texts(find(root, "post-exercises"))).toContain("Barbell Squat");
    expect(
      find(root, "post-exercises")
        .findAll((node) => node.props.accessibilityLabel === "Set 1, 5 reps")
        .filter((node) => typeof node.type === "string"),
    ).toHaveLength(1);
    expect(has(root, "muscle-split")).toBe(true);
    expect(app.options.title).toBe("Legs");
  });

  it("shows a run's route, distance, pace and splits", async () => {
    answer(`GET /v1/posts/${RUN_ID}`, ok({ post: runPost, comments: [] }));
    const root = await render(<PostScreen {...props(RUN_ID)} />, "post-route");
    expect(find(root, "post-distance").props.accessibilityLabel).toBe("Distance, 4.44 km");
    expect(find(root, "post-pace").props.accessibilityLabel).toBe("Pace, 5:38 /km");
    expect(find(root, "post-split-1").props.accessibilityLabel).toBe("Split 1, 1.00 km, 5:30 /km");
    expect(has(root, "post-hidden")).toBe(false);
  });

  it("posts a comment as plain text and shows it", async () => {
    answer(`GET /v1/posts/${LIFT_ID}`, ok({ post: liftingPost, comments: [] }));
    answer(
      `POST /v1/posts/${LIFT_ID}/comments`,
      ok({ id: "c1", username: "me", body: "<b>Strong</b>", at: 5, canDelete: true }),
    );
    const root = await render(<PostScreen {...props(LIFT_ID)} />, "comment-field");
    await act(async () => find(root, "comment-field").props.onChangeText("<b>Strong</b>"));
    await press(root, "comment-send");
    await until(() => has(root, "comment-c1"), "the new comment");
    expect(texts(find(root, "comment-c1"))).toContain("<b>Strong</b>");
    expect(app.sent).toContain(`POST /v1/posts/${LIFT_ID}/comments {"body":"<b>Strong</b>"}`);
  });

  it("refuses an empty comment without asking the server", async () => {
    answer(`GET /v1/posts/${LIFT_ID}`, ok({ post: liftingPost, comments: [] }));
    const root = await render(<PostScreen {...props(LIFT_ID)} />, "comment-field");
    await act(async () => find(root, "comment-field").props.onChangeText("   "));
    expect(find(root, "comment-send").props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("says a post that is gone or no longer shared is not here", async () => {
    answer(`GET /v1/posts/${LIFT_ID}`, { status: 404, body: { error: "post_not_found" } });
    const root = await render(<PostScreen {...props(LIFT_ID)} />, "post-failed");
    expect(texts(root)).toContain("This post is not here.");
  });
});

describe("the inbox", () => {
  const items = [
    {
      kind: "comment",
      id: "i1",
      username: "ben",
      at: 30,
      unread: true,
      body: "Nice!",
      post: { username: "me", id: RUN_ID, kind: "run", title: "River loop", mine: true },
    },
    {
      kind: "follow_request",
      id: "i2",
      username: "cara",
      at: 20,
      unread: false,
    },
  ];

  it("lists what happened, marks unread items, then marks them read", async () => {
    answer("GET /v1/inbox", inbox(items, 1));
    answer("PUT /v1/inbox/read", ok({}));
    const root = await render(<InboxScreen />, "inbox-i1");
    expect(find(root, "inbox-i1").props.accessibilityLabel).toBe(
      "Unread, ben commented on your run River loop, Nice!, at 30",
    );
    expect(has(root, "inbox-unread-i1")).toBe(true);
    expect(has(root, "inbox-unread-i2")).toBe(false);
    await until(() => app.sent.includes('PUT /v1/inbox/read {"until":30}'), "marking read");

    await press(root, "inbox-i1");
    await press(root, "inbox-i2");
    expect(app.navigated).toEqual([`Post ${RUN_ID}`, "FollowRequests"]);
  });

  it("marks nothing read when nothing is unread", async () => {
    answer("GET /v1/inbox", inbox([{ ...items[1] }], 0));
    await render(<InboxScreen />, "inbox-i2");
    await settle();
    expect(app.sent).toEqual(["GET /v1/inbox"]);
  });
});
