import {
  ActivityRepository,
  ANONYMOUS,
  databaseLayer,
  DurationSeconds,
  EpochMillis,
  Fingerprint,
  Ids,
  NO_CHOICES,
  type SourceFile,
  SourceIdentity,
  type SourceWorkout,
  TransferRepository,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { switchOwner } from "../data/current";
import { HealthImportScreen } from "./HealthImportScreen";

type Runtime = ManagedRuntime.ManagedRuntime<ActivityRepository | TransferRepository, unknown>;

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  file: undefined as unknown,
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
vi.mock("../data/database", () => ({
  launchFixture: () => undefined,
  openDatabaseHandle: (target: { kind: string; owner?: { kind: string } }) => ({
    target,
    get runtime() {
      return app.databases.get(target.owner?.kind ?? target.kind);
    },
    close: async () => {},
  }),
}));
vi.mock("./files", () => ({
  discardPickedFile: () => {},
  readWorkoutFile: async () => Result.succeed(app.file),
}));
vi.mock("@react-navigation/native", () => {
  const navigation = { canGoBack: () => true, goBack: () => {}, navigate: () => {} };
  const route = { params: { uri: "file:///cache/export.zip" } };
  return { useNavigation: () => navigation, useRoute: () => route };
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 10, 9);
/** More than one page of each list the preview offers a choice in. */
const COUNT = 35;
/** The 31st row, newest first, the first one past the first page. */
const PAST_FIRST_PAGE = COUNT - 31;

const two = (i: number) => String(i).padStart(2, "0");

const workout = (
  source: SourceWorkout["source"],
  identity: string,
  title: string,
  start: number,
  fingerprint: string,
): SourceWorkout => ({
  source,
  identity: SourceIdentity.make(identity),
  fingerprint: Fingerprint.make(fingerprint.padEnd(64, "0")),
  kind: "strength",
  title,
  startedAt: EpochMillis.make(start),
  endedAt: EpochMillis.make(start + 50 * 60_000),
  durationS: DurationSeconds.make(50 * 60),
  distanceM: null,
  energyKcal: null,
  route: [],
  heartRate: [],
});

const indexes = Array.from({ length: COUNT }, (_, i) => i);
/** Workouts from another source that the file's duplicates overlap. */
const others = indexes.map((i) =>
  workout("gpx", `other-${i}`, `Other ${two(i)}`, T0 - 400 * DAY + i * DAY, `a${two(i)}`),
);
/** Workouts imported from Health before, which the file then changes. */
const mine = indexes.map((i) =>
  workout("apple_health", `mine-${i}`, `Mine ${two(i)}`, T0 - 200 * DAY + i * DAY, `b${two(i)}`),
);
const duplicates = indexes.map((i) =>
  workout(
    "apple_health",
    `duplicate-${i}`,
    `Duplicate ${two(i)}`,
    others[i]!.startedAt + 5 * 60_000,
    `c${two(i)}`,
  ),
);
const theirs = mine.map((each, i) => ({
  ...each,
  title: `Theirs ${two(i)}`,
  fingerprint: Fingerprint.make(`d${two(i)}`.padEnd(64, "0")),
}));

let phone: Runtime;

const transfer = <A, E>(
  use: (transfers: typeof TransferRepository.Service) => Effect.Effect<A, E>,
) => phone.runPromise(Effect.flatMap(Effect.service(TransferRepository), use));

const titles = () =>
  phone.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      Effect.map(activities.list({ limit: 1000 }), (page) => page.map((each) => each.title)),
    ),
  );

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(async () => {
  const { driver } = openNodeDatabase();
  phone = ManagedRuntime.make(
    Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(1)), manualClock(T0).layer),
  );
  app.databases.set("anonymous", phone);
  app.storage.clear();
  switchOwner(ANONYMOUS);
  await transfer((transfers) => transfers.applySourceImport("gpx", others, NO_CHOICES));
  await transfer((transfers) => transfers.applySourceImport("apple_health", mine, NO_CHOICES));
  app.file = {
    source: "apple_health",
    workouts: [...duplicates, ...theirs],
    skipped: 0,
  } satisfies SourceFile;
});

const rendered: Array<ReactTestRenderer> = [];

afterEach(async () => {
  await act(async () => {
    for (const tree of rendered.splice(0)) tree.unmount();
  });
  await phone.dispose();
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

async function render() {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<HealthImportScreen />);
  });
  if (tree === undefined) throw new Error("did not render");
  rendered.push(tree);
  await until(() => has(tree!.root, "health-duplicates"), "showing the plan");
  return tree.root;
}

describe("a Health import with more choices than one page", () => {
  it("shows every duplicate and changed workout a page at a time, and imports the choices on each page", async () => {
    const root = await render();
    expect(has(root, "health-duplicate-29")).toBe(true);
    expect(has(root, "health-duplicate-30")).toBe(false);
    expect(has(root, "health-changed-30")).toBe(false);

    await press(root, "health-duplicate-0");
    await press(root, "health-changed-0");
    const more = root.find(byTestID("health-duplicates-more"));
    expect(more.props.accessibilityRole).toBe("button");
    expect(more.props.accessibilityLabel).toBe("Show more possible duplicates");
    expect(more.props.className).toContain("min-h-target");
    await press(root, "health-duplicates-more");
    await press(root, "health-changed-more");

    expect(has(root, "health-duplicates-more")).toBe(false);
    expect(has(root, "health-changed-more")).toBe(false);
    expect(has(root, `health-duplicate-${COUNT - 1}`)).toBe(true);
    expect(has(root, `health-changed-${COUNT - 1}`)).toBe(true);
    // The choices made on the first page are still there.
    expect(texts(root.find(byTestID("health-duplicate-0")))).toContain("Keep both");
    expect(texts(root.find(byTestID("health-changed-0")))).toContain("File's version");

    const duplicate = root.find(byTestID("health-duplicate-30"));
    const changed = root.find(byTestID("health-changed-30"));
    expect(texts(duplicate)).toContain(`Duplicate ${two(PAST_FIRST_PAGE)}`);
    expect(texts(changed)).toContain(`Theirs ${two(PAST_FIRST_PAGE)}`);
    await press(root, "health-duplicate-30");
    await press(root, "health-changed-30");
    expect(texts(root.find(byTestID("health-duplicate-30")))).toContain("Keep both");
    expect(texts(root.find(byTestID("health-changed-30")))).toContain("File's version");

    await press(root, "health-apply");
    await until(() => has(root, "health-done"), "importing");

    const after = await titles();
    const kept = [COUNT - 1, PAST_FIRST_PAGE].map((i) => `Duplicate ${two(i)}`);
    expect(after.filter((title) => title.startsWith("Duplicate"))).toEqual(kept);
    expect(after.filter((title) => title.startsWith("Other"))).toHaveLength(COUNT);
    const taken = [COUNT - 1, PAST_FIRST_PAGE].map((i) => `Theirs ${two(i)}`);
    expect(after.filter((title) => title.startsWith("Theirs"))).toEqual(taken);
    expect(after.filter((title) => title.startsWith("Mine"))).toHaveLength(COUNT - 2);
    expect(texts(root.find(byTestID("health-outcome")))).toBe(
      `Added 2 workouts, linked ${COUNT - 2} workouts to ones already here and took the new version of 2 workouts.`,
    );
  });
});
