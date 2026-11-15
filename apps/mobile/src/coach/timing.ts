import { useSyncExternalStore } from "react";

/**
 * The plan's speed target: a coach answer's first words show as soon as OpenAI sends them. The
 * first text of an answer records when it arrived, and the screen records the first frame drawn
 * after it shows. Launching with `-svettTiming 1` shows the last time under the chat.
 */
let arrived: number | null = null;
let last: number | null = null;
const listeners = new Set<() => void>();

/** Called for each piece of answer text that arrives while the answer is still empty. */
export const firstWordsArrived = () => {
  arrived ??= performance.now();
};

/** Called once the answer shows text. Waits for the frame that draws it. */
export const firstWordsShown = () => {
  const start = arrived;
  if (start === null) return;
  arrived = null;
  requestAnimationFrame(() => {
    last = performance.now() - start;
    for (const listener of listeners) listener();
  });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Milliseconds from the last answer's first words arriving to the frame that showed them. */
export const firstWordsTiming = (): number | null => last;

export const useFirstWordsTiming = (): number | null =>
  useSyncExternalStore(subscribe, firstWordsTiming, firstWordsTiming);
