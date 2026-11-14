import { type AwayWindow, notificationDateMs } from "@svett/core";
import type { LocationObject } from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";

import { createStore } from "./store";

// Imported from index.ts, because iOS can start svett in the background for a
// location update, and the task has to be defined before anything renders.

/** The times svett was locked or behind another app. */
export const awayWindows = createStore<ReadonlyArray<AwayWindow>>([]);

AppState.addEventListener("change", (state) => {
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

Notifications.addNotificationReceivedListener((notification) => {
  const delivered = new Map(notificationsInSvett.get());
  delivered.set(notification.request.identifier, notificationDateMs(notification.date));
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
