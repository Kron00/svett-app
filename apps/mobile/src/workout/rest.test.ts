import {
  ActivityRepository,
  addExercisesToWorkout,
  databaseLayer,
  Ids,
  libraryExerciseId,
  startEmptyWorkout,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const app = vi.hoisted(() => ({ runtime: undefined as unknown }));
vi.mock("../data/database", () => ({ appDatabase: () => app.runtime }));

// The phone's user defaults, which outlive a killed svett.
const defaults = vi.hoisted(() => new Map<string, unknown>());
vi.mock("react-native", () => ({
  Alert: { alert: () => undefined },
  Settings: {
    get: (key: string) => defaults.get(key),
    set: (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === null) defaults.delete(key);
        else defaults.set(key, value);
      }
    },
  },
}));

/** iOS's pending notifications. A schedule can be held, as a slow bridge call would be. */
const ios = vi.hoisted(() => ({
  pending: new Map<string, number>(),
  held: null as Array<() => void> | null,
  reached: null as (() => void) | null,
  /** When set, the permission prompt waits for `answer`, as a person reading it would. */
  askLater: false,
  answer: null as ((granted: boolean) => void) | null,
  /** Holds the next schedules. Resolves once one is waiting. */
  hold() {
    this.held = [];
    return new Promise<void>((resolve) => (this.reached = resolve));
  },
  release() {
    const waiting = this.held ?? [];
    this.held = null;
    for (const resume of waiting) resume();
  },
}));
vi.mock("expo-notifications", () => ({
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
  requestPermissionsAsync: () =>
    ios.askLater
      ? new Promise<{ granted: boolean }>((resolve) => {
          ios.answer = (granted) => resolve({ granted });
        })
      : Promise.resolve({ granted: true }),
  cancelScheduledNotificationAsync: async (id: string) => {
    ios.pending.delete(id);
  },
  scheduleNotificationAsync: async (request: {
    identifier: string;
    trigger: { seconds: number };
  }) => {
    if (ios.held !== null) {
      ios.reached?.();
      await new Promise<void>((resume) => ios.held!.push(resume));
    }
    ios.pending.set(request.identifier, request.trigger.seconds);
    return request.identifier;
  },
}));

const squat = libraryExerciseId("Barbell_Squat");

const openApp = () => {
  const { driver } = openNodeDatabase(":memory:");
  return ManagedRuntime.make(databaseLayer(driver, Ids.layerSeeded(1)));
};

/** A fresh copy of the modules, as a launch of the app gets, with the workout read. */
const launch = async (runtime: unknown) => {
  app.runtime = runtime;
  vi.resetModules();
  const store = await import("./store");
  const actions = await import("./actions");
  const rest = await import("./rest");
  await store.reloadWorkout();
  return { store, actions, rest };
};

type Launched = Awaited<ReturnType<typeof launch>>;

const startSquats = (runtime: ReturnType<typeof openApp>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const id = yield* startEmptyWorkout(9);
      yield* addExercisesToWorkout(id, [squat]);
    }),
  );

/** Rests before the next set of the workout's first exercise, as marking a set done does. */
const restBeforeSquat = ({ store, rest }: Launched, seconds = 90) => {
  const log = store.currentWorkout()!;
  return rest.startRestTimer(seconds, {
    exercise: "Barbell Squat",
    activityId: log.activity.id,
    activityExerciseId: log.exercises[0]!.row.id,
  });
};

/** Marks the first set done with 5 reps, so the workout can be finished. */
const doOneSet = async ({ store, actions }: Launched) => {
  const set = () => store.currentWorkout()!.exercises[0]!.sets[0]!;
  actions.typeValue(set(), "reps", 5);
  await store.reloadWorkout();
  actions.toggleSetDone(store.currentWorkout()!.exercises[0]!, 0);
  await vi.waitFor(() => expect(set().done).toBe(true));
};

beforeEach(() => {
  defaults.clear();
  ios.pending.clear();
  ios.held = null;
  ios.askLater = false;
  ios.answer = null;
});

afterEach(() => {
  app.runtime = undefined;
  vi.useRealTimers();
});

describe("the rest notification", () => {
  it("is due when the rest ends", async () => {
    const runtime = openApp();
    await startSquats(runtime);
    const running = await launch(runtime);

    await restBeforeSquat(running);

    expect(ios.pending.get("svett-rest-timer")).toBe(90);
  });

  const cancelPaths: ReadonlyArray<
    readonly [name: string, cancel: (running: Launched) => Promise<unknown>]
  > = [
    ["skipping the rest", ({ rest }) => rest.skipRestTimer()],
    [
      "finishing the workout",
      async (running) => {
        expect(await running.actions.finish()).toEqual({ finished: true });
      },
    ],
    ["discarding the workout", ({ actions }) => actions.discard()],
  ];

  for (const [name, cancel] of cancelPaths) {
    it(`stays cancelled after ${name} while an earlier schedule was still on its way`, async () => {
      const runtime = openApp();
      await startSquats(runtime);
      const running = await launch(runtime);
      await doOneSet(running);

      const reached = ios.hold();
      const scheduling = restBeforeSquat(running);
      await reached;
      const cancelling = cancel(running);
      ios.release();
      await Promise.all([scheduling, cancelling]);

      expect(ios.pending.size).toBe(0);
      expect(defaults.has("svettRestTimer")).toBe(false);
    });
  }

  it("is the new rest's alone when a new rest starts while the last one's schedule was on its way", async () => {
    const runtime = openApp();
    await startSquats(runtime);
    const running = await launch(runtime);

    const reached = ios.hold();
    const first = restBeforeSquat(running, 90);
    await reached;
    const second = restBeforeSquat(running, 30);
    ios.release();
    await Promise.all([first, second]);

    expect([...ios.pending]).toEqual([["svett-rest-timer", 30]]);
  });

  it("is due when the rest ends, not a whole rest later, when permission comes mid-rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    const runtime = openApp();
    await startSquats(runtime);
    const running = await launch(runtime);
    ios.askLater = true;

    const scheduling = restBeforeSquat(running, 30);
    await vi.waitFor(() => expect(ios.answer).not.toBeNull());
    vi.setSystemTime(1_010_000);
    ios.answer!(true);
    await scheduling;

    expect(ios.pending.get("svett-rest-timer")).toBe(20);
  });

  it("is never scheduled when permission comes after the rest ended", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    const runtime = openApp();
    await startSquats(runtime);
    const running = await launch(runtime);
    ios.askLater = true;

    const scheduling = restBeforeSquat(running, 30);
    await vi.waitFor(() => expect(ios.answer).not.toBeNull());
    vi.setSystemTime(1_031_000);
    running.rest.restEnded(running.rest.currentRestTimer()!);
    ios.answer!(true);
    await scheduling;

    expect(running.rest.currentRestTimer()).toBeNull();
    expect(ios.pending.size).toBe(0);
  });

  it("is cancelled, not moved a second on, when the rest is cut to nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    const runtime = openApp();
    await startSquats(runtime);
    const running = await launch(runtime);
    await restBeforeSquat(running, 30);
    expect(ios.pending.get("svett-rest-timer")).toBe(30);

    await running.rest.adjustRestTimer(-45);

    expect(ios.pending.size).toBe(0);
  });
});

describe("a rest after svett is killed", () => {
  it("is running again at launch, with its notification still due when it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    const runtime = openApp();
    await startSquats(runtime);
    const before = await launch(runtime);
    await restBeforeSquat(before, 90);

    vi.setSystemTime(1_030_000);
    const after = await launch(runtime);
    await after.rest.restoreRestTimer(after.store.currentWorkout());

    expect(after.rest.currentRestTimer()).toMatchObject({
      endsAt: 1_090_000,
      exercise: "Barbell Squat",
    });
    expect(ios.pending.get("svett-rest-timer")).toBe(60);
  });

  it("is gone with its notification when its time ran out while svett was closed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    const runtime = openApp();
    await startSquats(runtime);
    const before = await launch(runtime);
    await restBeforeSquat(before, 90);

    vi.setSystemTime(1_120_000);
    const after = await launch(runtime);
    await after.rest.restoreRestTimer(after.store.currentWorkout());

    expect(after.rest.currentRestTimer()).toBeNull();
    expect(ios.pending.size).toBe(0);
    expect(defaults.has("svettRestTimer")).toBe(false);
  });

  it("is gone with its notification when its workout is gone", async () => {
    const runtime = openApp();
    await startSquats(runtime);
    const before = await launch(runtime);
    await restBeforeSquat(before, 90);
    const id = before.store.currentWorkout()!.activity.id;
    await runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.remove(id)),
    );

    const after = await launch(runtime);
    expect(after.store.currentWorkout()).toBeNull();
    await after.rest.restoreRestTimer(after.store.currentWorkout());

    expect(after.rest.currentRestTimer()).toBeNull();
    expect(ios.pending.size).toBe(0);
  });
});
