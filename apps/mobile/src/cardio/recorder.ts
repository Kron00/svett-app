import {
  type ActivityId,
  ActivityRepository,
  applyEvent,
  type CardioKind,
  cardioDraft,
  cardioTitle,
  encodeRecordingEvent,
  fixOf,
  isPaused,
  type LocationReading,
  parseJournal,
  type Recording,
  type RecordingEvent,
  replay,
  summarize,
} from "@svett/core";
import { Effect } from "effect";
import { File, Paths } from "expo-file-system";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { createStore } from "../checks/store";
import { appDatabase } from "../data/database";

// Imported from index.ts, because iOS starts svett in the background to hand it
// readings while the screen is locked, and the task must be defined before then.

export const CARDIO_TASK = "svett-cardio-location";

// The journal outlives the JavaScript that wrote it: a reload, a crash, or iOS
// ending svett in the background all leave the recording where it was.
const journal = new File(Paths.document, "svett-recording.jsonl");

const readJournal = (): ReadonlyArray<RecordingEvent> => {
  try {
    return journal.exists ? parseJournal(journal.textSync()) : [];
  } catch {
    return [];
  }
};

/** The recording in progress, if there is one. */
export const recording = createStore<Recording | undefined>(replay(readJournal()));

const record = (events: ReadonlyArray<RecordingEvent>) => {
  if (events.length === 0) return;
  journal.write(events.map((event) => `${encodeRecordingEvent(event)}\n`).join(""), {
    append: true,
  });
  recording.set(events.reduce(applyEvent, recording.get()));
};

const forget = () => {
  if (journal.exists) journal.delete();
  recording.set(undefined);
};

TaskManager.defineTask<{ locations: ReadonlyArray<LocationReading> }>(
  CARDIO_TASK,
  async ({ data, error }) => {
    // Readings that arrive after Finish or Discard would start a new journal.
    if (error !== null || recording.get() === undefined) return;
    record(data.locations.map((location) => ({ type: "fix", fix: fixOf(location) })));
  },
);

const startUpdates = () =>
  Location.startLocationUpdatesAsync(CARDIO_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    distanceInterval: 0,
    activityType: Location.ActivityType.Fitness,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  });

const stopUpdates = async () => {
  if (await Location.hasStartedLocationUpdatesAsync(CARDIO_TASK)) {
    await Location.stopLocationUpdatesAsync(CARDIO_TASK);
  }
};

// iOS stops the updates when svett is closed from the app switcher. Opening svett
// again picks the recording back up.
const current = recording.get();
if (current !== undefined && !isPaused(current)) {
  void Location.hasStartedLocationUpdatesAsync(CARDIO_TASK)
    .then((started) => (started ? undefined : startUpdates()))
    .catch(() => undefined);
}

export type StartOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "denied" }
  | { readonly kind: "error"; readonly message: string };

export async function startRecording(kind: CardioKind): Promise<StartOutcome> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) return { kind: "denied" };
  // With only While Using, iOS still records with the screen locked, since the
  // recording started in front and shows the location indicator.
  await Location.requestBackgroundPermissionsAsync();
  record([{ type: "start", at: Date.now(), kind }]);
  try {
    await startUpdates();
  } catch (error) {
    forget();
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  return { kind: "started" };
}

export async function pauseRecording() {
  record([{ type: "pause", at: Date.now() }]);
  await stopUpdates();
}

export async function resumeRecording() {
  record([{ type: "resume", at: Date.now() }]);
  await startUpdates();
}

/** Saves the recording as an activity and returns its ID. */
export async function finishRecording(): Promise<ActivityId> {
  const finished = recording.get();
  if (finished === undefined) throw new Error("There is no recording to finish");
  await stopUpdates();
  const summary = summarize(finished, Date.now());
  const title = cardioTitle(finished.kind, new Date(finished.startedAt).getHours());
  const id = await appDatabase().runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.create(cardioDraft(summary, title)),
    ),
  );
  forget();
  return id;
}

export async function discardRecording() {
  await stopUpdates();
  forget();
}
