import {
  AccountId,
  ActivityRepository,
  ANONYMOUS,
  bytesSource,
  databaseLayer,
  Ids,
  readSourceFile,
  TransferRepository,
} from "@svett/core";
import { manualClock, openNodeDatabase, sampleHealthZip } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { switchOwner } from "../data/current";
import { inTurn } from "../data/turns";
import { DATABASE_SWITCHED } from "../transfer/files";
import { HealthImportScreen } from "./HealthImportScreen";

type Runtime = ManagedRuntime.ManagedRuntime<ActivityRepository | TransferRepository, unknown>;

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  discarded: [] as Array<unknown>,
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
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-sharing", () => ({}));
vi.mock("expo-file-system", () => ({}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => app.storage.get(key) ?? null,
    setItemSync: (key: string, value: string) => app.storage.set(key, value),
    removeItemSync: (key: string) => app.storage.delete(key),
  },
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
// The picked file is the sample Health export, read as the phone reads it, from the cache.
vi.mock("./files", () => ({
  discardPickedFile: (source: unknown) => app.discarded.push(source),
  readWorkoutFile: () =>
    readSourceFile(bytesSource(sampleHealthZip()), { hourOf: (at) => new Date(at).getUTCHours() }),
}));
vi.mock("@react-navigation/native", () => {
  const navigation = { canGoBack: () => true, goBack: () => {}, navigate: () => {} };
  const route = { params: { uri: "file:///cache/export.zip" } };
  return { useNavigation: () => navigation, useRoute: () => route };
});

const ACCOUNT = AccountId.make("user_svett_test");
const T0 = Date.UTC(2026, 10, 10, 9);

const openDatabase = (seed: number): Runtime => {
  const { driver } = openNodeDatabase();
  return ManagedRuntime.make(
    Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(seed)), manualClock(T0).layer),
  );
};

const titles = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      Effect.map(activities.list(), (page) => page.map((activity) => activity.title)),
    ),
  );

const imports = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(Effect.service(TransferRepository), (transfers) => transfers.listImports),
  );

let phone: Runtime;
let account: Runtime;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  phone = openDatabase(1);
  account = openDatabase(2);
  app.databases.set("anonymous", phone);
  app.databases.set(ACCOUNT, account);
  app.storage.clear();
  app.discarded.length = 0;
  switchOwner(ANONYMOUS);
});

const rendered: Array<ReactTestRenderer> = [];

afterEach(async () => {
  await act(async () => {
    for (const tree of rendered.splice(0)) tree.unmount();
  });
  await Promise.all([phone.dispose(), account.dispose()]);
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

async function render(shows: string) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<HealthImportScreen />);
  });
  if (tree === undefined) throw new Error("did not render");
  rendered.push(tree);
  const shown = tree.root;
  await until(() => has(shown, shows), `showing ${shows}`);
  return shown;
}

const press = (root: ReactTestInstance, id: string) =>
  root.find(byTestID(id)).props.onPress as () => void;

const signIn = () => act(() => switchOwner({ kind: "account", accountId: ACCOUNT }));

/** Holds the turn the way a move into an account does, until the returned function runs. */
const holdTurn = () => {
  const moving: { finish?: () => void } = {};
  const done = inTurn(
    () =>
      new Promise<void>((resolve) => {
        moving.finish = resolve;
      }),
  );
  return async () => {
    moving.finish?.();
    await done;
  };
};

const SAMPLE_TITLES = ["Yoga", "Afternoon ride", "Evening workout", "Morning run"];

describe("a Health import across signing in", () => {
  it("replaces a preview made before signing in, and its Import writes nothing", async () => {
    const root = await render("health-new");
    const staleImport = press(root, "health-apply");

    await signIn();
    await until(() => has(root, "health-new"), "previewing for the account");

    await act(async () => staleImport());
    await until(() => has(root, "health-refused"), "refusing the old preview");
    expect(texts(root)).toContain(DATABASE_SWITCHED);
    expect(await titles(phone)).toEqual([]);
    expect(await imports(phone)).toEqual([]);
    expect(await titles(account)).toEqual([]);
    expect(await imports(account)).toEqual([]);
  });

  it("writes nothing to either account when the account switches while the import waits for a move", async () => {
    const root = await render("health-new");
    const finishMove = holdTurn();
    await act(async () => press(root, "health-apply")());
    await signIn();
    await finishMove();
    await until(() => has(root, "health-refused"), "refusing the import");
    expect(texts(root)).toContain("Import failed");
    expect(texts(root)).toContain(DATABASE_SWITCHED);
    expect(await titles(phone)).toEqual([]);
    expect(await titles(account)).toEqual([]);
    expect(await imports(account)).toEqual([]);
  });

  it("imports into the account that was signed in when the preview was made", async () => {
    await signIn();
    const root = await render("health-new");
    await act(async () => press(root, "health-apply")());
    await until(() => has(root, "health-done"), "importing");
    expect(await titles(account)).toEqual(SAMPLE_TITLES);
    expect(await titles(phone)).toEqual([]);
  });
});

describe("the picked file's cached copy", () => {
  it("is deleted once the import finishes", async () => {
    const root = await render("health-new");
    expect(app.discarded).toEqual([]);
    await act(async () => press(root, "health-apply")());
    await until(() => has(root, "health-done"), "importing");
    expect(app.discarded).toEqual([{ uri: "file:///cache/export.zip" }]);
  });

  it("is deleted when the import is declined", async () => {
    const root = await render("health-new");
    await act(async () => press(root, "health-decline")());
    expect(app.discarded).toEqual([{ uri: "file:///cache/export.zip" }]);
    expect(await titles(phone)).toEqual([]);
  });
});
