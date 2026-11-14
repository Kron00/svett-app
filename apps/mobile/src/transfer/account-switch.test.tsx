import {
  AccountId,
  ActivityRepository,
  ANONYMOUS,
  type ActivityDraft,
  databaseLayer,
  decodeSvettFile,
  DurationSeconds,
  EpochMillis,
  Ids,
  libraryExerciseId,
  MADE_HERE,
  TransferRepository,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { currentDatabase, switchOwner } from "../data/current";
import { inTurn } from "../data/turns";
import { DATABASE_SWITCHED } from "./files";
import { ImportPreviewScreen } from "./ImportPreviewScreen";
import { UndoImportScreen } from "./UndoImportScreen";

type Runtime = ManagedRuntime.ManagedRuntime<ActivityRepository | TransferRepository, unknown>;

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  fileText: "",
  route: { params: {} as Record<string, unknown> },
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-sharing", () => ({}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache/" }, document: { uri: "file:///documents/" } },
  File: class {
    text() {
      return Promise.resolve(app.fileText);
    }
  },
}));
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
    runtime: app.databases.get(target.owner?.accountId ?? target.owner?.kind ?? target.kind),
    close: async () => {},
  }),
}));
vi.mock("@react-navigation/native", () => {
  const navigation = { canGoBack: () => true, goBack: () => {}, navigate: () => {} };
  return { useNavigation: () => navigation, useRoute: () => app.route };
});

const ACCOUNT = AccountId.make("user_svett_test");
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

const transfers = <A, E>(
  runtime: Runtime,
  body: (repository: typeof TransferRepository.Service) => Effect.Effect<A, E>,
) => runtime.runPromise(Effect.flatMap(Effect.service(TransferRepository), body));

const titles = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      Effect.map(activities.list(), (page) => page.map((activity) => activity.title)),
    ),
  );

const appliedImports = (runtime: Runtime) =>
  transfers(runtime, (repository) =>
    Effect.map(repository.listImports, (batches) => batches.map((batch) => batch.status)),
  );

let phone: Runtime;
let account: Runtime;
let source: Runtime;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  phone = openDatabase(1);
  account = openDatabase(2);
  source = openDatabase(3);
  app.databases.set("anonymous", phone);
  app.databases.set(ACCOUNT, account);
  app.storage.clear();
  switchOwner(ANONYMOUS);
  // The file holds one workout, which the phone has under an older title.
  const id = await source.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.create(workout("Legs")),
    ),
  );
  const older = await transfers(source, (repository) => repository.exportFile);
  await transfers(phone, (repository) => repository.applyImport(decode(older.text), []));
  await source.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.update(id, { title: "Leg day" }),
    ),
  );
  app.fileText = (await transfers(source, (repository) => repository.exportFile)).text;
  app.route.params = { file: "export.json" };
});

const rendered: Array<ReactTestRenderer> = [];

afterEach(async () => {
  await act(async () => {
    for (const tree of rendered.splice(0)) tree.unmount();
  });
  await Promise.all([phone.dispose(), account.dispose(), source.dispose()]);
});

const decode = (text: string) => Result.getOrThrow(decodeSvettFile(text));

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

async function render(screen: React.ReactElement, shows: string) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(screen);
  });
  if (tree === undefined) throw new Error("did not render");
  rendered.push(tree);
  const shown = tree.root;
  await until(() => has(shown, shows), `showing ${shows}`);
  return shown;
}

const press = (root: ReactTestInstance, id: string) => {
  const onPress = root.find(byTestID(id)).props.onPress as () => void;
  return onPress;
};

const signIn = () => act(() => switchOwner({ kind: "account", accountId: ACCOUNT }));

describe("an import or undo across signing in", () => {
  it("writes nothing to either account when the account switches while the import waits for a move", async () => {
    const root = await render(<ImportPreviewScreen />, "import-apply");
    let finishMove = () => {};
    const move = inTurn(() => new Promise<void>((resolve) => (finishMove = resolve)));
    await act(async () => press(root, "import-apply")());
    await signIn();
    finishMove();
    await move;
    await until(() => has(root, "import-refused"), "refusing the import");
    expect(texts(root)).toContain("Import failed");
    expect(texts(root)).toContain(DATABASE_SWITCHED);
    expect(await titles(phone)).toEqual(["Legs"]);
    expect(await appliedImports(phone)).toEqual(["applied"]);
    expect(await titles(account)).toEqual([]);
    expect(await appliedImports(account)).toEqual([]);
  });

  it("replaces an import preview made before signing in, and its Import writes nothing", async () => {
    const root = await render(<ImportPreviewScreen />, "import-changed");
    // Take the file's version of the workout the phone already has.
    const toggle = root
      .find(byTestID("import-changed"))
      .find((node) => String(node.type) === "Switch");
    await act(async () => (toggle.props.onValueChange as () => void)());
    expect(texts(root)).toContain("File's version");
    const staleImport = press(root, "import-apply");

    await signIn();
    expect(has(root, "import-changed")).toBe(false);
    await until(() => has(root, "import-new"), "previewing for the account");
    expect(has(root, "import-changed")).toBe(false);
    expect(texts(root)).not.toContain("File's version");

    await act(async () => staleImport());
    await until(() => has(root, "import-refused"), "refusing the old preview");
    expect(texts(root)).toContain(DATABASE_SWITCHED);
    expect(await titles(phone)).toEqual(["Legs"]);
    expect(await titles(account)).toEqual([]);
  });

  it("replaces an undo preview made before signing in, and its Undo writes nothing", async () => {
    const [batch] = await transfers(phone, (repository) => repository.listImports);
    app.route.params = { importBatchId: batch?.id };
    const root = await render(<UndoImportScreen />, "undo-apply");
    const staleUndo = press(root, "undo-apply");

    await signIn();
    expect(has(root, "undo-apply")).toBe(false);
    // The account holds no such import, so its preview says so.
    await until(() => texts(root).includes("Undo did not run"), "previewing for the account");
    expect(has(root, "undo-apply")).toBe(false);

    await act(async () => staleUndo());
    await until(() => texts(root).includes(DATABASE_SWITCHED), "refusing the old undo");
    expect(await titles(phone)).toEqual(["Legs"]);
    expect(await appliedImports(phone)).toEqual(["applied"]);
    expect(await titles(account)).toEqual([]);
  });

  it("still imports into the account when it was signed in before the preview", async () => {
    await signIn();
    const root = await render(<ImportPreviewScreen />, "import-new");
    await act(async () => press(root, "import-apply")());
    await until(() => has(root, "import-done"), "importing");
    expect(await titles(account)).toEqual(["Leg day"]);
    expect(await titles(phone)).toEqual(["Legs"]);
    expect(currentDatabase().owner).toEqual({ kind: "account", accountId: ACCOUNT });
  });
});
