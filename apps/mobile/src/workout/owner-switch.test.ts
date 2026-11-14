import {
  AccountId,
  ActivityExerciseId,
  type ActivityRepository,
  ANONYMOUS,
  databaseLayer,
  encodeMoveJournal,
  type ExerciseRepository,
  Ids,
  loadWorkoutLog,
  startEmptyWorkout,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MOVE_UNFINISHED } from "../data/store";

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  defaults: new Map<string, unknown>(),
  notifications: new Set<string>(),
}));

vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => app.storage.get(key) ?? null,
    setItemSync: (key: string, value: string) => app.storage.set(key, value),
    removeItemSync: (key: string) => app.storage.delete(key),
  },
}));
// The phone's user defaults, where a running rest is kept.
vi.mock("react-native", () => ({
  Settings: {
    get: (key: string) => app.defaults.get(key),
    set: (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) app.defaults.set(key, value);
    },
  },
}));
vi.mock("expo-notifications", () => ({
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
  requestPermissionsAsync: async () => ({ granted: true }),
  cancelScheduledNotificationAsync: async (id: string) => {
    app.notifications.delete(id);
  },
  scheduleNotificationAsync: async (request: { identifier: string }) => {
    app.notifications.add(request.identifier);
    return request.identifier;
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

type Runtime = ManagedRuntime.ManagedRuntime<ActivityRepository | ExerciseRepository, unknown>;

const FIRST = AccountId.make("user_svett_first");

const openDatabase = (seed: number): Runtime =>
  ManagedRuntime.make(databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(seed)));

let phone: Runtime;
let first: Runtime;
let empty: Runtime;

/** A fresh launch of the app's modules, on the phone's own database. */
const launch = async () => {
  vi.resetModules();
  const current = await import("../data/current");
  const store = await import("./store");
  const actions = await import("./actions");
  const rest = await import("./rest");
  current.switchOwner(ANONYMOUS);
  await store.reloadWorkout();
  return { current, store, actions, rest };
};

/** Waits for every read and save the store has queued, including the one a switch queues. */
const settled = async (store: Awaited<ReturnType<typeof launch>>["store"]) => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await store.reloadWorkout();
};

const inProgress = (runtime: Runtime) =>
  runtime
    .runPromise(loadWorkoutLog)
    .then(Option.map((log) => ({ id: log.activity.id, title: log.activity.title })))
    .then(Option.getOrNull);

beforeEach(async () => {
  phone = openDatabase(1);
  first = openDatabase(2);
  empty = openDatabase(3);
  app.databases.set("anonymous", phone);
  app.databases.set(FIRST, first);
  app.databases.set("empty", empty);
  app.storage.clear();
  app.defaults.clear();
  app.notifications.clear();
  await phone.runPromise(startEmptyWorkout(7));
});

afterEach(async () => {
  await Promise.all([phone.dispose(), first.dispose(), empty.dispose()]);
});

describe("the workout in progress when someone signs in or out", () => {
  it("stays in the database it was started in, and shows only the open database's", async () => {
    const { current, store, actions, rest } = await launch();
    const started = await inProgress(phone);
    expect(store.currentWorkout()?.activity.title).toBe(started?.title);
    await rest.startRestTimer(90, {
      exercise: "Barbell Squat",
      activityId: started!.id,
      activityExerciseId: ActivityExerciseId.make("0190a0b2-0000-7000-8000-000000000001"),
    });
    expect(rest.currentRestTimer()).not.toBeNull();

    current.switchOwner({ kind: "account", accountId: FIRST });
    // The bar above the tabs drops the phone's workout and its rest at once, before the
    // account's workout is read.
    expect(store.workoutState()).toEqual({ status: "loading" });
    expect(rest.currentRestTimer()).toBeNull();
    await settled(store);
    expect(store.workoutState()).toMatchObject({ status: "ready", log: null, problem: null });

    // The account starts its own workout. The phone's does not stand in its way.
    expect(await actions.startEmpty()).toBe(true);
    const own = await inProgress(first);
    expect(own).not.toBeNull();
    expect(store.currentWorkout()?.activity.id).toBe(own?.id);

    current.switchOwner(ANONYMOUS);
    await settled(store);
    expect(store.currentWorkout()?.activity.id).toBe(started?.id);
    expect(await inProgress(phone)).toEqual(started);
    expect(await inProgress(first)).toEqual(own);
  });

  it("saves a change made just before a switch to neither database, and shows no problem", async () => {
    const { current, store, actions } = await launch();
    const started = await inProgress(phone);

    actions.renameWorkout("Typed as the switch happened");
    current.switchOwner({ kind: "account", accountId: FIRST });
    await settled(store);

    expect(await inProgress(phone)).toEqual(started);
    expect(await inProgress(first)).toBeNull();
    expect(store.workoutState()).toMatchObject({
      status: "ready",
      log: null,
      problem: null,
      failures: 0,
    });
  });

  it("refuses to start a workout while a move into an account is unfinished", async () => {
    const { current, store, actions } = await launch();
    app.storage.set("svett.moveJournal", encodeMoveJournal({ state: "copying", account: FIRST }));
    current.reopenDatabase();
    await settled(store);
    expect(store.currentWorkout()).toBeNull();

    expect(await actions.startEmpty()).toBeNull();
    expect(store.workoutState()).toMatchObject({
      status: "ready",
      problem: `Error: ${MOVE_UNFINISHED}`,
    });
    expect(await inProgress(empty)).toBeNull();
  });
});
