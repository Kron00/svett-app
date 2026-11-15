import { parseWorkoutSettings, type WorkoutSettings } from "@svett/core";
import { useSyncExternalStore } from "react";
import { Settings } from "react-native";

// Kept in the phone's user defaults, not the database: they say how this phone shows and
// types weights, and change nothing that is stored.
const KEY = "svettWorkoutSettings";

let current: WorkoutSettings = parseWorkoutSettings(Settings.get(KEY));
const listeners = new Set<() => void>();

export const workoutSettings = (): WorkoutSettings => current;

/** Saves a change to the settings and shows it on every screen at once. */
export const changeWorkoutSettings = (change: (settings: WorkoutSettings) => WorkoutSettings) => {
  current = change(current);
  Settings.set({ [KEY]: JSON.stringify(current) });
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useWorkoutSettings = (): WorkoutSettings =>
  useSyncExternalStore(subscribe, workoutSettings, workoutSettings);
