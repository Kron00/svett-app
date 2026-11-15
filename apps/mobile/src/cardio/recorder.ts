import {
  type ActivityId,
  type CardioKind,
  type DatabaseOwner,
  fixOf,
  type LocationReading,
  makeRecorder,
  RecorderError,
  type Recording,
} from "@svett/core";
import { Effect } from "effect";
import { File, Paths } from "expo-file-system";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { createStore, useStore } from "../checks/store";
import { type OpenDatabase, sameOwner, stillOpen, useCurrentDatabase } from "../data/current";
import { quietWriteTo, SWITCHED_BEFORE_WRITE, writeRefusal, writeTo } from "../data/store";
import { holdOpen } from "../data/turns";

// Imported from index.ts, because iOS starts svett in the background to hand it
// readings while the screen is locked, and the task must be defined before then.

export const CARDIO_TASK = "svett-cardio-location";

// The journal outlives the JavaScript that wrote it: a reload, a crash, or iOS
// ending svett in the background all leave the recording where it was.
const journal = new File(Paths.document, "svett-recording.jsonl");

/**
 * The recording in progress on this phone, whoever started it. It saves into the database open
 * when it started, and shows only while that database is open again, through `useRecording`.
 */
export const recording = createStore<Recording | undefined>(undefined);

const recorder = makeRecorder({
  journal: {
    read: () => (journal.exists ? journal.textSync() : ""),
    append: (text) => journal.write(text, { append: true }),
    remove: async () => {
      if (journal.exists) journal.delete();
    },
  },
  location: {
    start: async () => {
      // iOS may relaunch svett in the background with the updates still on.
      if (await Location.hasStartedLocationUpdatesAsync(CARDIO_TASK)) return;
      await Location.startLocationUpdatesAsync(CARDIO_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 0,
        activityType: Location.ActivityType.Fitness,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      });
    },
    stop: async () => {
      if (await Location.hasStartedLocationUpdatesAsync(CARDIO_TASK)) {
        await Location.stopLocationUpdatesAsync(CARDIO_TASK);
      }
    },
  },
  localHour: (at) => new Date(at).getHours(),
  onChange: recording.set,
});
recording.set(recorder.get());

/** Why the last change to the recording did not happen, until one does. */
export const recordingProblem = createStore<string | undefined>(undefined);

const problemOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const tracked = async <A>(change: Promise<A>): Promise<A> => {
  try {
    const result = await change;
    recordingProblem.set(undefined);
    return result;
  } catch (error) {
    recordingProblem.set(problemOf(error));
    throw error;
  }
};

let lostReadings: string | undefined;

TaskManager.defineTask<{ locations: ReadonlyArray<LocationReading> }>(
  CARDIO_TASK,
  async ({ data, error }) => {
    if (error !== null) return;
    // Readings join the recording whoever is signed in now, since it saves into the database
    // it started in. Awaited, so iOS does not suspend svett before they are in the journal.
    try {
      await Effect.runPromise(recorder.addFixes(data.locations.map(fixOf)));
      // Only its own problem, so a reading saved does not hide why a pause failed.
      if (lostReadings !== undefined && recordingProblem.get() === lostReadings) {
        recordingProblem.set(undefined);
      }
      lostReadings = undefined;
    } catch (cause) {
      lostReadings = `GPS readings are being lost. ${problemOf(cause)}`;
      recordingProblem.set(lostReadings);
    }
  },
);

// iOS stops the updates when svett is closed from the app switcher. Opening svett
// again picks the recording back up, or pauses it when GPS will not start.
void tracked(Effect.runPromise(recorder.restore)).catch(() => undefined);

/** Where a start failed, in asking for location or in one of the recorder's steps. */
export type StartStep = "permission" | "start" | RecorderError["step"];

export type StartOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "denied" }
  | { readonly kind: "error"; readonly step: StartStep; readonly message: string };

const failedAt = (step: StartStep, error: unknown): StartOutcome => ({
  kind: "error",
  step: error instanceof RecorderError ? error.step : step,
  message: problemOf(error),
});

/** Why someone else's recording blocks this owner, and the way back to it from here. */
export const otherOwnerRecording = (owner: DatabaseOwner): string =>
  owner.kind === "anonymous"
    ? "A recording started before you signed in is still going on this phone. Sign out to finish it, or discard it here."
    : "A recording started in another account is still going on this phone. Sign in to that account to finish it, or discard it here.";

/** The recording `database`'s owner sees: theirs, and never another owner's. */
export const shownRecording = (database: OpenDatabase): Recording | undefined => {
  const current = recording.get();
  return current !== undefined && sameOwner(current.owner, database.owner) ? current : undefined;
};

/** Whose recording is going on this phone when it is not `database`'s owner's. */
const otherOwner = (database: OpenDatabase): DatabaseOwner | undefined => {
  const current = recording.get();
  return current === undefined || sameOwner(current.owner, database.owner)
    ? undefined
    : current.owner;
};

/**
 * The recording in progress for the open database, with the database it saves into. Another
 * owner's recording goes on in the background, and only its owner shows here, so it can be
 * discarded without anything of its route, distance or times.
 */
export function useRecording(): {
  readonly current: Recording | undefined;
  readonly database: OpenDatabase;
  readonly otherOwner: DatabaseOwner | undefined;
} {
  useStore(recording);
  const database = useCurrentDatabase();
  return { current: shownRecording(database), database, otherOwner: otherOwner(database) };
}

/**
 * Why a change made from `database`, the one a screen showed, would be refused now, or null:
 * someone signed in or out since, a move is unfinished, or another owner's recording is going.
 */
const changeRefusal = (database: OpenDatabase): string | null => {
  const owner = otherOwner(database);
  return writeRefusal(database) ?? (owner === undefined ? null : otherOwnerRecording(owner));
};

/** Starts a recording that saves into `database`, the one the Record screen showed. */
export async function startRecording(
  kind: CardioKind,
  database: OpenDatabase,
): Promise<StartOutcome> {
  const refusal = changeRefusal(database);
  if (refusal !== null) return { kind: "error", step: "start", message: refusal };
  // Either request can reject, such as when iOS reports a location error while it asks.
  try {
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) return { kind: "denied" };
    // With only While Using, iOS still records with the screen locked, since the
    // recording started in front and shows the location indicator.
    await Location.requestBackgroundPermissionsAsync();
  } catch (error) {
    return failedAt("permission", error);
  }
  try {
    await quietWriteTo(database, recorder.start(kind, database.owner));
  } catch (error) {
    return failedAt("start", error);
  }
  recordingProblem.set(undefined);
  return { kind: "started" };
}

/** Refuses with why, leaving `recordingProblem` for the phone refusing a change. */
const refuseUnlessShown = (database: OpenDatabase) => {
  const refusal = changeRefusal(database);
  if (refusal !== null) throw new Error(refusal);
};

/** Pauses, or leaves the reason it could not in `recordingProblem`. */
export const pauseRecording = async (database: OpenDatabase) => {
  refuseUnlessShown(database);
  await tracked(Effect.runPromise(recorder.pause)).catch(() => undefined);
};

/** Resumes, or stays paused and leaves the reason in `recordingProblem`. */
export const resumeRecording = async (database: OpenDatabase) => {
  refuseUnlessShown(database);
  await tracked(Effect.runPromise(recorder.resume)).catch(() => undefined);
};

/**
 * Saves the recording into `database`, the one it started in, as an activity and returns its
 * ID. History and every other screen read again. The database stays open until it is saved,
 * even when someone signs in or out meanwhile.
 */
export const finishRecording = async (database: OpenDatabase): Promise<ActivityId> => {
  refuseUnlessShown(database);
  return tracked(holdOpen(writeTo(database, recorder.finish)));
};

export const discardRecording = async (database: OpenDatabase) => {
  refuseUnlessShown(database);
  await tracked(Effect.runPromise(recorder.discard)).catch(() => undefined);
};

/**
 * Discards another owner's recording, `owner`'s, from `database`'s Record screen: stops GPS and
 * deletes the journal. It saves nothing, into neither owner's database.
 */
export const discardOtherRecording = async (database: OpenDatabase, owner: DatabaseOwner) => {
  if (!stillOpen(database)) throw new Error(SWITCHED_BEFORE_WRITE);
  const going = otherOwner(database);
  if (going === undefined || !sameOwner(going, owner)) return;
  await tracked(Effect.runPromise(recorder.discard));
};
