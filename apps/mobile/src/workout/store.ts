import {
  type ActivityRepository,
  type ActivitySet,
  type ActivitySetId,
  loadWorkoutLog,
  withPrevious,
  type ExerciseRepository,
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
    }
  | { readonly status: "failed"; readonly message: string };

type Services = ActivityRepository | ExerciseRepository;

let state: WorkoutState = { status: "loading" };
const listeners = new Set<() => void>();

const publish = (next: WorkoutState) => {
  state = next;
  for (const listener of listeners) listener();
};

// Writes and reads run one at a time in the order they were asked for, so a read sees every
// change before it and a set typed fast is saved in the order typed.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = <A>(task: () => Promise<A>): Promise<A> => {
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
};

const read = async () => {
  try {
    const log = await appDatabase().runPromise(loadWorkoutLog);
    publish({ status: "ready", log: Option.getOrNull(log), problem: null });
  } catch (error) {
    publish({ status: "failed", message: String(error) });
  }
};

/** Reads the workout in progress again, after every change already asked for is saved. */
export const reloadWorkout = (): Promise<void> => enqueue(read);

const failed = (error: unknown) =>
  enqueue(async () => {
    await read();
    if (state.status === "ready") publish({ ...state, problem: String(error) });
  });

/**
 * Saves a change through the repositories, then shows what the database holds. Every change
 * to the workout goes through here, so a workout cut off mid-set reopens as it was.
 */
export const saveWorkout = <A>(effect: Effect.Effect<A, unknown, Services>): Promise<A | null> =>
  enqueue(async () => {
    const result = await appDatabase().runPromise(effect);
    await read();
    return result;
  }).catch(async (error: unknown) => {
    await failed(error);
    return null;
  });

/**
 * Shows a change at once and saves it behind, so a set marked done shows done within a frame
 * and a note keeps up with typing. A save that fails shows what the database holds, and why.
 */
export const changeWorkout = (
  change: (log: WorkoutLog) => WorkoutLog,
  save: Effect.Effect<unknown, unknown, Services>,
) => {
  if (state.status === "ready" && state.log !== null) {
    publish({ ...state, problem: null, log: change(state.log) });
  }
  void enqueue(() => appDatabase().runPromise(save)).catch(failed);
};

/** Shows a change to one set at once, with last time's sets lined up again, and saves it behind. */
export const changeSet = (
  id: ActivitySetId,
  patch: Partial<ActivitySet>,
  save: Effect.Effect<unknown, unknown, Services>,
) =>
  changeWorkout(
    (log) => ({
      ...log,
      exercises: log.exercises.map((exercise) =>
        exercise.sets.some((set) => set.id === id)
          ? withPrevious(
              {
                ...exercise,
                sets: exercise.sets.map((set) => (set.id === id ? { ...set, ...patch } : set)),
              },
              log.last.get(exercise.row.exerciseId),
            )
          : exercise,
      ),
    }),
    save,
  );

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const current = () => state;

/** The workout in progress as every screen and the bar above the tabs show it. */
export const useWorkout = (): WorkoutState => useSyncExternalStore(subscribe, current, current);

export const currentWorkout = (): WorkoutLog | null =>
  state.status === "ready" ? state.log : null;
