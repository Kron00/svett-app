import { formatDuration, DurationSeconds } from "@svett/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Settings } from "react-native";

/**
 * The plan's speed target: a set marked done shows done in under 100 milliseconds. A press
 * records when it happened, and the row records the first frame drawn after it shows done.
 * Launching with `-svettTiming 1` shows the last time on the workout screen for the proof.
 */
export const showTiming = (): boolean => {
  const value: unknown = Settings.get("svettTiming");
  return value === "1" || value === 1 || value === true;
};

const pressed = new Map<string, number>();
let last: number | null = null;
const listeners = new Set<() => void>();

export const timeDonePress = (setId: string) => {
  pressed.set(setId, performance.now());
};

/** Called when a row shows done. Waits for the frame that draws it. */
export const shownDone = (setId: string) => {
  const start = pressed.get(setId);
  if (start === undefined) return;
  pressed.delete(setId);
  requestAnimationFrame(() => {
    last = performance.now() - start;
    for (const listener of listeners) listener();
  });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Milliseconds from the last press on a done box to the frame that showed it done. */
export const useLastDoneTiming = (): number | null =>
  useSyncExternalStore(
    subscribe,
    () => last,
    () => last,
  );

/** The time since `startedAt`, such as "42:07", moving on each second. */
export function useElapsed(startedAt: number): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return formatDuration(DurationSeconds.make(Math.max(0, (now - startedAt) / 1000)));
}
