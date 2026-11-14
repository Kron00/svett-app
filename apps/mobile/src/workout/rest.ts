import {
  adjustRest,
  decodeRestTimer,
  type RestFor,
  restNotice,
  restNoticeSeconds,
  restStillRuns,
  type RestTimer,
  startRest,
  type WorkoutLog,
} from "@svett/core";
import * as Notifications from "expo-notifications";
import { useSyncExternalStore } from "react";
import { Settings } from "react-native";

// One rest at a time, so a new one replaces the notification of the last by this identifier.
const NOTIFICATION_ID = "svett-rest-timer";

// The running rest is kept in the phone's user defaults, like the workout in progress is kept
// in the database, so a killed svett opens with it still running. It is never exported or synced.
const KEPT = "svettRestTimer";

let timer: RestTimer | null = null;
const listeners = new Set<() => void>();

const show = (next: RestTimer | null) => {
  timer = next;
  Settings.set({ [KEPT]: next === null ? null : JSON.stringify(next) });
  for (const listener of listeners) listener();
};

// Asked once, the first time a rest starts. A refusal leaves the timer on screen only.
let permission: Promise<boolean> | null = null;
const allowed = () => {
  permission ??= Notifications.requestPermissionsAsync().then(
    ({ granted }) => granted,
    () => false,
  );
  return permission;
};

const cancelNotice = () =>
  Notifications.cancelScheduledNotificationAsync(NOTIFICATION_ID).catch(() => undefined);

// Notification changes run one at a time in the order asked, and each starts by cancelling.
// So a schedule that finishes late is always followed by the cancel of the change after it,
// and never brings back a notification that a skip, finish or discard took away. A change
// that a newer one has overtaken by the time its turn comes does nothing.
let latest = 0;
let changes: Promise<void> = Promise.resolve();

/**
 * Makes the notification match `rest`: due when it ends, or none. iOS shows it when svett is
 * in the background or the phone is locked. In front, the handler in checks/background.ts
 * keeps it quiet, because the timer on screen says the same.
 */
const notifyFor = (rest: RestTimer | null): Promise<void> => {
  const ticket = ++latest;
  const change = async () => {
    if (ticket !== latest) return;
    await cancelNotice();
    if (rest === null || !(await allowed()) || ticket !== latest) return;
    // Worked out only once permission is in, which can take as long as the person takes to
    // answer. A rest that ended meanwhile gets no notification.
    const seconds = restNoticeSeconds(rest, Date.now());
    if (seconds === null) return;
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: { ...restNotice(rest), sound: "default" },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds },
    }).catch(() => undefined);
  };
  changes = changes.then(change);
  return changes;
};

/** Starts a rest of `seconds` before the next set of `next`, replacing any rest running. */
export const startRestTimer = (seconds: number, next: RestFor) => {
  const rest = startRest(seconds, next, Date.now());
  show(rest);
  return notifyFor(rest);
};

/**
 * Moves the running rest by `seconds`, more or less, and its notification with it. A rest cut
 * to nothing loses its notification, and the timer goes as it reaches zero.
 */
export const adjustRestTimer = (seconds: number) => {
  if (timer === null) return changes;
  const rest = adjustRest(timer, seconds, Date.now());
  show(rest);
  return notifyFor(rest);
};

/** Ends the rest now, with no notification. Finishing or discarding the workout ends it too. */
export const skipRestTimer = () => {
  show(null);
  return notifyFor(null);
};

/** Clears a rest that ran out with svett in front, where its notification stays quiet. */
export const restEnded = (rest: RestTimer) => {
  if (timer === rest) show(null);
};

/**
 * Brings back the rest that was running when svett closed, once the workout in progress is
 * read. A rest that still runs keeps its notification. One whose time is up, or whose workout
 * or exercise is gone, ends, and its notification with it.
 */
export const restoreRestTimer = (log: WorkoutLog | null) => {
  if (timer !== null || latest !== 0) return changes;
  const kept = decodeRestTimer(Settings.get(KEPT));
  if (kept === null) return changes;
  const workout =
    log === null
      ? null
      : {
          activityId: log.activity.id,
          exerciseIds: log.exercises.map((exercise) => exercise.row.id),
        };
  if (!restStillRuns(kept, workout, Date.now())) return skipRestTimer();
  show(kept);
  return notifyFor(kept);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The running rest, or null. */
export const currentRestTimer = (): RestTimer | null => timer;

export const useRestTimer = (): RestTimer | null =>
  useSyncExternalStore(subscribe, currentRestTimer, currentRestTimer);
