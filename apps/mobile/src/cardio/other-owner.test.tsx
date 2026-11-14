import {
  AccountId,
  ActivityRepository,
  databaseLayer,
  Ids,
  type LocationReading,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect, ManagedRuntime } from "effect";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Task = (body: {
  data: { locations: ReadonlyArray<LocationReading> };
  error: unknown;
}) => Promise<void>;

type AlertButton = { text: string; style?: string; onPress?: () => void };

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  journal: "",
  gps: false,
  task: undefined as Task | undefined,
  alerts: [] as Array<{ title: string; message?: string; buttons?: ReadonlyArray<AlertButton> }>,
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: {
    alert: (title: string, message?: string, buttons?: ReadonlyArray<AlertButton>) =>
      app.alerts.push({ title, message, buttons }),
  },
  Linking: { openSettings: async () => undefined },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 0.5 },
  // The largest accessibility text size.
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 3.12 }),
}));
vi.mock("@expo/ui/community/segmented-control", () => ({
  SegmentedControl: "NativeSegmentedControl",
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({
  DarkTheme: {},
  useNavigation: () => ({ replace: () => undefined }),
}));
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
  openDatabaseHandle: (target: { kind: string; owner?: { kind: string; accountId?: string } }) => ({
    target,
    runtime: app.databases.get(target.owner?.accountId ?? target.owner?.kind ?? target.kind),
    close: async () => undefined,
  }),
}));
vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  File: class {
    get exists() {
      return app.journal !== "";
    }
    textSync() {
      return app.journal;
    }
    async write(text: string) {
      app.journal += text;
    }
    delete() {
      app.journal = "";
    }
  },
}));
vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: async () => ({ granted: true }),
  requestBackgroundPermissionsAsync: async () => ({ granted: true }),
  hasStartedLocationUpdatesAsync: async () => app.gps,
  startLocationUpdatesAsync: async () => {
    app.gps = true;
  },
  stopLocationUpdatesAsync: async () => {
    app.gps = false;
  },
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { Fitness: 3 },
}));
vi.mock("expo-task-manager", () => ({
  defineTask: (_name: string, task: Task) => {
    app.task = task;
  },
}));

type Runtime = ManagedRuntime.ManagedRuntime<ActivityRepository, unknown>;

const RUNNER = AccountId.make("user_svett_runner");
const T = 1_800_000_000_000;
const METRES_PER_DEGREE = 111_320;

const ANONYMOUS_STARTED =
  "A recording started before you signed in is still going on this phone. Sign out to finish it, or discard it here.";
const ACCOUNT_STARTED =
  "A recording started in another account is still going on this phone. Sign in to that account to finish it, or discard it here.";

let phone: Runtime;
let runner: Runtime;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  phone = ManagedRuntime.make(databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(1)));
  runner = ManagedRuntime.make(databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(2)));
  app.databases.set("anonymous", phone);
  app.databases.set(RUNNER, runner);
  app.storage.clear();
  app.journal = "";
  app.gps = false;
  app.alerts = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});

afterEach(() => {
  vi.useRealTimers();
});

const launch = async () => {
  vi.resetModules();
  const current = await import("../data/current");
  const recorder = await import("./recorder");
  const { RecordScreen } = await import("./RecordScreen");
  return { current, recorder, RecordScreen };
};

/** A steady 2 m/s run north, one reading a second, as iOS hands it over. */
const deliver = (from: number, to: number) =>
  app.task!({
    data: {
      locations: Array.from({ length: to - from }, (_, index) => {
        const second = from + index;
        return {
          timestamp: T + second * 1000,
          coords: {
            latitude: (2 * second) / METRES_PER_DEGREE,
            longitude: 0,
            altitude: null,
            accuracy: 5,
            altitudeAccuracy: null,
            speed: 2,
          },
        };
      }),
    },
    error: null,
  });

const activities = async (runtime: Runtime) =>
  (
    await runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (repository) => repository.counts),
    )
  ).activities;

const render = (Screen: () => React.ReactNode) => {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(<Screen />);
  });
  if (!tree) throw new Error("did not render");
  return tree.root;
};

const byTestID = (root: ReactTestInstance, testID: string) =>
  root.findAll((node) => typeof node.type === "string" && node.props.testID === testID);

/** Every text on the screen, top to bottom. */
const texts = (root: ReactTestInstance) =>
  root
    .findAll((node) => (node.type as unknown) === "Text")
    .map((node) => String(node.props.children));

const press = async (root: ReactTestInstance, testID: string) => {
  const button = byTestID(root, testID).find((node) => (node.type as unknown) === "Pressable");
  if (button === undefined) throw new Error(`no ${testID} on screen`);
  await act(async () => button.props.onPress());
  return button;
};

describe("the Record screen while another owner's recording is going", () => {
  it("says to sign out for one started signed out, and discards it through the alert so Start works", async () => {
    const { current, recorder, RecordScreen } = await launch();
    expect(await recorder.startRecording("run", current.currentDatabase())).toEqual({
      kind: "started",
    });
    await deliver(1, 61);
    act(() => current.switchOwner({ kind: "account", accountId: RUNNER }));

    const root = render(RecordScreen);
    expect(texts(root)).toContain(ANONYMOUS_STARTED);
    // Nothing of the other recording's route, distance or times shows.
    for (const hidden of ["record-time", "record-distance", "record-pace", "record-status"]) {
      expect(byTestID(root, hidden)).toHaveLength(0);
    }
    const discard = await press(root, "record-other-discard");
    expect(discard.props.accessibilityRole).toBe("button");
    expect(discard.props.accessibilityLabel).toBe("Discard it");

    // Nothing is discarded until the alert is confirmed.
    expect(app.alerts).toHaveLength(1);
    const [alert] = app.alerts;
    expect(alert?.title).toBe("Discard the other recording?");
    expect(alert?.buttons?.find((button) => button.style === "cancel")?.text).toBe("Keep it");
    expect(app.gps).toBe(true);
    expect(app.journal).not.toBe("");

    const confirm = alert?.buttons?.find((button) => button.style === "destructive");
    await act(async () => {
      confirm?.onPress?.();
      await vi.waitFor(() => expect(app.journal).toBe(""));
    });
    expect(app.gps).toBe(false);
    expect(byTestID(root, "record-other")).toHaveLength(0);
    expect(await activities(phone)).toBe(0);
    expect(await activities(runner)).toBe(0);

    // Start now records for the runner, and saves into the runner's database.
    await press(root, "record-start");
    expect(byTestID(root, "record-start-problem")).toHaveLength(0);
    expect(recorder.recording.get()?.owner).toEqual({ kind: "account", accountId: RUNNER });
    expect(app.gps).toBe(true);
    await act(() => deliver(200, 260));
    vi.setSystemTime(T + 260_000);
    await act(async () => {
      await recorder.finishRecording(current.currentDatabase());
    });
    expect(await activities(runner)).toBe(1);
    expect(await activities(phone)).toBe(0);
  });

  it("says to sign in to the account for one started in an account", async () => {
    const { current, recorder, RecordScreen } = await launch();
    current.switchOwner({ kind: "account", accountId: RUNNER });
    await recorder.startRecording("ride", current.currentDatabase());
    act(() => current.signedOut());

    const root = render(RecordScreen);
    expect(texts(root)).toContain(ACCOUNT_STARTED);
    expect(await recorder.startRecording("walk", current.currentDatabase())).toEqual({
      kind: "error",
      step: "start",
      message: ACCOUNT_STARTED,
    });
  });

  it("leaves the recording alone when it was confirmed after someone signed in or out", async () => {
    const { current, recorder, RecordScreen } = await launch();
    await recorder.startRecording("run", current.currentDatabase());
    act(() => current.switchOwner({ kind: "account", accountId: RUNNER }));
    const root = render(RecordScreen);
    await press(root, "record-other-discard");

    // Back on the account the recording belongs to, the alert from before discards nothing.
    act(() => current.signedOut());
    const confirm = app.alerts[0]?.buttons?.find((button) => button.style === "destructive");
    await act(async () => confirm?.onPress?.());
    expect(app.alerts.at(-1)?.title).toBe("Nothing changed");
    expect(recorder.shownRecording(current.currentDatabase())?.kind).toBe("run");
    expect(app.gps).toBe(true);
  });
});
