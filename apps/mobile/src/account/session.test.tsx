import {
  AccountId,
  ActivityRepository,
  ANONYMOUS,
  type ActivityDraft,
  databaseLayer,
  DurationSeconds,
  encodeMoveJournal,
  EpochMillis,
  Ids,
  libraryExerciseId,
  MADE_HERE,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { currentDatabase, switchOwner } from "../data/current";
import { MOVE_UNFINISHED, write } from "../data/store";
import { AccountProvider } from "./AccountProvider";
import { AccountScreen } from "./AccountScreen";

type Runtime = ManagedRuntime.ManagedRuntime<ActivityRepository, unknown>;

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  clerk: {
    isLoaded: true,
    userId: null as string | null,
    signOut: async () => {},
  },
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => {} },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
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
vi.mock("expo-glass-effect", () => ({
  GlassView: "GlassView",
  isLiquidGlassAvailable: () => false,
}));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));
vi.mock("expo-sqlite", () => ({}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => app.storage.get(key) ?? null,
    setItemSync: (key: string, value: string) => app.storage.set(key, value),
    removeItemSync: (key: string) => app.storage.delete(key),
  },
}));
vi.mock("@clerk/expo", () => ({
  ClerkProvider: ({ children }: { readonly children: unknown }) => children,
  useAuth: () => app.clerk,
  useUser: () => ({ user: null }),
}));
vi.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));
vi.mock("./email-code", () => ({
  useEmailCode: () => ({ sendCode: async () => undefined, checkCode: async () => undefined }),
}));
vi.mock("./chatgpt-email", () => ({ chatGPTEmail: async () => ({ email: null }) }));
vi.mock("./config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
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

const FIRST = AccountId.make("user_svett_first");
const SECOND = AccountId.make("user_svett_second");
const T0 = Date.UTC(2026, 10, 1, 9);

const openDatabase = (seed: number): Runtime => {
  const { driver } = openNodeDatabase();
  return ManagedRuntime.make(
    Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(seed)), manualClock(T0).layer),
  );
};

const workout = (title: string): ActivityDraft => ({
  kind: "strength",
  startedAt: EpochMillis.make(T0 - 86_400_000),
  durationS: DurationSeconds.make(3_000),
  title,
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: [],
  origin: MADE_HERE,
  exercises: [
    {
      exerciseId: libraryExerciseId("Barbell_Squat"),
      supersetGroup: null,
      notes: "",
      sets: [
        { setType: "normal", weightKg: 100, reps: 5, durationS: null, distanceM: null, rpe: null },
      ],
    },
  ],
  track: null,
});

const logWorkout = (title: string) =>
  Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
    activities.create(workout(title)),
  );

const titles = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      Effect.map(activities.list(), (page) => page.map((activity) => activity.title)),
    ),
  );

let phone: Runtime;
let first: Runtime;
let second: Runtime;
let empty: Runtime;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(async () => {
  phone = openDatabase(1);
  first = openDatabase(2);
  second = openDatabase(3);
  empty = openDatabase(4);
  app.databases.set("anonymous", phone);
  app.databases.set(FIRST, first);
  app.databases.set(SECOND, second);
  app.databases.set("empty", empty);
  app.storage.clear();
  app.clerk.userId = null;
  app.clerk.signOut = async () => {
    app.clerk.userId = null;
  };
  switchOwner(ANONYMOUS);
  await phone.runPromise(logWorkout("Phone run"));
}, 60_000);

const rendered: Array<ReactTestRenderer> = [];

afterEach(async () => {
  await act(async () => {
    for (const tree of rendered.splice(0)) tree.unmount();
  });
  await Promise.all([phone.dispose(), first.dispose(), second.dispose(), empty.dispose()]);
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function until(done: () => boolean, what: string, tries = 0): Promise<void> {
  if (done()) return;
  if (tries > 200) throw new Error(`${what} never happened`);
  await settle();
  return until(done, what, tries + 1);
}

const byTestID = (id: string) => (node: ReactTestInstance) =>
  typeof node.type === "string" && node.props.testID === id;

const has = (root: ReactTestInstance, id: string) => root.findAll(byTestID(id)).length > 0;

const texts = (node: ReactTestInstance) =>
  node
    .findAll((each) => String(each.type) === "Text")
    .map((each) => [each.props.children].flat().join(""))
    .join("\n");

const press = (root: ReactTestInstance, id: string) =>
  act(async () => (root.find(byTestID(id)).props.onPress as () => void)());

const screen = () => (
  <AccountProvider>
    <AccountScreen />
  </AccountProvider>
);

async function mount(element: React.ReactElement) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(element);
  });
  if (tree === undefined) throw new Error("did not render");
  return tree;
}

/** Renders the Account screen under the session provider, as the app does. */
async function renderAccount() {
  const shown = await mount(screen());
  rendered.push(shown);
  return {
    root: shown.root,
    /** Clerk reports a new session state, and the app renders again. */
    session: async (userId: string | null) => {
      app.clerk.userId = userId;
      await act(async () => shown.update(screen()));
      await settle();
    },
  };
}

const ownerKind = () => currentDatabase().owner;
const isAnonymous = () => currentDatabase().owner.kind === "anonymous";

describe("a lapsed session", () => {
  beforeEach(() => {
    // The phone's data was kept apart on the first sign-in, so no move offer shows.
    app.storage.set("svett.moveJournal", encodeMoveJournal({ state: "declined" }));
  });

  it("keeps the account's database open and saves new workouts there", async () => {
    const { root, session } = await renderAccount();
    await session(FIRST);
    expect(ownerKind()).toEqual({ kind: "account", accountId: FIRST });

    await session(null);
    expect(ownerKind()).toEqual({ kind: "account", accountId: FIRST });
    await until(() => has(root, "session-lapsed"), "saying the sign-in lapsed");
    expect(texts(root)).toContain("Sign in again to sync");

    await write(logWorkout("Logged while lapsed"));
    expect(await titles(first)).toEqual(["Logged while lapsed"]);
    expect(await titles(phone)).toEqual(["Phone run"]);
  });

  it("opens the account's database again on an offline relaunch with no session", async () => {
    switchOwner({ kind: "account", accountId: FIRST });
    vi.resetModules();
    const relaunched = await import("../data/current");
    const store = await import("../data/store");
    relaunched.followSession(null);
    expect(relaunched.currentDatabase().owner).toEqual({ kind: "account", accountId: FIRST });
    await store.write(logWorkout("Logged offline"));
    expect(await titles(first)).toEqual(["Logged offline"]);
    expect(await titles(phone)).toEqual(["Phone run"]);
  });

  it("opens a separate database when a different account signs in after the lapse", async () => {
    const { root, session } = await renderAccount();
    await session(FIRST);
    await write(logWorkout("First's run"));
    await session(null);
    await session(SECOND);
    expect(ownerKind()).toEqual({ kind: "account", accountId: SECOND });
    expect(has(root, "session-lapsed")).toBe(false);
    expect(await titles(second)).toEqual([]);
    expect(await titles(first)).toEqual(["First's run"]);
  });

  it("opens the anonymous database when the person presses Sign out on the lapsed card", async () => {
    const { root, session } = await renderAccount();
    await session(FIRST);
    await session(null);
    await until(() => has(root, "lapsed-sign-out"), "offering to sign out");
    await press(root, "lapsed-sign-out");
    expect(ownerKind()).toEqual(ANONYMOUS);
    expect(has(root, "session-lapsed")).toBe(false);
    expect(has(root, "sign-in-choose")).toBe(true);
  });
});

describe("signing out", () => {
  it("opens the anonymous database only when the person presses Sign out", async () => {
    app.storage.set("svett.moveJournal", encodeMoveJournal({ state: "declined" }));
    const { root, session } = await renderAccount();
    await session(FIRST);
    await until(() => has(root, "sign-out"), "showing the account");
    await press(root, "sign-out");
    await session(null);
    await until(isAnonymous, "opening the anonymous database");
    expect(has(root, "session-lapsed")).toBe(false);
    expect(has(root, "sign-in-choose")).toBe(true);
    await write(logWorkout("Logged signed out"));
    expect(await titles(phone)).toEqual(["Logged signed out", "Phone run"]);
    expect(await titles(first)).toEqual([]);
  });
});

describe("an unfinished move with nobody signed in", () => {
  beforeEach(() => {
    // The move into the first account named it and has not deleted the phone's file yet.
    app.storage.set("svett.moveJournal", encodeMoveJournal({ state: "copying", account: FIRST }));
    switchOwner(ANONYMOUS);
  });

  it("says so on Account", async () => {
    const tree = await mount(<AccountScreen />);
    rendered.push(tree);
    expect(has(tree.root, "move-unfinished")).toBe(true);
    expect(texts(tree.root)).toContain("Your data is moving into an account");
  });

  it("refuses to save into the empty database instead of losing the workout", async () => {
    expect(currentDatabase().handle.target).toEqual({ kind: "empty" });
    await expect(write(logWorkout("Lost run"))).rejects.toThrow(MOVE_UNFINISHED);
    expect(await titles(empty)).toEqual([]);
    expect(await titles(phone)).toEqual(["Phone run"]);
  });
});

describe("the move offer", () => {
  it("shows again when the person leaves Account before answering", async () => {
    switchOwner({ kind: "account", accountId: FIRST });
    app.clerk.userId = FIRST;
    const leave = await mount(<AccountScreen />);
    await until(() => has(leave.root, "move-offer"), "offering the move");
    await act(async () => leave.unmount());

    const back = await mount(<AccountScreen />);
    rendered.push(back);
    await until(() => has(back.root, "move-offer"), "offering the move again");
    expect(app.storage.get("svett.moveJournal")).toBeUndefined();
  });
});
