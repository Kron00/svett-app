import {
  AccountId,
  ActivityRepository,
  ANONYMOUS,
  type ActivityDraft,
  databaseLayer,
  DELETION_NEEDS_SIGN_IN,
  DurationSeconds,
  encodeMoveJournal,
  EpochMillis,
  Ids,
  MADE_HERE,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { currentDatabase, switchOwner } from "../data/current";
import { AccountScreen } from "./AccountScreen";
import { finishPendingDeletion } from "./delete";
import { resumeMove } from "./move";

type Runtime = ManagedRuntime.ManagedRuntime<ActivityRepository, unknown>;
type AlertButton = {
  readonly text: string;
  readonly style?: string;
  readonly onPress?: () => void;
};

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  deletedFiles: [] as Array<string>,
  alerts: [] as Array<{
    readonly title: string;
    readonly message: string;
    readonly buttons: ReadonlyArray<AlertButton>;
  }>,
  sent: [] as Array<string>,
  answer: { status: 200, body: { deleted: true } as unknown },
  /** The receipts of the deletions the stand-in server carried out. */
  receipts: new Set<string>(),
  /** What the phone's journal held each time it sent a deletion. */
  journalAtSend: [] as Array<string | undefined>,
  /**
   * A deletion the network loses before the server gets it, or one whose answer is lost with
   * the phone offline from then on, as when svett stops before the answer arrives.
   */
  lose: undefined as "request" | "answer" | undefined,
  /** Makes the next file deletion fail, as a crash part way through leaving would. */
  crashOnDelete: false,
  signedOut: 0,
  clerk: {
    isLoaded: true,
    userId: null as string | null,
    signOut: async () => {},
    getToken: async () => "session-token" as string | null,
  },
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, message: string, buttons: ReadonlyArray<AlertButton>) =>
      app.alerts.push({ title, message, buttons }),
  },
  Settings: { get: () => undefined },
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
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async () => ({ closeAsync: async () => {} }),
  deleteDatabaseAsync: async (name: string) => {
    if (app.crashOnDelete) {
      app.crashOnDelete = false;
      throw new Error("The app stopped");
    }
    app.deletedFiles.push(name);
  },
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => app.storage.get(key) ?? null,
    setItemSync: (key: string, value: string) => app.storage.set(key, value),
    removeItemSync: (key: string) => app.storage.delete(key),
  },
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => app.clerk,
  useUser: () => ({ user: null }),
}));
vi.mock("./email-code", () => ({
  useEmailCode: () => ({ sendCode: async () => undefined, checkCode: async () => undefined }),
}));
vi.mock("./chatgpt-email", () => ({ chatGPTEmail: async () => ({ email: null }) }));
vi.mock("./config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
// Each owner's file is an in-memory SQLite database that outlives its handles, as a file would.
vi.mock("../data/database", () => ({
  launchFixture: () => undefined,
  secureRandomBytes: (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
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
  kind: "run",
  startedAt: EpochMillis.make(T0 - 86_400_000),
  durationS: DurationSeconds.make(1_800),
  title,
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: [],
  origin: MADE_HERE,
  exercises: [],
  track: null,
});

const log = (runtime: Runtime, title: string) =>
  runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.create(workout(title)),
    ),
  );

const titles = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      Effect.map(activities.list(), (page) => page.map((activity) => activity.title).sort()),
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
  app.deletedFiles = [];
  app.alerts = [];
  app.sent = [];
  app.signedOut = 0;
  app.answer = { status: 200, body: { deleted: true } };
  app.receipts = new Set();
  app.journalAtSend = [];
  app.lose = undefined;
  app.crashOnDelete = false;
  app.clerk.getToken = async () => "session-token";
  // The phone's own data was kept apart on the first sign-in.
  app.storage.set("svett.moveJournal", encodeMoveJournal({ state: "declined" }));
  app.clerk.userId = FIRST;
  app.clerk.signOut = async () => {
    app.signedOut++;
    app.clerk.userId = null;
  };
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body: string | null }) => {
    const path = new URL(url).pathname;
    const asked = path.match(/^\/v1\/deletions\/(.+)$/)?.[1];
    if (asked !== undefined) {
      app.sent.push("GET /v1/deletions/<receipt>");
      if (app.lose === "answer") throw new TypeError("Network request failed");
      return new Response(JSON.stringify({ deleted: app.receipts.has(asked) }), { status: 200 });
    }
    app.sent.push(`${init.method} ${path}`);
    if (init.method === "DELETE" && path === "/v1/me") {
      app.journalAtSend.push(app.storage.get("svett.moveJournal"));
      if (app.lose === "request") throw new TypeError("Network request failed");
      if (app.answer.status === 200) {
        app.receipts.add((JSON.parse(init.body ?? "{}") as { receipt: string }).receipt);
      }
      if (app.lose === "answer") throw new TypeError("Network request failed");
    }
    return new Response(JSON.stringify(app.answer.body), { status: app.answer.status });
  });
  switchOwner({ kind: "account", accountId: FIRST });
  await log(phone, "Phone run");
  await log(first, "First's run");
}, 60_000);

const rendered: Array<ReactTestRenderer> = [];

afterEach(async () => {
  await act(async () => {
    for (const tree of rendered.splice(0)) tree.unmount();
  });
  vi.unstubAllGlobals();
  switchOwner(ANONYMOUS);
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

async function renderAccount() {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<AccountScreen />);
  });
  if (tree === undefined) throw new Error("did not render");
  rendered.push(tree);
  await until(() => has(tree!.root, "delete-account"), "showing Delete account");
  return tree.root;
}

/** Presses the alert's button with this label, as the person would. */
const answerAlert = (label: string) =>
  act(async () => {
    const alert = app.alerts.at(-1);
    const button = alert?.buttons.find((each) => each.text === label);
    if (button === undefined) throw new Error(`No alert button ${label}`);
    button.onPress?.();
  });

const accountFile = `svett-account-${FIRST}.db`;

/** The next launch, which finishes what the journal says is left, as AccountProvider does. */
const launch = async () => {
  await resumeMove();
  return finishPendingDeletion({
    signedIn: () => app.clerk.userId,
    token: app.clerk.getToken,
    signOut: async (account) => {
      if (app.clerk.userId === account) await app.clerk.signOut();
    },
  });
};

/** Signs `account` in on the phone, which opens its database, as AccountProvider does. */
const signIn = (account: AccountId) => {
  app.clerk.userId = account;
  switchOwner({ kind: "account", accountId: account });
};

describe("deleting the account on the phone", () => {
  it("asks whether to keep a copy or erase it, and asks once more before deleting", async () => {
    const root = await renderAccount();
    await press(root, "delete-account");

    expect(has(root, "delete-keep-copy")).toBe(true);
    expect(has(root, "delete-erase-copy")).toBe(true);
    expect(texts(root)).toContain("Choose what happens to the copy on this phone.");

    await press(root, "delete-erase-copy");
    expect(app.alerts.map((alert) => alert.title)).toEqual([
      "Delete your account and erase this phone?",
    ]);
    expect(app.alerts[0]?.buttons.map((button) => [button.text, button.style])).toEqual([
      ["Cancel", "cancel"],
      ["Delete account", "destructive"],
    ]);
    await answerAlert("Cancel");
    await press(root, "delete-cancel");

    expect(has(root, "delete-account")).toBe(true);
    expect(app.sent).toEqual([]);
    expect(currentDatabase().owner).toEqual({ kind: "account", accountId: FIRST });
  });

  it("keeps a copy as the phone's own data with no account", async () => {
    const root = await renderAccount();
    await press(root, "delete-account");
    await press(root, "delete-keep-copy");
    expect(app.alerts.at(-1)?.title).toBe("Delete your account and keep a copy?");
    await answerAlert("Delete account");
    await until(() => app.signedOut === 1, "signing out");

    expect(app.sent).toEqual(["DELETE /v1/me"]);
    expect(currentDatabase().owner).toEqual(ANONYMOUS);
    expect(currentDatabase().handle.target).toEqual({ kind: "owner", owner: ANONYMOUS });
    expect(await titles(phone)).toEqual(["First's run", "Phone run"]);
    expect(app.deletedFiles).toEqual([accountFile]);
    // The phone's data has no owner again, so the next sign-in offers to move it.
    expect(app.storage.get("svett.moveJournal")).toBeUndefined();
  });

  it("erases the account's data and leaves the phone's own data as it was", async () => {
    const root = await renderAccount();
    await press(root, "delete-account");
    await press(root, "delete-erase-copy");
    await answerAlert("Delete account");
    await until(() => app.signedOut === 1, "signing out");

    expect(app.sent).toEqual(["DELETE /v1/me"]);
    expect(currentDatabase().owner).toEqual(ANONYMOUS);
    expect(await titles(phone)).toEqual(["Phone run"]);
    expect(app.deletedFiles).toEqual([accountFile]);
  });

  it("changes nothing on the phone when the server did not delete the account", async () => {
    app.answer = {
      status: 502,
      body: { error: "session_end_failed", message: "Clerk did not answer." },
    };
    const root = await renderAccount();
    await press(root, "delete-account");
    await press(root, "delete-erase-copy");
    await answerAlert("Delete account");
    await until(() => has(root, "sign-in-problem"), "saying what went wrong");

    expect(texts(root)).toContain("signing you out everywhere did not finish");
    expect(currentDatabase().owner).toEqual({ kind: "account", accountId: FIRST });
    expect(await titles(first)).toEqual(["First's run"]);
    expect(app.deletedFiles).toEqual([]);
    expect(app.signedOut).toBe(0);
  });

  it("takes the data off the phone when another phone deleted the account already", async () => {
    app.answer = { status: 410, body: { error: "account_deleted" } };
    const root = await renderAccount();
    await press(root, "delete-account");
    await press(root, "delete-keep-copy");
    await answerAlert("Delete account");
    await until(() => app.signedOut === 1, "signing out");

    expect(await titles(phone)).toEqual(["First's run", "Phone run"]);
    expect(app.deletedFiles).toEqual([accountFile]);
  });

  describe.each([
    { keep: true, button: "delete-keep-copy", titles: ["First's run", "Phone run"] },
    { keep: false, button: "delete-erase-copy", titles: ["Phone run"] },
  ])("ends as the person chose, keep a copy: $keep,", ({ keep, button, titles: kept }) => {
    /** Presses Delete account with the choice, and waits until the phone says how it went. */
    const choose = async () => {
      const root = await renderAccount();
      await press(root, "delete-account");
      await press(root, button);
      await answerAlert("Delete account");
      await until(() => has(root, "sign-in-problem") || app.signedOut === 1, "an answer");
      return root;
    };

    const endedAsChosen = async () => {
      expect(app.signedOut).toBe(1);
      expect(currentDatabase().owner).toEqual(ANONYMOUS);
      expect(await titles(phone)).toEqual(kept);
      expect(app.deletedFiles).toEqual([accountFile]);
      expect(app.storage.get("svett.moveJournal")).toBeUndefined();
    };

    it("when the request never reached the server, as after a crash before the send", async () => {
      app.lose = "request";
      const root = await choose();

      // The choice was saved before anything was sent.
      expect(JSON.parse(app.journalAtSend[0] ?? "null")).toMatchObject({
        state: "deleting",
        account: FIRST,
        keep,
      });
      expect(app.receipts.size).toBe(0);
      expect(texts(root)).toContain("finishes deleting your account the next time it opens");
      expect(app.deletedFiles).toEqual([]);

      app.lose = undefined;
      expect(await launch()).toBeUndefined();

      expect(app.sent.filter((each) => each === "DELETE /v1/me")).toHaveLength(2);
      await endedAsChosen();
    });

    it("when the server deleted the account and its answer was lost", async () => {
      app.lose = "answer";
      await choose();
      expect(app.receipts.size).toBe(1);
      expect(app.deletedFiles).toEqual([]);
      expect(currentDatabase().owner).toEqual({ kind: "account", accountId: FIRST });

      // The deletion ended the session, so the phone asks with the receipt alone.
      app.lose = undefined;
      app.clerk.getToken = async () => null;
      expect(await launch()).toBeUndefined();

      expect(app.sent.at(-1)).toBe("GET /v1/deletions/<receipt>");
      await endedAsChosen();
    });

    it("with another account signed in since, which it never sends and leaves untouched", async () => {
      app.lose = "answer";
      await choose();
      expect(app.receipts.size).toBe(1);

      app.lose = undefined;
      signIn(SECOND);
      await log(second, "Second's run");
      const before = app.sent.length;
      expect(await launch()).toBeUndefined();

      expect(app.sent.slice(before)).toEqual(["GET /v1/deletions/<receipt>"]);
      expect(app.signedOut).toBe(0);
      expect(app.clerk.userId).toBe(SECOND);
      expect(currentDatabase().owner).toEqual({ kind: "account", accountId: SECOND });
      expect(await titles(second)).toEqual(["Second's run"]);
      expect(await titles(phone)).toEqual(kept);
      expect(app.deletedFiles).toEqual([accountFile]);
      expect(app.storage.get("svett.moveJournal")).toBeUndefined();
    });

    it("waits for its own account's session when the request never reached the server", async () => {
      app.lose = "request";
      await choose();
      expect(app.receipts.size).toBe(0);

      app.lose = undefined;
      signIn(SECOND);
      const before = app.sent.length;
      expect(await launch()).toBe(DELETION_NEEDS_SIGN_IN);

      expect(app.sent.slice(before)).toEqual(["GET /v1/deletions/<receipt>"]);
      expect(app.receipts.size).toBe(0);
      expect(currentDatabase().owner).toEqual({ kind: "account", accountId: SECOND });
      expect(await titles(first)).toEqual(["First's run"]);
      expect(app.deletedFiles).toEqual([]);
      expect(JSON.parse(app.storage.get("svett.moveJournal") ?? "null")).toMatchObject({
        state: "deleting",
        account: FIRST,
        keep,
      });

      signIn(FIRST);
      expect(await launch()).toBeUndefined();
      expect(app.sent.at(-1)).toBe("DELETE /v1/me");
      await endedAsChosen();
    });

    it("after a crash part way through taking the data off the phone", async () => {
      app.crashOnDelete = true;
      const root = await choose();
      expect(texts(root)).toContain("The deletion did not finish");
      expect(JSON.parse(app.storage.get("svett.moveJournal") ?? "null")).toEqual({
        state: "erasing",
        account: FIRST,
      });

      expect(await launch()).toBeUndefined();

      expect(app.sent).toEqual(["DELETE /v1/me"]);
      await endedAsChosen();
    });
  });
});
