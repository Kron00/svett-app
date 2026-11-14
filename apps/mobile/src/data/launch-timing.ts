import { coldStart, coldStartText, type LaunchStep } from "@svett/core";
import { useSyncExternalStore } from "react";
import { Settings } from "react-native";

import SvettNative from "../../modules/svett-native";
import { scriptStartedAt } from "../launch-start";

/**
 * The plan's speed target: a cold start shows a usable Train tab in under 2 seconds. Each step
 * of the launch records when it first happened. Launching with `-svettTiming 1` shows the
 * result on the Train tab for the proof.
 */
export const showTiming = (): boolean => {
  const value: unknown = Settings.get("svettTiming");
  return value === "1" || value === 1 || value === true;
};

const marks = new Map<LaunchStep, number>([["script", scriptStartedAt]]);
let text: string | null = null;
const listeners = new Set<() => void>();

/** Records the first time `step` happens in this process. Later ones are not a cold start. */
export const markLaunch = (step: LaunchStep) => {
  if (marks.has(step)) return;
  marks.set(step, Date.now());
  const start = coldStart(SvettNative.launchedAt, marks);
  if (start === null || text !== null) return;
  text = coldStartText(start);
  for (const listener of listeners) listener();
};

/** Records `step` on the first frame drawn after now. */
export const markLaunchOnNextFrame = (step: LaunchStep) => {
  if (!marks.has(step)) requestAnimationFrame(() => markLaunch(step));
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The cold start's breakdown, or null until the routine list has been drawn. */
export const useColdStartText = (): string | null =>
  useSyncExternalStore(
    subscribe,
    () => text,
    () => text,
  );
