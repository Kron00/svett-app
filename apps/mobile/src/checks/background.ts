import type { AwayWindow } from "@svett/core";
import type { LocationObject } from "expo-location";
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
