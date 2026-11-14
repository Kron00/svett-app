import {
  type ActivityRepository,
  type ActivitySet,
  type ActivitySetId,
  loadWorkoutLog,
  withPrevious,
  type ExerciseRepository,
  type SetFields,
  type WorkoutLog,
} from "@svett/core";
import { type Effect, Option } from "effect";
import { useSyncExternalStore } from "react";

import { appDatabase } from "../data/database";

export type WorkoutState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      /** The workout in progress, or null when there is none. */
      readonly log: WorkoutLog | null;
      /** Why the last change was not saved. The workout shows what the database holds. */
      readonly problem: string | null;
      /** How many saves have failed since launch. A field typed before the last one shows what is stored. */
      readonly failures: number;
    }
  | { readonly status: "failed"; readonly message: string };

type Services = ActivityRepository | ExerciseRepository;
type Change = (log: WorkoutLog) => WorkoutLog;

/** What the database holds: the last read, with each change saved since. */
let saved: WorkoutState = { status: "loading" };
/** Changes shown before they are saved, oldest first. Each read is shown with them on top. */
let unsaved: ReadonlyArray<{ readonly change: Change }> = [];
let state: WorkoutState = saved;
let failures = 0;
const listeners = new Set<() => void>();

const show = () => {
  state =
    saved.status === "ready" && saved.log !== null
      ? { ...saved, log: unsaved.reduce((log, { change }) => change(log), saved.log) }
      : saved;
  for (const listener of listeners) listener();
};

const keepSaved = (change: Change, problem: string | null = null) => {
  if (saved.status === "ready") {
    saved = { ...saved, problem, log: saved.log === null ? null : change(saved.log) };
  }
};

// Writes and reads run one at a time in the order they were asked for, so a read sees every
// change before it and a set typed fast is saved in the order typed. A change still waiting
// in the queue is newer than any read ahead of it, so it stays on top of what that read shows.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = <A>(task: () => Promise<A>): Promise<A> => {
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
};

const run = <A>(effect: Effect.Effect<A, unknown, Services>) => appDatabase().runPromise(effect);

const read = async () => {
  try {
    const log = await run(loadWorkoutLog);
    saved = { status: "ready", log: Option.getOrNull(log), problem: null, failures };
  } catch (error) {
    saved = { status: "failed", message: String(error) };
  }
  show();
};

/** Reads the workout in progress again, after every change already asked for is saved. */
export const reloadWorkout = (): Promise<void> => enqueue(read);

const failed = (error: unknown) =>
  enqueue(async () => {
    failures += 1;
    await read();
    keepSaved((log) => log, String(error));
    show();
  });

/**
 * Saves a change through the repositories, then shows what the database holds. Every change
 * to the workout goes through here, so a workout cut off mid-set reopens as it was.
 */
export const saveWorkout = <A>(effect: Effect.Effect<A, unknown, Services>): Promise<A | null> =>
  enqueue(async () => {
    const result = await run(effect);
    await read();
    return result;
  }).catch(async (error: unknown) => {
    await failed(error);
    return null;
  });

/**
 * Saves a change and shows it. Typing shows at once and saves behind, so a note keeps up with
 * the keys. A change the user is told is kept, such as a set marked done, shows only once it
 * is saved, so a killed app never loses what it showed. A save that fails shows what the
 * database holds, and why.
 */
export const changeWorkout = (
  change: Change,
  save: Effect.Effect<unknown, unknown, Services>,
  shown: "now" | "once saved" = "now",
) => {
  const edit = { change };
  if (shown === "now") {
    unsaved = [...unsaved, edit];
    show();
  }
  void enqueue(async () => {
    try {
      await run(save);
    } finally {
      unsaved = unsaved.filter((other) => other !== edit);
    }
    keepSaved(change);
    show();
  }).catch(failed);
};

/**
 * Shows a change to one set, with last time's sets lined up again, and saves it. A patch that
 * depends on the set is worked out from the set as shown at the time, so it builds on every
 * change before it, saved or not.
 */
export const changeSet = (
  id: ActivitySetId,
  patch: Partial<ActivitySet> | ((set: ActivitySet, fields: SetFields) => Partial<ActivitySet>),
  save: Effect.Effect<unknown, unknown, Services>,
  shown: "now" | "once saved" = "now",
) =>
  changeWorkout(
    (log) => ({
      ...log,
      exercises: log.exercises.map((exercise) =>
        exercise.sets.some((set) => set.id === id)
          ? withPrevious(
              {
                ...exercise,
                sets: exercise.sets.map((set) =>
                  set.id === id
                    ? {
                        ...set,
                        ...(typeof patch === "function"
                          ? patch(set, exercise.row.setFields)
                          : patch),
                      }
                    : set,
                ),
              },
              log.last.get(exercise.row.exerciseId),
            )
          : exercise,
      ),
    }),
    save,
    shown,
  );

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The workout in progress as every screen and the bar above the tabs show it. */
export const workoutState = (): WorkoutState => state;

export const useWorkout = (): WorkoutState =>
  useSyncExternalStore(subscribe, workoutState, workoutState);

export const currentWorkout = (): WorkoutLog | null =>
  state.status === "ready" ? state.log : null;
