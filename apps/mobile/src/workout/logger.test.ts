import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addExercisesToWorkout,
  databaseLayer,
  Ids,
  libraryExerciseId,
  type SqlDriver,
  startEmptyWorkout,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const app = vi.hoisted(() => ({ runtime: undefined as unknown }));
vi.mock("../data/database", () => ({ appDatabase: () => app.runtime }));

const squat = libraryExerciseId("Barbell_Squat");
const plank = libraryExerciseId("Plank");

/**
 * The app's database on a node:sqlite file. Set writes can be held, as a slow disk would, to
 * look at the screen while a save is still on its way.
 */
const openApp = (path: string) => {
  const { database, driver } = openNodeDatabase(path);
  let held: Array<() => void> | null = null;
  let reached = () => {};
  const slow: SqlDriver = {
    ...driver,
    run: async (sql, params) => {
      if (held !== null && sql.startsWith("UPDATE activity_set")) {
        reached();
        await new Promise<void>((resume) => held!.push(resume));
      }
      return driver.run(sql, params);
    },
  };
  const runtime = ManagedRuntime.make(databaseLayer(slow, Ids.layerSeeded(1)));
  return {
    database,
    runtime,
    /** Holds the next set writes. Resolves once one is waiting. */
    hold: () => {
      held = [];
      return new Promise<void>((resolve) => (reached = resolve));
    },
    release: () => {
      const waiting = held ?? [];
      held = null;
      for (const resume of waiting) resume();
    },
  };
};

/** A fresh copy of the store and actions, as a launch of the app gets. */
const launch = async (runtime: unknown) => {
  app.runtime = runtime;
  vi.resetModules();
  const store = await import("./store");
  const actions = await import("./actions");
  const focus = await import("./focus");
  await store.reloadWorkout();
  return { store, actions, focus };
};

type Launched = Awaited<ReturnType<typeof launch>>;

const shownSet = ({ store }: Launched) => store.currentWorkout()!.exercises[0]!.sets[0]!;

const startSquats = (runtime: ReturnType<typeof openApp>["runtime"]) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const id = yield* startEmptyWorkout(9);
      yield* addExercisesToWorkout(id, [squat]);
    }),
  );

const tempFile = () => join(mkdtempSync(join(tmpdir(), "svett-logger-")), "svett.db");

afterEach(() => {
  app.runtime = undefined;
});

describe("the workout store", () => {
  it("shows a set done only once it is saved, so killing the app loses nothing shown", async () => {
    const path = tempFile();
    const first = openApp(path);
    await startSquats(first.runtime);
    const running = await launch(first.runtime);
    const set = shownSet(running);
    running.actions.typeValue(running.store.currentWorkout()!.exercises[0]!, set, "reps", 5);
    await running.store.reloadWorkout();

    const waiting = first.hold();
    expect(running.actions.toggleSetDone(running.store.currentWorkout()!.exercises[0]!, 0)).toBe(
      null,
    );
    await waiting;
    expect(shownSet(running).done).toBe(false);

    // The app is killed with the write still on its way. SQLite rolls back what never committed.
    first.database.close();
    const second = openApp(path);
    const reopened = await launch(second.runtime);
    expect(shownSet(reopened)).toMatchObject({ reps: 5, done: false });
    second.database.close();
  });

  it("shows a set done as soon as its write commits", async () => {
    const opened = openApp(":memory:");
    await startSquats(opened.runtime);
    const running = await launch(opened.runtime);
    running.actions.typeValue(
      running.store.currentWorkout()!.exercises[0]!,
      shownSet(running),
      "reps",
      5,
    );

    const waiting = opened.hold();
    running.actions.toggleSetDone(running.store.currentWorkout()!.exercises[0]!, 0);
    await waiting;
    expect(shownSet(running).done).toBe(false);
    opened.release();
    await running.store.reloadWorkout();
    expect(shownSet(running)).toMatchObject({ reps: 5, done: true });
    const stored = opened.database
      .prepare("SELECT reps, done FROM activity_set WHERE id = ?")
      .get(shownSet(running).id);
    expect(stored).toEqual({ reps: 5, done: 1 });
  });

  it("keeps typing shown when a read that started before it finishes after it", async () => {
    const opened = openApp(":memory:");
    await startSquats(opened.runtime);
    const running = await launch(opened.runtime);
    const { store, actions } = running;
    const notes = () => store.currentWorkout()!.activity.notes;
    const storedNotes = () =>
      opened.database.prepare("SELECT notes FROM activity").get() as { notes: string };

    actions.setWorkoutNotes("original");
    await store.reloadWorkout();
    const read = store.reloadWorkout();
    actions.setWorkoutNotes("edited");
    actions.typeValue(store.currentWorkout()!.exercises[0]!, shownSet(running), "reps", 8);
    expect(notes()).toBe("edited");
    await read;
    expect(notes()).toBe("edited");
    expect(shownSet(running).reps).toBe(8);

    // More typing builds on what is shown, so it never writes the older text back.
    actions.setWorkoutNotes(`${notes()}, belt on`);
    await store.reloadWorkout();
    expect(notes()).toBe("edited, belt on");
    expect(storedNotes()).toEqual({ notes: "edited, belt on" });
    expect(shownSet(running).reps).toBe(8);
  });

  it("drops the keypad's field when its exercise is replaced while typing", async () => {
    const opened = openApp(":memory:");
    await startSquats(opened.runtime);
    const running = await launch(opened.runtime);
    const { store, actions, focus } = running;
    const exercise = store.currentWorkout()!.exercises[0]!;
    let field = focus.focusField(exercise, exercise.sets[0]!, "weight");
    for (const key of ["1", "0"] as const) {
      const typed = focus.pressKey(store.currentWorkout()!, field, key)!;
      field = typed.focus;
      actions.typeValue(typed.exercise, typed.set, field.column, typed.value);
    }
    await store.reloadWorkout();
    expect(shownSet(running).weightKg).toBe(10);

    actions.replaceExercise(exercise.row.id, plank);
    await store.reloadWorkout();
    const replaced = store.currentWorkout()!;
    expect(replaced.exercises[0]!.sets[0]!.id).toBe(field.setId);
    expect(focus.liveFocus(replaced, field)).toBeNull();
    expect(focus.pressKey(replaced, field, "5")).toBeNull();
    await store.reloadWorkout();
    expect(shownSet(running)).toMatchObject({ weightKg: null, reps: null });
  });
});
