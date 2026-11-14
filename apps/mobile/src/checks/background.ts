import { type AwayWindow, deliveredInFront } from "@svett/core";
import type { LocationObject } from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";

import { loadPendingNotification, savePendingNotification } from "./saved";
import { createStore } from "./store";

// Imported from index.ts, because iOS can start svett in the background for a
// location update, and the task has to be defined before anything renders.

/** The times svett was locked or behind another app. */
export const awayWindows = createStore<ReadonlyArray<AwayWindow>>([]);

AppState.addEventListener("change", (state) => {
  console.warn("svett-diag appstate", state, Date.now());
  const windows = awayWindows.get();
  const last = windows.at(-1);
  const away = last !== undefined && last.to === undefined;
  if (state === "active" && away) {
    awayWindows.set([...windows.slice(0, -1), { from: last.from, to: Date.now() }]);
  } else if (state !== "active" && !away) {
    awayWindows.set([...windows, { from: Date.now() }]);
  }
});

export const LOCATION_TASK = "svett-phone-check-location";

/** When each location delivered to the task was measured. */
export const locationPoints = createStore<ReadonlyArray<number>>([]);

TaskManager.defineTask<{ locations: LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error !== null) return;
  locationPoints.set([...locationPoints.get(), ...data.locations.map((l) => l.timestamp)]);
});

/** Notifications iOS handed to svett while it was in front, by identifier, with when. */
export const notificationsInSvett = createStore<ReadonlyMap<string, number>>(new Map());

// The handler below keeps this notification out of Notification Center, so the delivery is
// saved with the pending check before the check can see it and forget that record. Otherwise
// a restart would find neither and judge it not delivered.
Notifications.addNotificationReceivedListener(async (notification) => {
  console.warn("svett-diag received", notification.request.identifier, notification.date, AppState.currentState);
  const at = deliveredInFront(AppState.currentState, notification.date);
  if (at === undefined) return;
  const id = notification.request.identifier;
  const pending = await loadPendingNotification();
  if (pending?.id === id) {
    await savePendingNotification({ ...pending, deliveredInSvett: at }).catch(() => undefined);
  }
  const delivered = new Map(notificationsInSvett.get());
  delivered.set(id, at);
  notificationsInSvett.set(delivered);
});

// Without a handler Expo shows a notification that arrives while svett is in front, and it
// lands in Notification Center. Hiding it keeps that list to notifications iOS showed while
// svett was away, which is what the notification check reads.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});
