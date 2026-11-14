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

import {
  currentDatabase,
  type OpenDatabase,
  sameDatabase,
  stillOpen,
  subscribeDatabase,
} from "../data/current";
import { writeAccepted, writeRefusal } from "../data/store";
import { holdOpen } from "../data/turns";
import { skipRestTimer } from "./rest";

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
/**
 * The database the workout shown was read from. A workout in progress is a draft in the
 * database it was started in, so each change to it saves there and nowhere else. It stays the
 * previous owner's after a switch until the next owner's workout is read, so a change made
 * to what was shown in between is refused.
 */
let shownFrom: OpenDatabase | null = null;
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

const read = async () => {
  const database = currentDatabase();
  try {
    const log = await database.handle.runtime.runPromise(loadWorkoutLog);
    // Someone signed in or out during the read, and the read queued by the switch shows theirs.
    if (!stillOpen(database)) return;
    saved = { status: "ready", log: Option.getOrNull(log), problem: null, failures };
  } catch (error) {
    if (!stillOpen(database)) return;
    saved = { status: "failed", message: String(error) };
  }
  shownFrom = database;
  show();
};

/** The database a change to the workout shown is meant for. */
const target = (): OpenDatabase => shownFrom ?? currentDatabase();

/**
 * Signing in or out opens another database, with its own workout in progress or none. The
 * previous owner's workout stays in their database, and nothing of it shows here, its rest
 * timer included. Changes made to it before the switch still save there, ahead of the read.
 */
subscribeDatabase(() => {
  if (
    shownFrom !== null &&
    !sameDatabase(shownFrom, currentDatabase()) &&
    saved.status !== "loading"
  ) {
    saved = { status: "loading" };
    unsaved = [];
    failures = 0;
    show();
    void skipRestTimer();
  }
  void enqueue(read);
});

/** Reads the workout in progress again, after every change already asked for is saved. */
export const reloadWorkout = (): Promise<void> => enqueue(read);

/** Shows what the database holds, and why the last change was not saved. */
const refused = (error: unknown) =>
  enqueue(async () => {
    failures += 1;
    await read();
    keepSaved((log) => log, String(error));
    show();
  });

const failed = (database: OpenDatabase, error: unknown) =>
  // The previous owner's workout is not on screen any more, so its failure is not this one's.
  sameDatabase(database, currentDatabase()) ? refused(error) : Promise.resolve();

/**
 * Saves a change to the workout in `database` in its turn, even when someone signs in or out
 * before the turn comes, because the change was made to that database's workout. The database
 * stays open until it is saved, so signing back in shows it.
 */
const saveInTurn = <A>(task: () => Promise<A>): Promise<A> => holdOpen(enqueue(task));

/**
 * Saves a change through the repositories, then shows what the database holds. Every change
 * to the workout goes through here, so a workout cut off mid-set reopens as it was. A change
 * that reaches history, such as a finish, passes `everywhere` so every other screen reads again.
 */
export const saveWorkout = <A>(
  effect: Effect.Effect<A, unknown, Services>,
  everywhere = false,
  database: OpenDatabase = target(),
): Promise<A | null> => {
  // Only a change made once another database is open, or while a move is unfinished, is refused.
  const refusal = writeRefusal(database);
  if (refusal !== null) return refused(new Error(refusal)).then(() => null);
  return saveInTurn(async () => {
    const result = await writeAccepted(database, effect, everywhere);
    await read();
    return result;
  }).catch(async (error: unknown) => {
    await failed(database, error);
    return null;
  });
};

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
  const database = target();
  const refusal = writeRefusal(database);
  if (refusal !== null) {
    void refused(new Error(refusal));
    return;
  }
  if (shown === "now") {
    unsaved = [...unsaved, edit];
    show();
  }
  void saveInTurn(async () => {
    try {
      await writeAccepted(database, save, false);
    } finally {
      unsaved = unsaved.filter((other) => other !== edit);
    }
    keepSaved(change);
    show();
  }).catch((error: unknown) => failed(database, error));
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
