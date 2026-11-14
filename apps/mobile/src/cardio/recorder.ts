import {
  type ActivityId,
  type CardioKind,
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

import { createStore } from "../checks/store";
import { appDatabase } from "../data/database";
import { write } from "../data/store";

// Imported from index.ts, because iOS starts svett in the background to hand it
// readings while the screen is locked, and the task must be defined before then.

export const CARDIO_TASK = "svett-cardio-location";

// The journal outlives the JavaScript that wrote it: a reload, a crash, or iOS
// ending svett in the background all leave the recording where it was.
const journal = new File(Paths.document, "svett-recording.jsonl");

/** The recording in progress, if there is one. */
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
    // Awaited, so iOS does not suspend svett before the readings are in the journal.
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

export async function startRecording(kind: CardioKind): Promise<StartOutcome> {
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
    await appDatabase().runPromise(recorder.start(kind));
  } catch (error) {
    return failedAt("start", error);
  }
  recordingProblem.set(undefined);
  return { kind: "started" };
}

/** Pauses, or leaves the reason it could not in `recordingProblem`. */
export const pauseRecording = () =>
  tracked(Effect.runPromise(recorder.pause)).catch(() => undefined);

/** Resumes, or stays paused and leaves the reason in `recordingProblem`. */
export const resumeRecording = () =>
  tracked(Effect.runPromise(recorder.resume)).catch(() => undefined);

/** Saves the recording as an activity and returns its ID. History and every other screen read again. */
export const finishRecording = (): Promise<ActivityId> => tracked(write(recorder.finish));

export const discardRecording = () =>
  tracked(Effect.runPromise(recorder.discard)).catch(() => undefined);
