import {
  AccountId,
  ActivityRepository,
  ANONYMOUS,
  databaseLayer,
  Ids,
  type LocationReading,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SWITCHED_BEFORE_WRITE } from "../data/store";

type Task = (body: {
  data: { locations: ReadonlyArray<LocationReading> };
  error: unknown;
}) => Promise<void>;

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  journal: "",
  task: undefined as Task | undefined,
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
// A closed handle refuses every read and write, as expo-sqlite does.
vi.mock("../data/database", () => ({
  launchFixture: () => undefined,
  openDatabaseHandle: (target: { kind: string; owner?: { kind: string; accountId?: string } }) => {
    let closed = false;
    return {
      target,
      get runtime() {
        if (closed) throw new Error("This database is closed.");
        return app.databases.get(target.owner?.accountId ?? target.owner?.kind ?? target.kind);
      },
      close: async () => {
        closed = true;
      },
    };
  },
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
  hasStartedLocationUpdatesAsync: async () => false,
  startLocationUpdatesAsync: async () => undefined,
  stopLocationUpdatesAsync: async () => undefined,
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

const openDatabase = (seed: number): Runtime =>
  ManagedRuntime.make(databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(seed)));

let phone: Runtime;
let runner: Runtime;

/** A fresh launch of the app's modules, on the database of whoever was signed in last. */
const launch = async () => {
  vi.resetModules();
  const current = await import("../data/current");
  const recorder = await import("./recorder");
  return { current, recorder };
};

/**
 * iOS handing svett the readings of a steady 2 m/s run north, one a second, from second
 * `from` up to `to`, as it does while the screen is locked.
 */
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

const activities = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (repository) => repository.counts),
  );

beforeEach(() => {
  phone = openDatabase(1);
  runner = openDatabase(2);
  app.databases.set("anonymous", phone);
  app.databases.set(RUNNER, runner);
  app.storage.clear();
  app.journal = "";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a recording when someone signs in or out", () => {
  it("keeps readings after the switch with the owner it started for, and saves only there", async () => {
    const { current, recorder } = await launch();
    const started = current.currentDatabase();
    expect(await recorder.startRecording("run", started)).toEqual({ kind: "started" });
    await deliver(1, 61);

    current.switchOwner({ kind: "account", accountId: RUNNER });
    const signedIn = current.currentDatabase();
    // The runner's screens do not show it, and cannot start, pause, finish or discard it.
    expect(recorder.shownRecording(signedIn)).toBeUndefined();
    expect(await recorder.startRecording("walk", signedIn)).toEqual({
      kind: "error",
      step: "start",
      message: recorder.OTHER_OWNER_RECORDING,
    });
    await expect(recorder.finishRecording(signedIn)).rejects.toThrow(
      recorder.OTHER_OWNER_RECORDING,
    );
    await expect(recorder.discardRecording(signedIn)).rejects.toThrow(
      recorder.OTHER_OWNER_RECORDING,
    );
    // A button pressed on the screen shown before the switch saves nothing either.
    await expect(recorder.pauseRecording(started)).rejects.toThrow(SWITCHED_BEFORE_WRITE);
    await expect(recorder.finishRecording(started)).rejects.toThrow(SWITCHED_BEFORE_WRITE);

    // iOS keeps handing over readings, and they join the recording, not the runner's data.
    await deliver(61, 121);
    expect((await activities(runner)).activities).toBe(0);

    current.signedOut();
    const back = current.currentDatabase();
    expect(recorder.shownRecording(back)?.kind).toBe("run");
    vi.setSystemTime(T + 121_000);
    const id = await recorder.finishRecording(back);

    expect((await activities(runner)).activities).toBe(0);
    expect((await activities(phone)).activities).toBe(1);
    const saved = await phone.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (repository) => repository.get(id)),
    );
    // Two minutes at 2 m/s, so the minute after the switch counts as well as the one before.
    expect(Option.getOrThrow(saved).track?.distanceM).toBeGreaterThan(200);
    expect(app.journal).toBe("");
  });

  it("goes on after a relaunch signed in to another account, and still saves to its owner", async () => {
    const first = await launch();
    await first.recorder.startRecording("run", first.current.currentDatabase());
    first.current.switchOwner({ kind: "account", accountId: RUNNER });

    // iOS starts svett in the background to hand over readings, signed in to the runner.
    const { current, recorder } = await launch();
    expect(current.currentDatabase().owner).toEqual({ kind: "account", accountId: RUNNER });
    await deliver(1, 61);
    expect(recorder.recording.get()?.owner).toEqual(ANONYMOUS);
    expect(recorder.shownRecording(current.currentDatabase())).toBeUndefined();

    current.signedOut();
    vi.setSystemTime(T + 61_000);
    await recorder.finishRecording(current.currentDatabase());
    expect((await activities(phone)).activities).toBe(1);
    expect((await activities(runner)).activities).toBe(0);
  });
});
