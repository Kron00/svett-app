import {
  coldStart,
  coldStartText,
  LAUNCH_STEPS,
  type LaunchStep,
  reactNativeSteps,
  type ReactNativeStartupTiming,
} from "@svett/core";
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

const isStep = (step: string): step is LaunchStep =>
  (LAUNCH_STEPS as ReadonlyArray<string>).includes(step);

const marks = new Map<LaunchStep, number>([
  ["process", SvettNative.launchedAt],
  ...Object.entries(SvettNative.launchMarks).flatMap(([step, at]) =>
    isStep(step) ? [[step, at] as const] : [],
  ),
  ["script", scriptStartedAt],
]);
let text: string | null = null;
const listeners = new Set<() => void>();

// React Native finishes its startup timing when the bundle has run, long before the routine
// list shows, so it is read then.
const addReactNativeSteps = () => {
  const timing = (performance as { rnStartupTiming?: ReactNativeStartupTiming }).rnStartupTiming;
  for (const [step, at] of reactNativeSteps(timing, Date.now() - performance.now())) {
    if (!marks.has(step)) marks.set(step, at);
  }
};

/**
 * Records the first time `step` happens in this process. Later ones are not a cold start. A
 * step recorded after the routine list was drawn still joins the text.
 */
export const markLaunch = (step: LaunchStep) => {
  if (marks.has(step)) return;
  marks.set(step, Date.now());
  if (step === "shown") addReactNativeSteps();
  const start = coldStart(marks, SvettNative.prewarmed);
  if (start === null) return;
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
