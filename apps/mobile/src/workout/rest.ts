import { adjustRest, restNotice, type RestTimer, startRest } from "@svett/core";
import * as Notifications from "expo-notifications";
import { useSyncExternalStore } from "react";

// One rest at a time, so a new one replaces the notification of the last by this identifier.
const NOTIFICATION_ID = "svett-rest-timer";

let timer: RestTimer | null = null;
const listeners = new Set<() => void>();

const show = (next: RestTimer | null) => {
  timer = next;
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

/**
 * Schedules the local notification that ends the rest. iOS shows it when svett is in the
 * background or the phone is locked. In front, the handler in checks/background.ts keeps it
 * quiet, because the timer on screen says the same.
 */
const scheduleNotice = async (rest: RestTimer) => {
  await cancelNotice();
  if (!(await allowed()) || timer !== rest) return;
  const seconds = Math.max(1, Math.round((rest.endsAt - Date.now()) / 1000));
  await Notifications.scheduleNotificationAsync({
    identifier: NOTIFICATION_ID,
    content: { ...restNotice(rest), sound: "default" },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds },
  }).catch(() => undefined);
};

/** Starts a rest of `seconds`, replacing any rest already running. */
export const startRestTimer = (seconds: number, exercise: string) => {
  const rest = startRest(seconds, exercise, Date.now());
  show(rest);
  void scheduleNotice(rest);
};

/** Moves the running rest by `seconds`, more or less, and its notification with it. */
export const adjustRestTimer = (seconds: number) => {
  if (timer === null) return;
  const rest = adjustRest(timer, seconds, Date.now());
  show(rest);
  void scheduleNotice(rest);
};

/** Ends the rest now, with no notification. Finish and discard end it too. */
export const skipRestTimer = () => {
  show(null);
  void cancelNotice();
};

/** Clears a rest that ran out with svett in front, where its notification stays quiet. */
export const restEnded = (rest: RestTimer) => {
  if (timer === rest) show(null);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const current = () => timer;

export const useRestTimer = (): RestTimer | null =>
  useSyncExternalStore(subscribe, current, current);
